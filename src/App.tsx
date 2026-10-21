import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { ArrowRight, FolderOpen } from "lucide-react";
import { api, errorText, type Project } from "./api";
import { useRuns } from "./v2/store";
import { Modal, Toast } from "./v2/ui";
import { ProjectView } from "./v2/ProjectView";
import { Wordmark } from "./v2/Logo";
import type { Switcher } from "./v2/ProjectMenu";
import { applyTheme, loadPrefs, savePrefs, type Prefs } from "./v2/prefs";
import { setLang, t } from "./v2/i18n";

const RECENTS = "tillerdeck.recents";
/** Os projectos abertos e o da frente, para os voltar a abrir no arranque. */
const OPEN = "tillerdeck.open";
const read = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sem armazenamento */
  }
};
const recents = (): string[] => read<string[]>(RECENTS, []);
const isMac = navigator.userAgent.includes("Mac");
const mod = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

export default function App() {
  const store = useRuns();
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [quit, setQuit] = useState<{ running: number; dirty: boolean } | null>(null);
  // Vários projectos abertos ao mesmo tempo; um à frente.
  const [open, setOpen] = useState<Project[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<{ root: string; running: number; dirty: boolean } | null>(null);

  const say = useCallback((text: string, bad?: boolean) => setToast({ text, bad }), []);
  const setPrefs = useCallback((p: Prefs) => {
    savePrefs(p);
    applyTheme(p.theme);
    setLang(p.lang);
    setPrefsState(p);
  }, []);

  useEffect(() => {
    if (open.length) write(OPEN, { roots: open.map((p) => p.root), active });
  }, [open, active]);

  const openPath = useCallback(async (path: string, front = true) => {
    setLoading(true);
    setError(null);
    try {
      const p = await api.openProject(path);
      write(RECENTS, [p.root, ...recents().filter((r) => r !== p.root)].slice(0, 8));
      setOpen((list) => (list.some((x) => x.root === p.root) ? list : [...list, p]));
      if (front) setActive(p.root);
      return p;
    } catch (e) {
      setError(errorText(e));
      say(errorText(e), true);
      return null;
    } finally {
      setLoading(false);
    }
  }, [say]);

  const pick = useCallback(async () => {
    const dir = await openDialog({ directory: true, title: t("Open an Ansible project") });
    if (typeof dir === "string") openPath(dir);
  }, [openPath]);

  const runningIn = useCallback((root: string) => Object.values(store.runs).filter((r) => r.running && r.entry.root === root).length, [store.runs]);

  const doClose = useCallback((root: string) => {
    setOpen((list) => {
      const i = list.findIndex((p) => p.root === root);
      const next = list.filter((p) => p.root !== root);
      setActive((a) => (a === root ? next[Math.min(i, next.length - 1)]?.root ?? null : a));
      if (!next.length) write(OPEN, { roots: [], active: null });
      return next;
    });
  }, []);

  // Fechar um projecto com corridas ou ficheiros por gravar pergunta primeiro.
  // As corridas continuam (são do backend) e ficam nas Execuções.
  const close = useCallback(async (root: string) => {
    const running = runningIn(root);
    const dirty = (await api.dirtyRoots().catch(() => [] as string[])).includes(root);
    if (running || dirty) setClosing({ root, running, dirty });
    else doClose(root);
  }, [runningIn, doClose]);

  // No arranque: os que estavam abertos, mais o da linha de comandos.
  useEffect(() => {
    (async () => {
      const saved = read<{ roots: string[]; active: string | null }>(OPEN, { roots: [], active: null });
      const cli = await api.initialProject().catch(() => null);
      for (const r of saved.roots) await openPath(r, false);
      if (cli) await openPath(cli);
      else if (saved.active) setActive(saved.active);
      setActive((a) => a ?? saved.roots[0] ?? null);
      setError(null);
    })();
    const un = listen<{ running: number; dirty: boolean }>("quit-blocked", (e) => setQuit(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // um projecto que já não existe sai da lista
  useEffect(() => {
    if (active && open.length && !open.some((p) => p.root === active)) setActive(open[0].root);
  }, [open, active]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (mod(e) && e.key === "o") { e.preventDefault(); pick(); }
      // ⌘1…⌘9: o n-ésimo projecto aberto
      if (mod(e) && /^[1-9]$/.test(e.key)) {
        const p = open[Number(e.key) - 1];
        if (p) { e.preventDefault(); setActive(p.root); }
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [pick, open]);

  const sw: Switcher = useMemo(() => ({
    open: open.map((p) => ({ root: p.root, name: p.name, running: runningIn(p.root) })),
    active: active ?? "",
    recents: recents(),
    switchTo: setActive,
    close,
    openPath: (path?: string) => (path ? openPath(path) : pick()),
  }), [open, active, runningIn, close, openPath, pick]);

  // O aviso ao sair existe em todos os ecrãs: o Rust bloqueia o ⌘Q sempre
  // que há corridas ou ficheiros por gravar, esteja onde estiver.
  const quitModal = quit && (
    <Modal onClose={() => setQuit(null)} width={460}>
      <div className="p-6">
        <p className="text-[16px] font-semibold">{t("Quit the app?")}</p>
        {quit.running > 0 && <p className="mt-2 text-[13px] text-warn">{t("{n} run(s) in progress. Quitting now stops Ansible in the middle of a task.", { n: quit.running })}</p>}
        {quit.dirty && <p className="mt-2 text-[13px] text-warn">{t("There are files with unsaved changes.")}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button className="b b-pri" autoFocus onClick={() => setQuit(null)}>{t("Stay")}</button>
          <button className="b b-prod" onClick={() => api.forceQuit()}>{quit.running > 0 ? t("Stop and quit") : t("Quit")}</button>
        </div>
      </div>
    </Modal>
  );
  const toastEl = toast && <Toast text={toast.text} bad={toast.bad} onClose={() => setToast(null)} />;
  const closingName = closing && open.find((p) => p.root === closing.root)?.name;
  const closeModal = closing && (
    <Modal onClose={() => setClosing(null)} width={460}>
      <div className="p-6">
        <p className="text-[16px] font-semibold">{t("Close {name}?", { name: closingName ?? "" })}</p>
        {closing.running > 0 && <p className="mt-2 text-[13px] text-fg-2">{t("{n} run(s) in progress. They keep running, and stay in Runs when you open the project again.", { n: closing.running })}</p>}
        {closing.dirty && <p className="mt-2 text-[13px] text-warn">{t("There are files with unsaved changes.")}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button className="b b-pri" autoFocus onClick={() => setClosing(null)}>{t("Cancel")}</button>
          <button className="b" onClick={() => { doClose(closing.root); setClosing(null); }}>{closing.dirty ? t("Close without saving") : t("Close")}</button>
        </div>
      </div>
    </Modal>
  );

  // ---------------------------------------------------------------- sem projecto
  if (!open.length) {
    return (
      <div className="flex h-full items-center justify-center p-8" data-tauri-drag-region>
        <div className="panel am-in w-[560px] p-8" style={{ background: "var(--w-panel)" }}>
          <h1 className="text-[28px]"><Wordmark size={30} /></h1>
          <p className="mt-3 text-fg-2">{t("Steer your infra by hand: services, promotion, backups and machines, with the Ansible you already have.")}</p>
          <button className="b b-pri mt-6 h-11 w-full justify-center text-[14px]" onClick={pick} disabled={loading}>
            <FolderOpen size={17} />{loading ? t("Opening…") : t("Open project")}<span className="kbd ml-2 !bg-white/15 !text-white/80">{isMac ? "⌘O" : "Ctrl O"}</span>
          </button>
          {error && <p className="mt-3 text-[12.5px] text-danger selectable">{error}</p>}
          {recents().length > 0 && (
            <>
              <p className="sec-h mb-2 mt-7">{t("Recent")}</p>
              <div className="space-y-1">
                {recents().map((r) => (
                  <button key={r} className="row flex w-full items-center gap-3 px-3 py-2 text-left" onClick={() => openPath(r)}>
                    <span className="grid size-8 place-items-center rounded-lg bg-raise-2 text-[13px] font-semibold">{r.split("/").pop()?.slice(0, 1).toUpperCase()}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{r.split("/").pop()}</span><span className="block truncate text-[12px] text-fg-3">{r}</span></span>
                    <ArrowRight size={15} className="text-fg-3" />
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="mt-6 flex justify-end gap-2 text-[12px]">
            {(["en", "pt"] as const).map((l) => (
              <button key={l} className={`rounded-md px-2 py-1 ${prefs.lang === l ? "bg-raise-2 text-fg" : "text-fg-3"}`} onClick={() => setPrefs({ ...prefs, lang: l })}>{l === "en" ? "English" : "Português"}</button>
            ))}
          </div>
        </div>
        {quitModal}
        {toastEl}
      </div>
    );
  }

  return (
    <>
      {open.map((p) => (
        <ProjectView key={p.root} initial={p} active={p.root === active} store={store} prefs={prefs} setPrefs={setPrefs} say={say} sw={sw} />
      ))}
      {closeModal}
      {quitModal}
      {toastEl}
    </>
  );
}
