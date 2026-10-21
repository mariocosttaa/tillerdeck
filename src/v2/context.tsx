import { createContext, useContext, type ReactNode } from "react";
import { Construction, Database, DoorOpen, MessageSquare, Rocket, ShieldAlert, Sprout } from "lucide-react";
import type { EnvDef, HistoryEntry, MakeTarget, Manifest, Operation, Product, Project, ProjectState, RunMeta, RunSpec, Service } from "../api";
import type { Run } from "./store";
import { actionFor, lastRun, looksDestructive, makeTarget, opOn, serviceKey, shortVersion, targetExists, versionOf, where, type Where } from "./lib";
import { TechIcon, type ConfirmSpec } from "./ui";
import { t } from "./i18n";
import type { Prefs } from "./prefs";
import type { DeployRequest } from "./DeployDialog";

export type Page = "servicos" | "builds" | "promover" | "backups" | "maquina" | "execucoes" | "definicoes" | "ficheiros" | `produto:${string}`;

export interface Ws {
  project: Project;
  state: ProjectState;
  manifest: Manifest;
  /** o servidor escolhido em cima */
  env: EnvDef;
  setEnv: (id: string) => void;
  page: Page;
  go: (p: Page) => void;
  targets: Set<string>;
  makeInfo: Map<string, MakeTarget>;
  makeVars: { name: string; value: string }[];
  runs: Record<string, Run>;
  history: HistoryEntry[];
  focusRun: (id: string | null) => void;
  start: (spec: RunSpec, meta: RunMeta) => Promise<HistoryEntry | null>;
  waitExit: (id: string) => Promise<HistoryEntry>;
  openLog: (h: HistoryEntry) => void;
  confirm: (c: ConfirmSpec) => void;
  toast: (text: string, bad?: boolean) => void;
  refresh: () => Promise<void>;
  refreshing: boolean;
  refreshedAt: number;
  selected: string | null;
  select: (key: string | null) => void;
  openPalette: () => void;
  prefs: Prefs;
  setPrefs: (p: Prefs) => void;
  /** abre o deploy: escolher o modo (com migrações, seed) e a versão */
  openDeploy: (r: DeployRequest) => void;
  /** estado de manutenção do inventário, por ficheiro de inventário */
  maint: Record<string, Record<string, boolean>>;
}

