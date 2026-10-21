import type { Action, EnvDef, HistoryEntry, Manifest, Operation, Product, Service } from "../api";
import { t } from "./i18n";

export const ENV_COLOR: Record<string, string> = {
  staging: "var(--env-staging)",
  production: "var(--env-production)",
  testes: "var(--env-testes)",
  neutral: "var(--env-neutral)",
};
export const envColor = (e?: EnvDef) => ENV_COLOR[e?.color ?? "neutral"] ?? ENV_COLOR.neutral;

/** `1.21.0-8f3a2c1-c2e5b81f` → `1.21.0`; um SHA → 7 caracteres; `dev-1.16.0-…` → `dev-1.16.0`. */
export function shortVersion(v?: string): string {
  if (!v) return "";
  const t = v.trim();
  if (/^[0-9a-f]{12,}$/i.test(t)) return t.slice(0, 7);
  if (t.startsWith("dev-")) return "dev-" + t.slice(4).split("-")[0];
  return t.split("-")[0];
}

/** O commit dentro de uma tag (`…-8f3a2c1-…`), ou o próprio SHA curto. */
export function commitOf(v?: string): string {
  if (!v) return "";
  if (/^[0-9a-f]{12,}$/i.test(v.trim())) return v.trim().slice(0, 7);
  return v.split("-").find((p, i) => i > 0 && /^[0-9a-f]{7}$/.test(p)) ?? "";
}

/**
 * Compara versões. Devolve >0 se `a` é mais recente, 0 se iguais, <0 se mais
 * antiga, e `null` se são diferentes mas não ordenáveis (SHAs, `dev-`).
 */
export function cmpVersion(a?: string, b?: string): number | null {
  if (!a || !b) return null;
  if (a === b) return 0;
  const sem = /^(\d+)\.(\d+)\.(\d+)/;
  const ma = a.match(sem), mb = b.match(sem);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d) return d;
  }
  // Mesma versão: é a mesma coisa se for o mesmo commit — as tags que trazem
  // o ambiente (`-staging-` / `-production-`) diferem no texto mas não no código.
  const ca = commitOf(a), cb = commitOf(b);
  return ca && cb ? (ca === cb ? 0 : null) : null;
}

/** Onde um produto corre num servidor: o alvo (`{env}`), o inventário e o release. */
export interface Where {
  server: EnvDef;
  token: string;
  inventory: string;
  release?: string;
}

export function where(p: Product | undefined, server: EnvDef): Where {
  const pl = p?.placements?.[server.id];
  return pl
    ? { server, token: pl.token, inventory: pl.inventory, release: pl.release }
    : { server, token: server.id, inventory: server.inventory, release: server.release };
}

export function productOn(p: Product, server: string): boolean {
  return !p.environments?.length || p.environments.includes(server);
}

/** A acção existe para este alvo (`staging`, `production`, `testes`…)? */
export function actionFor(a: Action | undefined, token: string): boolean {
  return !!a && (!a.envs?.length || a.envs.includes(token));
}

/** Operações: `envs` são servidores. */
export function opOn(a: Action, server: string): boolean {
  return !a.envs?.length || a.envs.includes(server);
}

/** O alvo do make, com `{env}` resolvido, ou null se é um playbook. */
export function makeTarget(a: Action, token: string): string | null {
  return a.make ? a.make.replace("{env}", token) : null;
}

/** O alvo existe no Makefile? Um botão sem alvo fica desligado. */
export function targetExists(a: Action, token: string, targets: Set<string>): boolean {
  const x = makeTarget(a, token);
  if (!x) return true;
  return targets.has(x.split(/\s+/)[0]);
}

/** Versão de um serviço num servidor, lida do release onde o produto vive lá. */
export function versionOf(releases: Record<string, Record<string, string>>, w: Where, s: Service): string | undefined {
  return s.releaseKey && w.release ? releases[w.release]?.[s.releaseKey] : undefined;
}

