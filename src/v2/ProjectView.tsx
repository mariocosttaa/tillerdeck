import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Wand2 } from "lucide-react";
import { api, errorText, type HistoryEntry, type MakeTarget, type Project, type RunMeta, type RunSpec } from "../api";
import { useProjectAt, type Run } from "./store";
import { WsProvider, type Page, type Ws } from "./context";
import { Shell } from "./Shell";
import { Confirm, type ConfirmSpec } from "./ui";
import { LogPanel, RunCard } from "./RunViews";
import { Palette } from "./Palette";
import { DeployDialog, type DeployRequest } from "./DeployDialog";
import { Builds } from "./pages/Builds";
import { Notifications } from "./pages/Notifications";
import { Services } from "./pages/Services";
import { Promote } from "./pages/Promote";
import { Backups, Machine } from "./pages/Ops";
import { Runs } from "./pages/Runs";
import { Settings, Wizard } from "./pages/Settings";
import { ProjectMenu, type Switcher } from "./ProjectMenu";
import Workspace from "../legacy/Workspace";
import type { Prefs } from "./prefs";
import { t } from "./i18n";

const isMac = navigator.userAgent.includes("Mac");
const mod = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);
const welcomeKey = (root: string) => `ansible-mario.welcomed.${root}`;

/** As corridas da app, partilhadas por todos os projectos abertos. */
export interface RunStore {
  runs: Record<string, Run>;
  history: HistoryEntry[];
  start: (root: string, spec: RunSpec, meta?: RunMeta) => Promise<HistoryEntry>;
  waitExit: (id: string) => Promise<HistoryEntry>;
  openLog: (h: HistoryEntry) => void;
  setHistory: (h: HistoryEntry[]) => void;
}

/**
 * Um projecto aberto. Ficam todos montados (os de trás escondidos): a página,
 * o servidor escolhido e os ficheiros por gravar sobrevivem à troca. Só o da
 * frente se actualiza sozinho e ouve o teclado.
 */
