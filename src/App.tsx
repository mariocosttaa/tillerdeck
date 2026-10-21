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
import { Services } from "./v2/pages/Services";
import { Promote } from "./v2/pages/Promote";
import { Backups, Machine } from "./v2/pages/Ops";
import { Runs } from "./v2/pages/Runs";
import { Settings, Wizard } from "./v2/pages/Settings";
import Workspace from "./legacy/Workspace";

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
  const [page, setPage] = useState<Page>("servicos");
  const [envId, setEnvId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [makeInfo, setMakeInfo] = useState<Map<string, MakeTarget>>(new Map());
  const [makeVars, setMakeVars] = useState<{ name: string; value: string }[]>([]);
  const [quit, setQuit] = useState<{ running: number; dirty: boolean } | null>(null);
  const [skipWizard, setSkipWizard] = useState(false);
  const [filesOpened, setFilesOpened] = useState(false);
  useEffect(() => {
    if (page === "ficheiros") setFilesOpened(true);
  }, [page]);

  const say = useCallback((text: string, bad?: boolean) => setToast({ text, bad }), []);

  const open = useCallback(async (path: string) => {
    const p = await proj.load(path);
    if (!p) return;
    localStorage.setItem(RECENTS, JSON.stringify([p.root, ...recents().filter((r) => r !== p.root)].slice(0, 8)));
    setPage("servicos");
    setSelected(null);
    setSkipWizard(false);
    setFilesOpened(false);
    setEnvId(localStorage.getItem(`ansible-mario.env.${p.root}`));
  }, [proj.load]);

  async function pick() {
    const dir = await openDialog({ directory: true, title: "Abrir projecto Ansible" });
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
    api.makeTargets(root).then((t) => setMakeInfo(new Map(t.map((x) => [x.name, x]))));
    api.readFile(root, "Makefile")
      .then((text) => setMakeVars([...text.matchAll(/^([A-Z][A-Z0-9_]*)[ \t]*\?=[ \t]*(.*)$/gm)].filter((m) => m[1] !== "CONFIRM").map((m) => ({ name: m[1], value: m[2].trim() }))))
      .catch(() => setMakeVars([]));
  }, [proj.project?.root]);

  const m = proj.state?.manifest ?? null;
  const env = m ? m.environments.find((e) => e.id === envId) ?? m.environments[0] : null;

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
      refresh: proj.refresh,
      selected,
      select: setSelected,
      openPalette: () => setPalette(true),
    };
  }, [proj.project, proj.state, m, env, page, makeInfo, makeVars, runs.runs, runs.history, selected]);

  // ---------------------------------------------------------------- sem projecto
  if (!proj.project) {
    return (
      <div className="flex h-full items-center justify-center p-8" data-tauri-drag-region>
        <div className="panel am-in w-[560px] p-8" style={{ background: "var(--w-panel)" }}>
          <span className="grid size-12 place-items-center rounded-2xl text-[20px] font-bold text-white" style={{ background: "linear-gradient(135deg,#7c6cff,#4a8cff)" }}>A</span>
          <h1 className="mt-5 text-[24px] font-semibold tracking-tight">Ansible Mario</h1>
          <p className="mt-1 text-fg-2">Os teus playbooks como uma app: serviços, promoção, backups e máquina, com o Ansible que já tens.</p>
          <button className="b b-pri mt-6 h-11 w-full justify-center text-[14px]" onClick={pick} disabled={proj.loading}>
            <FolderOpen size={17} />{proj.loading ? "A abrir…" : "Abrir projecto"}<span className="kbd ml-2 !bg-white/15 !text-white/80">{isMac ? "⌘O" : "Ctrl O"}</span>
          </button>
          {proj.error && <p className="mt-3 text-[12.5px] text-danger selectable">{proj.error}</p>}
          {recents().length > 0 && (
            <>
              <p className="sec-h mb-2 mt-7">Recentes</p>
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
        </div>
        {toast && <Toast text={toast.text} bad={toast.bad} onClose={() => setToast(null)} />}
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
          <button className="b b-sm" onClick={() => setSkipWizard(false)}><Wand2 size={14} />Aplicar template</button>
          <button className="b b-sm" onClick={pick}><FolderOpen size={14} />Outro projecto</button>
        </div>
        <div className="min-h-0 flex-1 px-2 pb-2">
          <div className="panel h-full overflow-hidden"><Workspace initial={p} /></div>
        </div>
        {!skipWizard && (
          <Wizard first root={p.root} name={p.name} toast={say} onClose={() => setSkipWizard(true)} onApplied={() => proj.refresh()} />
        )}
        {toast && <Toast text={toast.text} bad={toast.bad} onClose={() => setToast(null)} />}
      </div>
    );
  }

  // --------------------------------------------------------------- a app v2
  const titles: Record<string, string> = { servicos: "Serviços", promover: "Promover", backups: "Backups", maquina: "Máquina", execucoes: "Execuções", definicoes: "Definições", ficheiros: "Ficheiros" };
  const product = page.startsWith("produto:") ? ws.manifest.products.find((p) => `produto:${p.id}` === page) : undefined;
  const focusedRun = focus ? runs.runs[focus] : undefined;

  return (
    <WsProvider value={ws}>
      <Shell title={product ? product.label : titles[page]} onSwitchProject={pick}>
        {page === "servicos" && <Services />}
        {product && <Services productId={product.id} />}
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
      {quit && (
        <Modal onClose={() => setQuit(null)} width={460}>
          <div className="p-6">
            <p className="text-[16px] font-semibold">Sair da app?</p>
            {quit.running > 0 && <p className="mt-2 text-[13px] text-warn">Há {quit.running} corrida{quit.running > 1 ? "s" : ""} a decorrer. Sair agora interrompe o Ansible a meio de uma task.</p>}
            {quit.dirty && <p className="mt-2 text-[13px] text-warn">Há ficheiros com alterações por gravar.</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button className="b b-pri" autoFocus onClick={() => setQuit(null)}>Ficar</button>
              <button className="b b-prod" onClick={() => api.forceQuit()}>{quit.running > 0 ? "Interromper e sair" : "Sair"}</button>
            </div>
          </div>
        </Modal>
      )}
      {toast && <Toast text={toast.text} bad={toast.bad} onClose={() => setToast(null)} />}
    </WsProvider>
  );
}
