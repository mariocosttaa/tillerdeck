import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorText, type FileEntry, type HistoryEntry, type Project, type RunSpec } from "../api";
import Sidebar from "./components/Sidebar";
import Editor, { yamlErrors, type OpenFile } from "./components/Editor";
import RunPanel from "./components/RunPanel";
import MakePanel from "./components/MakePanel";
import Overview from "./components/Overview";
import Console, { type RunView } from "./components/Console";
import ConfirmRun, { type ConfirmRequest } from "./components/ConfirmRun";
import { monaco } from "../monaco";
import { t } from "../v2/i18n";

type View = "overview" | "run" | "make";
type Tab = { type: "view"; view: View } | { type: "file"; path: string };

const MAX_LINES = 50_000;
/** Escuro ou claro, conforme a preferência da app (data-theme) e o sistema. */
function useDark() {
  const read = () => {
    const t = document.documentElement.dataset.theme ?? "auto";
    return t === "dark" || (t === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  };
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const q = window.matchMedia("(prefers-color-scheme: dark)");
    const f = () => setDark(read());
    q.addEventListener("change", f);
    const mo = new MutationObserver(f);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      q.removeEventListener("change", f);
      mo.disconnect();
    };
  }, []);
  return dark;
}

/** A v1 inteira — árvore, editor, vault, execução livre — agora o modo
 *  "Ficheiros (avançado)" da v2. O projecto vem de fora. */