const Ctx = createContext<Ws | null>(null);
export const WsProvider = ({ value, children }: { value: Ws; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export function useWs(): Ws {
  const v = useContext(Ctx);
  if (!v) throw new Error("outside the workspace");
  return v;
}

export function actionMeta(a: string): { label: string; verb: string; icon: ReactNode; sub: string } {
  switch (a) {
    case "deploy": return { label: t("Deploy"), verb: t("Deploy"), icon: <Rocket size={16} />, sub: t("installs the release version") };
    case "migrate": return { label: t("Migrate the database"), verb: t("Migrate"), icon: <Database size={16} />, sub: t("migrations only") };
    case "seed": return { label: t("Migrate and seed"), verb: t("Seed"), icon: <Sprout size={16} />, sub: t("migrates, then seeds") };
    case "maintenanceOn": return { label: t("Close to the public"), verb: t("Close"), icon: <Construction size={16} />, sub: t("maintenance mode on") };
    case "maintenanceOff": return { label: t("Reopen"), verb: t("Reopen"), icon: <DoorOpen size={16} />, sub: t("maintenance mode off") };
    default: return { label: a, verb: a, icon: <Rocket size={16} />, sub: "" };
  }
}

/** As variáveis `VAR ?=` que uma receita usa. */
export function varsFor(ws: Ws, target: string) {
  const info = ws.makeInfo.get(target);
  if (!info) return [];
  const text = info.recipe.join("\n");
  return ws.makeVars.filter((v) => v.name !== "ARGS" && (text.includes(`$(${v.name})`) || text.includes(`\${${v.name}}`)));
}

export function callbackFacts(ws: Ws) {
  const notify = ws.state.callbacks.filter((c) => !["profile_tasks", "timer", "default", "yaml"].includes(c));
  return notify.length ? [{ icon: <MessageSquare size={16} />, text: t("When it ends, the {cb} callback runs", { cb: notify.join(", ") }) }] : [];
}

export function specFor(ws: Ws, w: Where, target: string | null, playbook: string | undefined, extra: [string, string][] = []): RunSpec {
  if (target) {
    const [name, ...inline] = target.split(/\s+/);
    const vars: [string, string][] = inline.map((kv) => kv.split("=") as [string, string]);
    vars.push(...extra);
    // A trava interactiva do Makefile (um `read`) não tem terminal aqui:
    // a app já pediu a palavra, passa CONFIRM=yes.
    if (ws.makeInfo.get(name)?.usesConfirm) vars.push(["CONFIRM", "yes"]);
    return { kind: "make", target: name, vars };
  }
  return {
    kind: "playbook",
    playbook: playbook!,
    inventory: w.inventory,
    extraVarFiles: w.release ? [w.release] : [],
    limit: "",
    tags: "",
    skipTags: "",
    check: false,
    diff: false,
    verbosity: 0,
    extraArgs: "",
  };
}

export function canRun(ws: Ws, p: Product, s: Service, action: string, server: EnvDef = ws.env): boolean {
  const a = s.actions[action];
  const w = where(p, server);
  return actionFor(a, w.token) && targetExists(a, w.token, ws.targets);
}

/** A palavra a escrever: o alvo (`production`, `testes`) — o que o Makefile também pede. */
const wordFor = (w: Where, destructive = false) => (w.server.protected || destructive ? w.token : undefined);

/** Pede confirmação e corre uma acção de um serviço no servidor actual. */
export function runServiceAction(ws: Ws, p: Product, s: Service, action: string) {
  const a = s.actions[action];
  if (!a) return;
  // deploy, migrar e semear abrem o diálogo do deploy (modo + versão)
  if (["deploy", "migrate", "seed"].includes(action)) return ws.openDeploy({ p, s, action });
  const w = where(p, ws.env);
  const target = makeTarget(a, w.token);
  const meta = actionMeta(action);
  const version = versionOf(ws.state.releases, w, s);
  const key = serviceKey(p, s);
  const last = lastRun(ws.history, ws.project.root, ws.env.id, key, "deploy");
  const lastVersion = last?.exitCode === 0 ? last.meta?.version : undefined;
  const fields = target ? varsFor(ws, target.split(/\s+/)[0]) : [];
  const facts: ConfirmSpec["facts"] = [];
  if (action === "deploy" && version) facts.push({ icon: <Rocket size={16} />, text: t("Installs {v}, from {file}", { v: shortVersion(version), file: w.release ?? "" }) });
  facts.push(...callbackFacts(ws));
  const showDiff = action === "deploy" && lastVersion && version && lastVersion !== version;
  ws.confirm({
    title: `${meta.label} · ${s.label}`,
    subtitle: `${ws.env.label}${w.token !== ws.env.id ? ` · ${w.token}` : ""} · ${target ? "make " + target : a.playbook}`,
    env: ws.env,
    icon: <TechIcon kind={s.kind} size="lg" />,
    word: wordFor(w),
    from: showDiff ? shortVersion(lastVersion) : undefined,
    to: showDiff ? shortVersion(version) : undefined,
    facts,
    fields: fields.map((f) => ({ name: f.name, label: f.name, placeholder: f.value || t("(empty)") })),
    command: target ? `make ${target}` : `ansible-playbook ${a.playbook} -i ${w.inventory}`,
    details: target ? ws.makeInfo.get(target.split(/\s+/)[0])?.recipe : undefined,
    confirmLabel: meta.label,
    onConfirm: async (values) => {
      const extra = Object.entries(values).filter(([, v]) => v.trim()) as [string, string][];
      await ws.start(specFor(ws, w, target, a.playbook, extra), {
        title: `${meta.verb} · ${s.label}`,
        env: ws.env.id,
        service: key,
        action,
        version: action === "deploy" ? version : undefined,
      });
    },
  });
}

export function opAvailable(ws: Ws, o: Operation) {
  return opOn(o.action, ws.env.id) && targetExists(o.action, ws.env.id, ws.targets);
}

/** Pede confirmação e corre uma operação (backup, provisionamento, verificar…). */
export function runOperation(ws: Ws, o: Operation, preset: Record<string, string> = {}) {
  const env = ws.env;
  const w: Where = { server: env, token: env.id, inventory: env.inventory, release: env.release };
  const target = makeTarget(o.action, env.id);
  const name = target?.split(/\s+/)[0];
  const destructive = o.destructive || looksDestructive(o.id);
  const fields = name ? varsFor(ws, name) : [];
  // Uma operação já resolvida para uma variante (`reset-testes`) pede o nome dela.
  const variantTokens = new Set(ws.manifest.products.flatMap((p) => Object.values(p.placements ?? {}).map((x) => x.token)));
  const tail = o.action.make && !o.action.make.includes("{env}") ? o.action.make.split("-").pop() : undefined;
  const baked = tail && variantTokens.has(tail) ? tail : undefined;
  ws.confirm({
    title: o.label,
    subtitle: `${env.label} · ${target ? "make " + target : o.action.playbook}`,
    env,
    icon: (
      <span className="grid size-12 place-items-center rounded-[13px]" style={{ background: destructive ? "color-mix(in srgb, var(--danger) 16%, transparent)" : "var(--w-raise-2)", color: destructive ? "var(--danger)" : "var(--w-fg-2)" }}>
        {destructive ? <ShieldAlert size={22} /> : <Rocket size={20} />}
      </span>
    ),
    word: env.protected || destructive ? baked ?? wordFor(w, true) : undefined,
    danger: destructive,
    facts: [
      ...(o.description ? [{ icon: <span className="w-4" />, text: o.description, tone: "muted" as const }] : []),
      ...(destructive ? [{ icon: <ShieldAlert size={16} />, text: t("Deletes or restores data — it can't be undone."), tone: "warn" as const }] : []),
      ...callbackFacts(ws),
    ],
    fields: fields.map((f) => ({
      name: f.name,
      label: f.name,
      placeholder: f.value || t("(empty)"),
      value: preset[f.name] ?? (f.name === "SCOPE" && /all/.test(f.value) ? "all" : ""),
      options: f.name === "SCOPE" && /all/.test(f.value) ? ["all", "db", "storage"] : undefined,
    })),
    command: target ? `make ${target}` : undefined,
    details: name ? ws.makeInfo.get(name)?.recipe : undefined,
    confirmLabel: destructive ? t("Run anyway") : t("Run"),
    onConfirm: async (values) => {
      const extra = Object.entries(values).filter(([, v]) => v.trim()) as [string, string][];
      await ws.start(specFor(ws, w, target, o.action.playbook, extra), { title: o.label, env: env.id, action: o.id });
    },
  });
}