export function ProjectView({ initial, active, store, prefs, setPrefs, say, sw }: {
  initial: Project;
  active: boolean;
  store: RunStore;
  prefs: Prefs;
  setPrefs: (p: Prefs) => void;
  say: (text: string, bad?: boolean) => void;
  sw: Switcher;
}) {
  const proj = useProjectAt(initial);
  const root = initial.root;
  const [page, setPage] = useState<Page>("servicos");
  const [envId, setEnvId] = useState<string | null>(() => localStorage.getItem(`ansible-mario.env.${root}`));
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [deploy, setDeploy] = useState<DeployRequest | null>(null);
  const [makeInfo, setMakeInfo] = useState<Map<string, MakeTarget>>(new Map());
  const [makeVars, setMakeVars] = useState<{ name: string; value: string }[]>([]);
  const [maint, setMaint] = useState<Record<string, Record<string, boolean>>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState(Date.now());
  const [skipWizard, setSkipWizard] = useState(false);
  // Boas-vindas a um projecto sem ansible-mario.json: uma vez por projecto.
  const [welcomed, setWelcomed] = useState(() => {
    try {
      return !!localStorage.getItem(welcomeKey(root));
    } catch {
      return false;
    }
  });
  const markWelcomed = () => {
    try { localStorage.setItem(welcomeKey(root), "1"); } catch { /* sem armazenamento */ }
    setWelcomed(true);
  };
  const [filesOpened, setFilesOpened] = useState(false);
  useEffect(() => {
    if (page === "ficheiros") setFilesOpened(true);
  }, [page]);

  // ⌘K só no projecto da frente
  useEffect(() => {
    if (!active) return;
    const k = (e: KeyboardEvent) => {
      if (mod(e) && e.key === "k") { e.preventDefault(); setPalette((x) => !x); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [active]);

  // Os alvos do Makefile (receita, trava) e as variáveis `VAR ?=`.
  useEffect(() => {
    api.makeTargets(root).then((x) => setMakeInfo(new Map(x.map((y) => [y.name, y]))));
    api.readFile(root, "Makefile")
      .then((text) => setMakeVars([...text.matchAll(/^([A-Z][A-Z0-9_]*)[ \t]*\?=[ \t]*(.*)$/gm)].filter((x) => x[1] !== "CONFIRM").map((x) => ({ name: x[1], value: x[2].trim() }))))
      .catch(() => setMakeVars([]));
  }, [root]);

  const m = proj.state?.manifest ?? null;
  const env = m ? m.environments.find((e) => e.id === envId) ?? m.environments[0] : null;

  // O estado de manutenção de cada inventário em uso (servidores e placements).
  const inventories = useMemo(
    () => (m ? [...new Set([...m.environments.map((e) => e.inventory), ...m.products.flatMap((p) => Object.values(p.placements ?? {}).map((x) => x.inventory))])] : []),
    [m],
  );
  const loadMaint = useCallback(async () => {
    const out: Record<string, Record<string, boolean>> = {};
    await Promise.all(inventories.map((inv) => api.maintenanceState(root, inv).then((x) => (out[inv] = x)).catch(() => {})));
    setMaint(out);
  }, [root, inventories.join("|")]);
  useEffect(() => {
    loadMaint();
  }, [loadMaint]);

  // os nomes da configuração detectada vêm na língua escolhida
  useEffect(() => {
    if (proj.state?.auto) proj.refresh();
  }, [prefs.lang]);

  /** Actualizar: só leituras locais — releases, histórico, inventário. Nunca SSH. */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([proj.refresh(), loadMaint(), api.runHistory().then(store.setHistory)]);
      setRefreshedAt(Date.now());
    } catch (e) {
      say(errorText(e), true);
    } finally {
      setRefreshing(false);
    }
  }, [proj.refresh, loadMaint]);

  // Só o projecto da frente se actualiza sozinho; ao voltar a ele, relê se já passou um bocado.
  useEffect(() => {
    if (!active) return;
    if (Date.now() - refreshedAt > 30_000) refresh();
    if (!prefs.refreshMin) return;
    const id = window.setInterval(refresh, prefs.refreshMin * 60_000);
    const onFocus = () => Date.now() - refreshedAt > 30_000 && refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [active, prefs.refreshMin, refresh, refreshedAt]);

  // Depois de uma corrida DESTE projecto acabar, o estado (releases, manutenção) relê-se.
  useEffect(() => {
    const un = listen<HistoryEntry>("run-exit", (e) => {
      if (e.payload.root === root) window.setTimeout(() => refresh(), 400);
    });
    return () => {
      un.then((f) => f());
    };
  }, [refresh, root]);

  // as corridas deste projecto
  const runs = useMemo(() => Object.fromEntries(Object.entries(store.runs).filter(([, r]) => r.entry.root === root)), [store.runs, root]);

  const ws: Ws | null = useMemo(() => {
    if (!proj.state || !m || !env) return null;
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
      runs,
      history: store.history,
      focusRun: (id: string | null) => {
        if (id && !store.runs[id]) {
          const h = store.history.find((x) => x.id === id);
          if (h) store.openLog(h);
        }
        setFocus(id);
        setLogOpen(!!id);
      },
      start: async (spec: RunSpec, meta: RunMeta) => {
        try {
          const e = await store.start(root, spec, meta);
          setFocus(e.id);
          return e;
        } catch (err) {
          say(errorText(err), true);
          return null;
        }
      },
      waitExit: store.waitExit,
      openLog: store.openLog,
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
  }, [proj.project, proj.state, m, env, page, makeInfo, makeVars, runs, store.runs, store.history, selected, prefs, maint, refreshing, refreshedAt, refresh]);

  const hide = active ? "h-full" : "hidden";

  // ----------------------------------------------------------- a carregar
  if (!proj.state) {
    return (
      <div className={`${hide} flex items-center justify-center text-fg-3`} data-tauri-drag-region>
        {proj.error ? <span className="selectable text-danger">{proj.error}</span> : t("Opening…")}
      </div>
    );
  }

  // ---------------------------------------------------- projecto sem manifesto válido
  if (!ws) {
    const p = proj.project;
    return (
      <div className={`${hide} flex flex-col`}>
        <div className="flex h-[52px] shrink-0 items-center gap-3 pl-[88px] pr-4" data-tauri-drag-region>
          <ProjectMenu sw={sw} className="flex items-center gap-2 rounded-lg px-2 py-1 font-semibold hover:bg-hover">{p.name} <span className="text-fg-3">▾</span></ProjectMenu>
          {proj.state.manifestError && <span className="min-w-0 truncate text-[12px] text-danger">{proj.state.manifestError}</span>}
          <span className="ml-auto" />
          <button className="b b-sm" onClick={() => setSkipWizard(false)}><Wand2 size={14} />{t("Detect again")}</button>
        </div>
        <div className="min-h-0 flex-1 px-2 pb-2">
          <div className="panel h-full overflow-hidden"><Workspace initial={p} /></div>
        </div>
        {active && !skipWizard && <Wizard first root={p.root} name={p.name} toast={say} onClose={() => setSkipWizard(true)} onApplied={() => proj.refresh()} />}
      </div>
    );
  }

  // --------------------------------------------------------------- a app v2
  const titles: Record<string, string> = { servicos: t("Services"), builds: t("Builds"), notificacoes: t("Notifications"), promover: t("Promote"), backups: t("Backups"), maquina: t("Machine"), execucoes: t("Runs"), definicoes: t("Settings"), ficheiros: t("Files") };
  const product = page.startsWith("produto:") ? ws.manifest.products.find((p) => `produto:${p.id}` === page) : undefined;
  const focusedRun = focus ? store.runs[focus] : undefined;

  return (
    <div className={hide}>
      <WsProvider value={ws}>
        <Shell title={product ? product.label : titles[page]} sw={sw}>
          {page === "servicos" && <Services />}
          {product && <Services productId={product.id} />}
          {page === "builds" && <Builds />}
          {page === "notificacoes" && <Notifications />}
          {page === "promover" && <Promote />}
          {page === "backups" && <Backups />}
          {page === "maquina" && <Machine />}
          {page === "execucoes" && <Runs />}
          {page === "definicoes" && <Settings />}
          {/* Fica montado depois da primeira visita: sair dos Ficheiros (ou
              mudar de projecto) não deita fora as alterações por gravar. */}
          {filesOpened && (
            <div className={page === "ficheiros" ? "relative min-w-0 flex-1" : "hidden"}>
              <Workspace key={ws.project.root} initial={ws.project} />
            </div>
          )}
          {focusedRun && !logOpen && <RunCard run={focusedRun} onLog={() => setLogOpen(true)} onClose={() => setFocus(null)} />}
          {focusedRun && logOpen && <LogPanel run={focusedRun} onClose={() => setLogOpen(false)} />}
        </Shell>
        {active && confirm && <Confirm spec={confirm} onClose={() => setConfirm(null)} />}
        {active && palette && <Palette onClose={() => setPalette(false)} />}
        {active && ws.state.auto && !welcomed && (
          <Wizard
            first
            autoTemplate={ws.state.auto.template}
            root={root}
            name={ws.project.name}
            toast={say}
            onClose={markWelcomed}
            onApplied={() => {
              markWelcomed();
              proj.refresh();
            }}
          />
        )}
        {active && deploy && <DeployDialog key={`${deploy.p.id}.${deploy.s.id}.${deploy.action}.${deploy.preset ?? ""}`} req={deploy} onClose={() => setDeploy(null)} />}
      </WsProvider>
    </div>
  );
}