export default function Workspace({ initial }: { initial: Project }) {
  const dark = useDark();
  const [project, setProject] = useState<Project | null>(initial);
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [tab, setTab] = useState<Tab>({ type: "view", view: "overview" });
  const [runs, setRuns] = useState<Record<string, RunView>>({});
  const [consoleId, setConsoleId] = useState<string | null>(null);
  const [consoleH, setConsoleH] = useState(300);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // O último playbook aberto no editor: o separador Executar já o traz escolhido.
  const [lastPlaybook, setLastPlaybook] = useState<string | null>(null);
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [forceSave, setForceSave] = useState<{ path: string; errors: string[] } | null>(null);

  const say = (text: string, bad = false) => {
    setToast({ text, bad });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), bad ? 8000 : 3000);
  };

  // --- corridas: o output chega linha a linha e junta-se de 100 em 100 ms ---
  const pending = useRef<Record<string, string[]>>({});
  const known = useRef(new Set<string>());
  const exited = useRef<Record<string, HistoryEntry>>({});
  useEffect(() => {
    const unOut = listen<{ id: string; line: string }>("run-output", (e) => {
      (pending.current[e.payload.id] ??= []).push(e.payload.line);
    });
    const unExit = listen<HistoryEntry>("run-exit", (e) => {
      flush();
      // Uma corrida que falha logo pode acabar antes de o `runStart` voltar:
      // fica guardada e o `startRun` aplica-a ao registar.
      if (!known.current.has(e.payload.id)) exited.current[e.payload.id] = e.payload;
      setRuns((r) => (r[e.payload.id] ? { ...r, [e.payload.id]: { ...r[e.payload.id], entry: e.payload, running: false } } : r));
      api.runHistory().then(setHistory);
    });
    const flush = () => {
      const batch = pending.current;
      // As linhas de uma corrida que ainda não foi registada ficam à espera:
      // um `make` imprime a primeira em milissegundos.
      const ready = Object.keys(batch).filter((id) => known.current.has(id));
      if (!ready.length) return;
      const take: Record<string, string[]> = {};
      for (const id of ready) {
        take[id] = batch[id];
        delete batch[id];
      }
      setRuns((r) => {
        const next = { ...r };
        for (const [id, lines] of Object.entries(take)) {
          if (!next[id]) continue;
          const all = next[id].lines.concat(lines);
          next[id] = { ...next[id], lines: all.length > MAX_LINES ? all.slice(-MAX_LINES) : all };
        }
        return next;
      });
    };
    const t = window.setInterval(flush, 100);
    api.runHistory().then(setHistory);
    return () => {
      unOut.then((f) => f());
      unExit.then((f) => f());
      window.clearInterval(t);
    };
  }, []);

  const runningIds = useMemo(() => new Set(Object.values(runs).filter((r) => r.running).map((r) => r.entry.id)), [runs]);

  // --- projecto ---
  async function refresh() {
    if (project) setProject(await api.openProject(project.root));
  }

  // --- ficheiros ---
  async function openFile(f: FileEntry) {
    if (!project) return;
    setTab({ type: "file", path: f.path });
    if (files.some((x) => x.path === f.path)) return;
    try {
      setBusy(f.vault ? t("decrypting…") : null);
      const text = f.vault ? await api.vaultView(project.root, f.path) : await api.readFile(project.root, f.path);
      setFiles((fs) => (fs.some((x) => x.path === f.path) ? fs : [...fs, { path: f.path, saved: text, content: text, vault: f.vault }]));
    } catch (e) {
      say(errorText(e), true);
      setTab({ type: "view", view: "overview" });
    } finally {
      setBusy(null);
    }
  }

  const active = tab.type === "file" ? files.find((f) => f.path === tab.path) ?? null : null;
  useEffect(() => {
    if (active && project?.files.some((f) => f.path === active.path && f.kind === "playbook")) setLastPlaybook(active.path);
  }, [active?.path, project]);
  const dirty = useMemo(() => new Set(files.filter((f) => f.content !== f.saved).map((f) => f.path)), [files]);
  useEffect(() => {
    api.setDirty(initial.root, dirty.size > 0).catch(() => {});
  }, [dirty.size]);
  // Ao desmontar (outro projecto), já não há nada por gravar aqui.
  useEffect(() => () => {
    api.setDirty(initial.root, false).catch(() => {});
  }, []);
  const update = (path: string, patch: Partial<OpenFile>) => setFiles((fs) => fs.map((f) => (f.path === path ? { ...f, ...patch } : f)));

  async function save(f: OpenFile, force = false) {
    if (!project) return;
    const errs = yamlErrors(f.path, f.content);
    if (errs.length && !force) {
      setForceSave({ path: f.path, errors: errs });
      return;
    }
    setForceSave(null);
    try {
      if (f.vault) {
        setBusy(t("encrypting…"));
        await api.vaultSave(project.root, f.path, f.content);
      } else {
        await api.writeFile(project.root, f.path, f.content);
      }
      update(f.path, { saved: f.content });
      say(f.vault ? t("{f} encrypted and saved", { f: f.path }) : t("{f} saved", { f: f.path }));
    } catch (e) {
      say(errorText(e), true);
    } finally {
      setBusy(null);
    }
  }

  function closeFile(path: string) {
    if (dirty.has(path) && pendingClose !== path) {
      setPendingClose(path);
      window.setTimeout(() => setPendingClose((p) => (p === path ? null : p)), 3000);
      return;
    }
    setPendingClose(null);
    // O model do Monaco sobrevive ao separador: sem isto, reabrir mostrava o
    // texto antigo, e um vault decifrado ficava em memória.
    const f = files.find((x) => x.path === path);
    monaco.editor.getModel(monaco.Uri.parse(`file:///${f?.vault ? "vault/" : ""}${path}`))?.dispose();
    setFiles((fs) => fs.filter((f) => f.path !== path));
    if (tab.type === "file" && tab.path === path) setTab({ type: "view", view: "overview" });
  }

  async function lint(f: OpenFile) {
    if (!project) return;
    setBusy("ansible-lint…");
    try {
      const issues = await api.lint(project.root, f.path);
      update(f.path, { lint: issues });
      say(issues.length ? t("ansible-lint: {n} problem(s)", { n: issues.length }) : t("ansible-lint: no problems"), issues.length > 0);
    } catch (e) {
      say(errorText(e), true);
    } finally {
      setBusy(null);
    }
  }

  async function syntax(f: OpenFile) {
    if (!project) return;
    setBusy("syntax-check…");
    try {
      const r = await api.syntaxCheck(project.root, f.path);
      say(r.ok ? t("✓ valid syntax") : r.output, !r.ok);
    } catch (e) {
      say(errorText(e), true);
    } finally {
      setBusy(null);
    }
  }

  // --- executar ---
  async function startRun(spec: RunSpec) {
    if (!project) return;
    const unsaved = [...dirty];
    if (unsaved.length) say(t("Careful: unsaved files ({list}) — the run uses what is on disk.", { list: unsaved.join(", ") }), true);
    try {
      const started = await api.runStart(project.root, spec);
      const done = exited.current[started.id];
      delete exited.current[started.id];
      const entry = done ?? started;
      setRuns((r) => ({ ...r, [entry.id]: { entry, lines: [], running: !done } }));
      known.current.add(entry.id);
      setConsoleId(entry.id);
      setHistory((h) => [entry, ...h]);
    } catch (e) {
      say(errorText(e), true);
    }
  }

  async function cancelRun(id: string) {
    try {
      const sig = await api.runCancel(id);
      say(t("{sig} sent", { sig }));
    } catch (e) {
      say(errorText(e), true);
    }
  }

  async function showRun(h: HistoryEntry) {
    if (runs[h.id]) {
      setConsoleId(h.id);
      return;
    }
    try {
      const log = await api.runLog(h.id);
      setRuns((r) => ({ ...r, [h.id]: { entry: h, lines: log.split("\n"), running: false } }));
      known.current.add(h.id);
      setConsoleId(h.id);
    } catch (e) {
      say(errorText(e), true);
    }
  }

  if (!project) return null;

  const consoleRun = consoleId ? runs[consoleId] ?? null : null;
  const activeKind = active ? project.files.find((f) => f.path === active.path)?.kind : null;
  const viewTabs: [View, string][] = [
    ["overview", t("Overview")],
    ["run", t("Run")],
    ["make", "Makefile"],
  ];

  return (
    <div className="legacy app">
      <header className="topbar">
        <b className="px-2">{project.name}</b>
        <button className="mini" onClick={refresh} title={t("Read the tree again")}>↻</button>
        <div className="spacer" />
        {busy && <span className="busy">{busy}</span>}
        {runningIds.size > 0 && (
          <button className="running-pill" onClick={() => setConsoleId([...runningIds][0])}>
            ● {t("{n} running", { n: runningIds.size })}
          </button>
        )}
      </header>
      <div className="body">
        <Sidebar project={project} activePath={active?.path ?? null} dirty={dirty} onOpen={openFile} />
        <main className="main">
          <nav className="tabs">
            {viewTabs.map(([v, label]) => (
              <button key={v} className={`tab view ${tab.type === "view" && tab.view === v ? "on" : ""}`} onClick={() => setTab({ type: "view", view: v })}>
                {label}
              </button>
            ))}
            {files.map((f) => (
              <div key={f.path} className={`tab file ${tab.type === "file" && tab.path === f.path ? "on" : ""}`} title={f.path}>
                <button className="tab-name" onClick={() => setTab({ type: "file", path: f.path })}>
                  {f.vault && "🔒 "}
                  {f.path.split("/").pop()}
                  {dirty.has(f.path) && " ●"}
                </button>
                <button className="tab-x" onClick={() => closeFile(f.path)}>
                  {pendingClose === f.path ? t("discard?") : "×"}
                </button>
              </div>
            ))}
          </nav>

          <div className="content">
            {tab.type === "view" && tab.view === "overview" && (
              <Overview project={project} history={history} runningIds={runningIds} onShowRun={showRun} />
            )}
            {tab.type === "view" && tab.view === "run" && (
              <RunPanel project={project} suggestedPlaybook={lastPlaybook} onRun={startRun} requestConfirm={setConfirm} />
            )}
            {tab.type === "view" && tab.view === "make" && <MakePanel project={project} onRun={startRun} requestConfirm={setConfirm} />}
            {active && (
              <div className="editor-wrap">
                <div className="editor-bar">
                  <span className="mono small">{active.path}</span>
                  {active.vault && <span className="badge lock">{t("decrypted in memory only · saves encrypted")}</span>}
                  <div className="spacer" />
                  {activeKind === "playbook" && (
                    <>
                      <button onClick={() => syntax(active)}>{t("Syntax")}</button>
                      <button onClick={() => setTab({ type: "view", view: "run" })}>{t("Run…")}</button>
                    </>
                  )}
                  {/\.ya?ml$/.test(active.path) && !active.vault && <button onClick={() => lint(active)}>Lint</button>}
                  <button className="primary" disabled={!dirty.has(active.path)} onClick={() => save(active)}>
                    {t("Save")} <kbd>⌘S</kbd>
                  </button>
                </div>
                {forceSave?.path === active.path && (
                  <div className="save-warn">
                    <span title={forceSave.errors.join("\n\n")}>⚠ {t("The YAML has errors:")} {forceSave.errors[0].split("\n")[0]}</span>
                    <button onClick={() => setForceSave(null)}>{t("Fix it")}</button>
                    <button className="danger" onClick={() => save(active, true)}>{t("Save anyway")}</button>
                  </div>
                )}
                <div className="editor-host">
                  <Editor file={active} dark={dark} onChange={(t) => update(active.path, { content: t })} onSave={() => save(active)} />
                </div>
              </div>
            )}
          </div>

          <Console run={consoleRun} onCancel={cancelRun} onClose={() => setConsoleId(null)} height={consoleH} onResize={setConsoleH} />
        </main>
      </div>
      {confirm && <ConfirmRun req={confirm} onClose={() => setConfirm(null)} />}
      {toast && <div className={`toast ${toast.bad ? "bad" : ""}`}>{toast.text}</div>}
    </div>
  );
}
