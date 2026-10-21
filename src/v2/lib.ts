import type { Action, EnvDef, HistoryEntry, Manifest, Operation, Product, Service } from "../api";

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

export function actionEnvs(a: Action, m: Manifest): string[] {
  return a.envs && a.envs.length ? a.envs : m.environments.map((e) => e.id);
}

export function hasAction(a: Action | undefined, env: string, m: Manifest): boolean {
  return !!a && actionEnvs(a, m).includes(env);
}

/** O alvo do make para este ambiente, ou null se a acção é um playbook. */
export function makeTarget(a: Action, env: string): string | null {
  return a.make ? a.make.replace("{env}", env) : null;
}

/** O alvo existe no Makefile? Um botão sem alvo fica desligado. */
export function targetExists(a: Action, env: string, targets: Set<string>): boolean {
  const t = makeTarget(a, env);
  if (!t) return true;
  return targets.has(t.split(/\s+/)[0]);
}

export const serviceKey = (p: Product, s: Service) => `${p.id}.${s.id}`;

/** `edu_api_tag` → `edu_api_maintenance_mode`: a flag do inventário. */
export function maintenanceKey(s: Service): string | null {
  if (!s.releaseKey) return null;
  return s.releaseKey.replace(/_(tag|commit|version|image)$/, "") + "_maintenance_mode";
}

export function relTime(iso?: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "agora";
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  if (d === 1) return "ontem";
  if (d < 30) return `há ${d} dias`;
  return new Date(iso).toLocaleDateString("pt-PT", { day: "numeric", month: "short" });
}

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

export const OP_GROUPS: Record<string, string> = {
  machine: "Provisionamento",
  backup: "Backups",
  observability: "Observabilidade",
  verify: "Verificar",
  maintenance: "Manutenção",
  other: "Outros",
};

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
  for (const raw of lines) {
    const l = strip(raw);
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
