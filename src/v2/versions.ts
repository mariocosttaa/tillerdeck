// As versões que se podem instalar num serviço: builds do registry ou
// commits de um repositório git, conforme o `versions` do manifesto.
// Pedem-se quando se abre o deploy ou a página das builds — nunca no
// refrescar automático, que não sai da máquina.
import { api, errorText, type EnvDef, type Product, type Service, type Versions } from "../api";
import type { Ws } from "./context";
import { where } from "./lib";
import { t } from "./i18n";

export interface Choice {
  /** o que se escreve no release */
  value: string;
  version?: string;
  commit?: string;
  date?: string;
  /** a mensagem do commit, para a fonte git */
  title?: string;
  author?: string;
  size?: number;
}

export function versionSource(ws: Ws, s: Service): Versions | null {
  if (s.versions?.source === "none") return null;
  if (s.versions) return s.versions;
  if (s.image && ws.manifest.registry?.url) return { source: "registry" };
  return null;
}

export function sourceLabel(ws: Ws, v: Versions, s: Service): string {
  if (v.source === "git") return t("commits of {repo}", { repo: `${v.repo ?? "?"}${v.branch ? ` · ${v.branch}` : ""}` });
  const host = (ws.manifest.registry?.url ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `${host}/${s.image ?? "?"}`;
}

const cache = new Map<string, { at: number; list: Choice[] }>();
const keyOf = (ws: Ws, p: Product, s: Service, server: EnvDef) => `${ws.project.root}|${p.id}.${s.id}@${where(p, server).token}`;

export function cached(ws: Ws, p: Product, s: Service, server: EnvDef) {
  return cache.get(keyOf(ws, p, s, server));
}

export async function loadChoices(ws: Ws, p: Product, s: Service, server: EnvDef, force = false): Promise<{ list: Choice[]; at: number }> {
  const k = keyOf(ws, p, s, server);
  const hit = cache.get(k);
  if (hit && !force) return hit;
  const v = versionSource(ws, s);
  if (!v) return { list: [], at: Date.now() };
  let list: Choice[];
  if (v.source === "git") {
    if (!v.repo) throw new Error(t("set the repository in Settings"));
    const commits = await api.gitCommits(ws.project.root, v.repo, v.branch, v.limit);
    list = commits.map((c) => ({ value: v.commitFormat === "full" ? c.sha : c.short, commit: c.short, date: c.date, title: c.subject, author: c.author }));
  } else {
    const url = ws.manifest.registry?.url;
    if (!url || !s.image) throw new Error(t("set the registry and image in Settings"));
    const env = v.tagFormat?.includes("{env}") ? where(p, server).token : undefined;
    const builds = await api.registryBuilds(url, s.image, v.tagFormat, env, v.limit);
    list = builds.map((b) => ({ value: b.tag, version: b.version, commit: b.commit?.slice(0, 7), date: b.created, size: b.size }));
  }
  const out = { list, at: Date.now() };
  cache.set(k, out);
  return out;
}

export const loadError = (e: unknown) => (e instanceof Error ? e.message : errorText(e));

export function formatSize(n?: number) {
  if (!n) return "";
  return n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}
