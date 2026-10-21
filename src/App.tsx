import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { ArrowRight, FolderOpen, Wand2 } from "lucide-react";
import { api, errorText, type MakeTarget, type RunMeta, type RunSpec } from "./api";
import { useProject, useRuns } from "./v2/store";
import { WsProvider, type Page, type Ws } from "./v2/context";
import { Shell } from "./v2/Shell";
import { Confirm, Modal, Toast, type ConfirmSpec } from "./v2/ui";
import { LogPanel, RunCard } from "./v2/RunViews";
import { Palette } from "./v2/Palette";
import { DeployDialog, type DeployRequest } from "./v2/DeployDialog";
import { Builds } from "./v2/pages/Builds";
import { Services } from "./v2/pages/Services";
import { Promote } from "./v2/pages/Promote";
import { Backups, Machine } from "./v2/pages/Ops";
import { Runs } from "./v2/pages/Runs";
import { Settings, Wizard } from "./v2/pages/Settings";
import Workspace from "./legacy/Workspace";
import { applyTheme, loadPrefs, savePrefs, type Prefs } from "./v2/prefs";
import { setLang, t } from "./v2/i18n";

const RECENTS = "ansible-mario.recents";
const recents = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENTS) ?? "[]");
  } catch {
    return [];
  }
};
const isMac = navigator.userAgent.includes("Mac");
const mod = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