/**
 * Fechado ou aberto? O que vale é o mais recente: um deploy (que reaplica o
 * que está no inventário), um "fechar" ou um "reabrir" feito daqui. Sem
 * nenhum, vale o inventário. Nunca é estado em directo.
 */
export function maintenanceState(history: HistoryEntry[], root: string, server: string, svc: string, flag: boolean | undefined) {
  const last = history.find(
    (h) => h.root === root && h.meta?.env === server && h.meta?.service === svc && h.endedAt && h.exitCode === 0 && ["deploy", "maintenanceOn", "maintenanceOff"].includes(h.meta?.action ?? ""),
  );
  if (last?.meta?.action === "maintenanceOn") return { closed: true, source: "action" as const, at: last.endedAt };
  if (last?.meta?.action === "maintenanceOff") return { closed: false, source: "action" as const, at: last.endedAt };
  if (flag === undefined) return { closed: undefined, source: "unknown" as const };
  return { closed: flag, source: "inventory" as const };
}

export const serviceKey = (p: Product, s: Service) => `${p.id}.${s.id}`;

/** `edu_api_tag` → `edu_api_maintenance_mode`: a flag do inventário. */
export function maintenanceKey(s: Service): string | null {
  if (!s.releaseKey) return null;
  return s.releaseKey.replace(/_(tag|commit|version|image)$/, "") + "_maintenance_mode";
}

export { relTime } from "./i18n";

export function duration(e: HistoryEntry): string {
  if (!e.endedAt) return "";
  const s = Math.round((new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime()) / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** A última corrida com sucesso de uma acção sobre um serviço num ambiente. */
export function lastRun(history: HistoryEntry[], root: string, env: string, service: string, action?: string) {
  return history.find(
    (h) => h.root === root && h.meta?.env === env && h.meta?.service === service && (!action || h.meta?.action === action) && h.endedAt,
  );
}

export const opGroupLabel = (g: string) =>
  ({ machine: t("Provisioning"), backup: t("Backups"), observability: t("Observability"), verify: t("Verify"), maintenance: t("Maintenance"), other: t("Other") })[g] ?? g;

export function opsIn(m: Manifest, group: string): Operation[] {
  return m.operations.filter((o) => o.group === group);
}

/** Um passo da corrida, tirado das linhas `TASK [role : nome]` do Ansible. */
export interface Step {
  name: string;
  state: "running" | "ok" | "failed";
  startedAt: number;
  endedAt?: number;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

export function parseSteps(lines: string[], prev: Step[] = [], now = Date.now()): Step[] {
  const steps = prev.map((s) => ({ ...s }));
  for (const raw of lines.flatMap((x) => x.split("\n"))) {
    const l = strip(raw).trimStart();
    const m = l.match(/^TASK \[(.+?)\]/);
    if (m) {
      const cur = steps[steps.length - 1];
      if (cur && cur.state === "running") {
        cur.state = "ok";
        cur.endedAt = now;
      }
      const name = m[1].includes(" : ") ? m[1].split(" : ").slice(1).join(" : ") : m[1];
      steps.push({ name, state: "running", startedAt: now });
      continue;
    }
    if (/^(fatal|failed):|FAILED!/.test(l) && !/RETRYING/.test(l)) {
      const cur = steps[steps.length - 1];
      if (cur) cur.state = "failed";
    }
    // `fatal: … ...ignoring` — o Ansible ignorou o erro e continua
    if (/^\.\.\.ignoring/.test(l)) {
      const cur = steps[steps.length - 1];
      if (cur && cur.state === "failed") cur.state = "running";
    }
    if (/^PLAY RECAP/.test(l)) {
      const cur = steps[steps.length - 1];
      if (cur && cur.state === "running") {
        cur.state = "ok";
        cur.endedAt = now;
      }
    }
  }
  return steps;
}

export function looksDestructive(text: string): boolean {
  return /apaga|reset|restore|restaura|destroy|delete|drop|wipe/i.test(text);
}
