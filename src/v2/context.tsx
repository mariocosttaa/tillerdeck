import { createContext, useContext, type ReactNode } from "react";
import { Database, MessageSquare, Rocket, Sprout, Construction, ShieldAlert } from "lucide-react";
import type { EnvDef, HistoryEntry, MakeTarget, Manifest, Operation, Product, Project, ProjectState, RunMeta, RunSpec, Service } from "../api";
import type { Run } from "./store";
import { hasAction, lastRun, looksDestructive, makeTarget, serviceKey, shortVersion, targetExists } from "./lib";
import { TechIcon, type ConfirmSpec } from "./ui";

export type Page = "servicos" | "promover" | "backups" | "maquina" | "execucoes" | "definicoes" | "ficheiros" | `produto:${string}`;

export interface Ws {
  project: Project;
  state: ProjectState;
  manifest: Manifest;
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
  selected: string | null;
  select: (key: string | null) => void;
  openPalette: () => void;
}

const Ctx = createContext<Ws | null>(null);
export const WsProvider = ({ value, children }: { value: Ws; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export function useWs(): Ws {
  const v = useContext(Ctx);
  if (!v) throw new Error("fora do workspace");
  return v;
}

export const ACTION_META: Record<string, { label: string; verb: string; icon: ReactNode; sub: string }> = {
  deploy: { label: "Fazer deploy", verb: "Deploy", icon: <Rocket size={16} />, sub: "instala a versão do release" },
  migrate: { label: "Migrar a base", verb: "Migrar", icon: <Database size={16} />, sub: "só as migrações" },
  seed: { label: "Migrar e semear", verb: "Semear", icon: <Sprout size={16} />, sub: "migra e semeia" },
  maintenanceOn: { label: "Fechar ao público", verb: "Fechar", icon: <Construction size={16} />, sub: "modo de manutenção" },
  maintenanceOff: { label: "Reabrir", verb: "Reabrir", icon: <Construction size={16} />, sub: "sai da manutenção" },
};

/** As variáveis `VAR ?=` que uma receita usa (directamente ou numa macro). */
function varsFor(ws: Ws, target: string) {
  const info = ws.makeInfo.get(target);
  if (!info) return [];
  const text = info.recipe.join("\n");
  return ws.makeVars.filter((v) => v.name !== "ARGS" && (text.includes(`$(${v.name})`) || text.includes(`\${${v.name}}`)));
}

function callbackFacts(ws: Ws) {
  const notify = ws.state.callbacks.filter((c) => !["profile_tasks", "timer", "default", "yaml"].includes(c));
  return notify.length ? [{ icon: <MessageSquare size={16} />, text: `No fim corre o callback ${notify.join(", ")}` }] : [];
}

function specFor(ws: Ws, target: string | null, playbook: string | undefined, extraVars: [string, string][] = []): RunSpec {
  if (target) {
    const [name, ...inline] = target.split(/\s+/);
    const vars: [string, string][] = inline.map((kv) => kv.split("=") as [string, string]);
    vars.push(...extraVars);
    // A trava interactiva do Makefile (um `read`) não tem terminal aqui:
    // a app já pediu a palavra, passa CONFIRM=yes.
    if (ws.makeInfo.get(name)?.usesConfirm) vars.push(["CONFIRM", "yes"]);
    return { kind: "make", target: name, vars };
  }
  return {
    kind: "playbook",
    playbook: playbook!,
    inventory: ws.env.inventory,
    extraVarFiles: ws.env.release ? [ws.env.release] : [],
    limit: "",
    tags: "",
    skipTags: "",
    check: false,
    diff: false,
    verbosity: 0,
    extraArgs: "",
  };
}

export function canRun(ws: Ws, s: Service, action: string): boolean {
  const a = s.actions[action];
  return hasAction(a, ws.env.id, ws.manifest) && targetExists(a, ws.env.id, ws.targets);
}

/** Pede confirmação e corre uma acção de um serviço no ambiente actual. */
export function runServiceAction(ws: Ws, p: Product, s: Service, action: string) {
  const a = s.actions[action];
  if (!a) return;
  const env = ws.env;
  const target = makeTarget(a, env.id);
  const meta = ACTION_META[action] ?? { label: action, verb: action, icon: <Rocket size={16} />, sub: "" };
  const version = s.releaseKey ? ws.state.releases[env.id]?.[s.releaseKey] : undefined;
  const key = serviceKey(p, s);
  const last = lastRun(ws.history, ws.project.root, env.id, key, "deploy");
  const lastVersion = last?.exitCode === 0 ? last.meta?.version : undefined;
  const fields = target ? varsFor(ws, target.split(/\s+/)[0]) : [];
  const facts: ConfirmSpec["facts"] = [];
  if (action === "deploy" && version) facts.push({ icon: <Rocket size={16} />, text: `Instala ${shortVersion(version)}, que está em ${env.release}` });
  facts.push(...callbackFacts(ws));
  ws.confirm({
    title: `${meta.label} · ${s.label}`,
    subtitle: `${env.label} · ${target ? "make " + target : a.playbook}`,
    env,
    icon: <TechIcon kind={s.kind} size="lg" />,
    word: env.protected ? env.id : undefined,
    from: action === "deploy" && lastVersion && version && lastVersion !== version ? shortVersion(lastVersion) : undefined,
    to: action === "deploy" && lastVersion && version && lastVersion !== version ? shortVersion(version) : undefined,
    facts,
    fields: fields.map((f) => ({ name: f.name, label: f.name, placeholder: f.value || "(vazio)" })),
    command: target ? `make ${target}` : `ansible-playbook ${a.playbook} -i ${env.inventory}`,
    details: target ? ws.makeInfo.get(target.split(/\s+/)[0])?.recipe : undefined,
    confirmLabel: meta.label,
    onConfirm: async (values) => {
      const extra = Object.entries(values).filter(([, v]) => v.trim()) as [string, string][];
      await ws.start(specFor(ws, target, a.playbook, extra), {
        title: `${meta.verb} · ${s.label}`,
        env: env.id,
        service: key,
        action,
        version,
      });
    },
  });
}

/** Pede confirmação e corre uma operação (backup, provisionamento, verificar…). */
export function runOperation(ws: Ws, o: Operation, preset: Record<string, string> = {}) {
  const env = ws.env;
  const target = makeTarget(o.action, env.id);
  const name = target?.split(/\s+/)[0];
  const destructive = o.destructive || looksDestructive(o.id);
  const fields = name ? varsFor(ws, name) : [];
  ws.confirm({
    title: o.label,
    subtitle: `${env.label} · ${target ? "make " + target : o.action.playbook}`,
    env,
    icon: (
      <span className="grid size-12 place-items-center rounded-[13px]" style={{ background: destructive ? "color-mix(in srgb, var(--danger) 16%, transparent)" : "var(--w-raise-2)", color: destructive ? "var(--danger)" : "var(--w-fg-2)" }}>
        {destructive ? <ShieldAlert size={22} /> : <Rocket size={20} />}
      </span>
    ),
    word: env.protected || destructive ? env.id : undefined,
    danger: destructive,
    facts: [
      ...(o.description ? [{ icon: <span className="w-4" />, text: o.description, tone: "muted" as const }] : []),
      ...(destructive ? [{ icon: <ShieldAlert size={16} />, text: "Apaga ou repõe dados — não se desfaz.", tone: "warn" as const }] : []),
      ...callbackFacts(ws),
    ],
    fields: fields.map((f) => ({
      name: f.name,
      label: f.name,
      placeholder: f.value || "(vazio)",
      value: preset[f.name] ?? (f.name === "SCOPE" && /all/.test(f.value) ? "all" : ""),
      options: f.name === "SCOPE" && /all/.test(f.value) ? ["all", "db", "storage"] : undefined,
    })),
    command: target ? `make ${target}` : undefined,
    details: name ? ws.makeInfo.get(name)?.recipe : undefined,
    confirmLabel: destructive ? "Correr mesmo assim" : "Correr",
    onConfirm: async (values) => {
      const extra = Object.entries(values).filter(([, v]) => v.trim()) as [string, string][];
      await ws.start(specFor(ws, target, o.action.playbook, extra), { title: o.label, env: env.id, action: o.id });
    },
  });
}

export function opAvailable(ws: Ws, o: Operation) {
  return hasAction(o.action, ws.env.id, ws.manifest) && targetExists(o.action, ws.env.id, ws.targets);
}