export default function App() {
  const proj = useProject();
  const runs = useRuns();
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [page, setPage] = useState<Page>("servicos");
  const [envId, setEnvId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [deploy, setDeploy] = useState<DeployRequest | null>(null);
  const [makeInfo, setMakeInfo] = useState<Map<string, MakeTarget>>(new Map());
  const [makeVars, setMakeVars] = useState<{ name: string; value: string }[]>([]);
  const [maint, setMaint] = useState<Record<string, Record<string, boolean>>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState(Date.now());
  const [quit, setQuit] = useState<{ running: number; dirty: boolean } | null>(null);
  const [skipWizard, setSkipWizard] = useState(false);
  const [filesOpened, setFilesOpened] = useState(false);
  useEffect(() => {
    if (page === "ficheiros") setFilesOpened(true);
  }, [page]);

  const say = useCallback((text: string, bad?: boolean) => setToast({ text, bad }), []);
  const setPrefs = useCallback((p: Prefs) => {
    savePrefs(p);
    applyTheme(p.theme);
    setLang(p.lang);
    setPrefsState(p);
  }, []);

  const open = useCallback(async (path: string) => {
    const p = await proj.load(path);
    if (!p) return;
    localStorage.setItem(RECENTS, JSON.stringify([p.root, ...recents().filter((r) => r !== p.root)].slice(0, 8)));
    setPage("servicos");
    setSelected(null);
    setSkipWizard(false);
    setFilesOpened(false);
    setMaint({});
    setEnvId(localStorage.getItem(`ansible-mario.env.${p.root}`));
  }, [proj.load]);

  async function pick() {
    const dir = await openDialog({ directory: true, title: t("Open an Ansible project") });
    if (typeof dir === "string") open(dir);
  }

  useEffect(() => {
    api.initialProject().then((p) => {
      if (p) open(p);
    });
    const un = listen<{ running: number; dirty: boolean }>("quit-blocked", (e) => setQuit(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (mod(e) && e.key === "o") { e.preventDefault(); pick(); }
      if (mod(e) && e.key === "k") { e.preventDefault(); setPalette((x) => !x); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  // Os alvos do Makefile (receita, trava) e as variáveis `VAR ?=`.
  useEffect(() => {
    if (!proj.project) return;
    const root = proj.project.root;
    api.makeTargets(root).then((x) => setMakeInfo(new Map(x.map((y) => [y.name, y]))));
    api.readFile(root, "Makefile")
      .then((text) => setMakeVars([...text.matchAll(/^([A-Z][A-Z0-9_]*)[ \t]*\?=[ \t]*(.*)$/gm)].filter((x) => x[1] !== "CONFIRM").map((x) => ({ name: x[1], value: x[2].trim() }))))
      .catch(() => setMakeVars([]));
  }, [proj.project?.root]);

  const m = proj.state?.manifest ?? null;
  const env = m ? m.environments.find((e) => e.id === envId) ?? m.environments[0] : null;

  // O estado de manutenção de cada inventário em uso (servidores e placements).
  const inventories = useMemo(
    () => (m ? [...new Set([...m.environments.map((e) => e.inventory), ...m.products.flatMap((p) => Object.values(p.placements ?? {}).map((x) => x.inventory))])] : []),
    [m],
  );
  const loadMaint = useCallback(async () => {
    if (!proj.project) return;
    const root = proj.project.root;
    const out: Record<string, Record<string, boolean>> = {};
    await Promise.all(inventories.map((inv) => api.maintenanceState(root, inv).then((x) => (out[inv] = x)).catch(() => {})));
    setMaint(out);
  }, [proj.project?.root, inventories.join("|")]);
  useEffect(() => {
    loadMaint();
  }, [loadMaint]);

  /** Actualizar: só leituras locais — releases, histórico, inventário. Nunca SSH. */
  const refresh = useCallback(async () => {
    if (!proj.project) return;
    setRefreshing(true);
    try {
      await Promise.all([proj.refresh(), loadMaint(), api.runHistory().then(runs.setHistory)]);
      setRefreshedAt(Date.now());
    } catch (e) {
      say(errorText(e), true);
    } finally {
      setRefreshing(false);
    }
  }, [proj.refresh, loadMaint]);

  useEffect(() => {
    if (!proj.project || !prefs.refreshMin) return;
    const id = window.setInterval(refresh, prefs.refreshMin * 60_000);
    const onFocus = () => Date.now() - refreshedAt > 30_000 && refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [proj.project?.root, prefs.refreshMin, refresh, refreshedAt]);

  const ws: Ws | null = useMemo(() => {
    if (!proj.project || !proj.state || !m || !env) return null;
    const root = proj.project.root;
    return {
      project: proj.project,
      state: proj.state,
      manifest: m,
      env,
      setEnv: (id: string) => {
        setEnvId(id);
        localStorage.setItem(`ansible-mario.env.${root}`, id);
      },
      page,
      go: setPage,
      targets: new Set(proj.state.targets),
      makeInfo,
      makeVars,
      runs: runs.runs,
      history: runs.history,
      focusRun: (id: string | null) => {
        if (id && !runs.runs[id]) {
          const h = runs.history.find((x) => x.id === id);
          if (h) runs.openLog(h);
        }
        setFocus(id);
        setLogOpen(!!id);
      },
      start: async (spec: RunSpec, meta: RunMeta) => {
        try {
          const e = await runs.start(root, spec, meta);
          setFocus(e.id);
          return e;
        } catch (err) {
          say(errorText(err), true);
          return null;
        }
      },
      waitExit: runs.waitExit,
      openLog: runs.openLog,
      confirm: setConfirm,
      toast: say,
      refresh,
      refreshing,
      refreshedAt,
      selected,
      select: setSelected,
      openPalette: () => setPalette(true),
      prefs,
      setPrefs,
      maint,
      openDeploy: setDeploy,
    };
  }, [proj.project, proj.state, m, env, page, makeInfo, makeVars, runs.runs, runs.history, selected, prefs, maint, refreshing, refreshedAt, refresh]);

  // Depois de uma corrida acabar, o estado (releases, manutenção) relê-se.
  useEffect(() => {
    const un = listen("run-exit", () => window.setTimeout(() => refresh(), 400));
    return () => {
      un.then((f) => f());
    };
  }, [refresh]);

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

  // ---------------------------------------------------------------- sem projecto
  if (!proj.project) {
    return (
      <div className="flex h-full items-center justify-center p-8" data-tauri-drag-region>
        <div className="panel am-in w-[560px] p-8" style={{ background: "var(--w-panel)" }}>
          <span className="grid size-12 place-items-center rounded-2xl text-[20px] font-bold text-white" style={{ background: "linear-gradient(135deg,#7c6cff,#4a8cff)" }}>A</span>
          <h1 className="mt-5 text-[24px] font-semibold tracking-tight">Ansible Mario</h1>
          <p className="mt-1 text-fg-2">{t("Your playbooks as an app: services, promotion, backups and machines, with the Ansible you already have.")}</p>
          <button className="b b-pri mt-6 h-11 w-full justify-center text-[14px]" onClick={pick} disabled={proj.loading}>
            <FolderOpen size={17} />{proj.loading ? t("Opening…") : t("Open project")}<span className="kbd ml-2 !bg-white/15 !text-white/80">{isMac ? "⌘O" : "Ctrl O"}</span>
          </button>
          {proj.error && <p className="mt-3 text-[12.5px] text-danger selectable">{proj.error}</p>}
          {recents().length > 0 && (
            <>
              <p className="sec-h mb-2 mt-7">{t("Recent")}</p>
              <div className="space-y-1">
                {recents().map((r) => (
                  <button key={r} className="row flex w-full items-center gap-3 px-3 py-2 text-left" onClick={() => open(r)}>
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

  // ---------------------------------------------------- projecto sem manifesto
  if (!ws) {
    const p = proj.project;
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-[52px] shrink-0 items-center gap-3 pl-[88px] pr-4" data-tauri-drag-region>
          <span className="font-semibold">{p.name}</span>
          {proj.state?.manifestError && <span className="text-[12px] text-danger">{proj.state.manifestError}</span>}
          <span className="ml-auto" />
          <button className="b b-sm" onClick={() => setSkipWizard(false)}><Wand2 size={14} />{t("Apply template")}</button>
          <button className="b b-sm" onClick={pick}><FolderOpen size={14} />{t("Another project")}</button>
        </div>
        <div className="min-h-0 flex-1 px-2 pb-2">
          <div className="panel h-full overflow-hidden"><Workspace initial={p} /></div>
        </div>
        {!skipWizard && <Wizard first root={p.root} name={p.name} toast={say} onClose={() => setSkipWizard(true)} onApplied={() => proj.refresh()} />}
        {quitModal}
        {toastEl}
      </div>
    );
  }

  // --------------------------------------------------------------- a app v2
  const titles: Record<string, string> = { servicos: t("Services"), builds: t("Builds"), promover: t("Promote"), backups: t("Backups"), maquina: t("Machine"), execucoes: t("Runs"), definicoes: t("Settings"), ficheiros: t("Files") };
  const product = page.startsWith("produto:") ? ws.manifest.products.find((p) => `produto:${p.id}` === page) : undefined;
  const focusedRun = focus ? runs.runs[focus] : undefined;

  return (
    <WsProvider value={ws}>
      <Shell title={product ? product.label : titles[page]} onSwitchProject={pick}>
        {page === "servicos" && <Services />}
        {product && <Services productId={product.id} />}
        {page === "builds" && <Builds />}
        {page === "promover" && <Promote />}
        {page === "backups" && <Backups />}
        {page === "maquina" && <Machine />}
        {page === "execucoes" && <Runs />}
        {page === "definicoes" && <Settings />}
        {/* Fica montado depois da primeira visita: sair dos Ficheiros não
            pode deitar fora os separadores nem as alterações por gravar. */}
        {filesOpened && (
          <div className={page === "ficheiros" ? "relative min-w-0 flex-1" : "hidden"}>
            <Workspace key={ws.project.root} initial={ws.project} />
          </div>
        )}
        {focusedRun && !logOpen && <RunCard run={focusedRun} onLog={() => setLogOpen(true)} onClose={() => setFocus(null)} />}
        {focusedRun && logOpen && <LogPanel run={focusedRun} onClose={() => setLogOpen(false)} />}
      </Shell>
      {confirm && <Confirm spec={confirm} onClose={() => setConfirm(null)} />}
      {palette && <Palette onClose={() => setPalette(false)} />}
      {deploy && <DeployDialog key={`${deploy.p.id}.${deploy.s.id}.${deploy.action}.${deploy.preset ?? ""}`} req={deploy} onClose={() => setDeploy(null)} />}
      {quitModal}
      {toastEl}
    </WsProvider>
  );
}
