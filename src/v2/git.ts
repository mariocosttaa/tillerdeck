// Guardar os releases no git: o que fazer depois de um deploy com versão nova
// (nada, commit, commit + push) e para que branch. É uma escolha de cada
// pessoa, por projecto — fica neste computador, nunca no ansible-mario.json.
import { api, errorText } from "../api";
import type { Ws } from "./context";
import { t } from "./i18n";

export type AfterDeploy = "off" | "commit" | "push";
export interface GitPrefs {
  after: AfterDeploy;
  /** a branch para onde vai o push; vazio = a actual */
  branch: string;
}

const key = (root: string) => `ansible-mario.git.${root}`;

export function loadGit(root: string): GitPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(key(root)) ?? "{}");
    return { after: v.after === "commit" || v.after === "push" ? v.after : "off", branch: typeof v.branch === "string" ? v.branch : "" };
  } catch {
    return { after: "off", branch: "" };
  }
}

export function saveGit(root: string, p: GitPrefs) {
  try {
    localStorage.setItem(key(root), JSON.stringify(p));
  } catch {
    /* sem armazenamento: fica só nesta sessão */
  }
}

/** Mensagens em Conventional Commits, sem trailers. */
export const commitMessage = {
  deploy: (service: string, version: string, server: string) => `chore(release): ${service} ${version} on ${server.toLowerCase()}`,
  promote: (items: string[], server: string) => `chore(release): promote ${items.join(", ")} to ${server.toLowerCase()}`,
  rollback: (items: string[], server: string) => `chore(release): roll back ${items.join(", ")} on ${server.toLowerCase()}`,
  manual: (files: string[]) => `chore(release): update ${files.map((f) => f.replace(/^releases\//, "").replace(/\.ya?ml$/, "")).join(", ")}`,
};

/** O push, se estiver escolhido. Nunca força; numa branch errada, avisa e não envia. */
export async function pushIfWanted(ws: Ws, force = false): Promise<boolean> {
  const g = loadGit(ws.project.root);
  if (g.after !== "push" && !force) return false;
  try {
    const branch = g.branch || ws.state.git.branch || "";
    const to = await api.gitPush(ws.project.root, branch);
    ws.toast(t("Pushed to {to}", { to }));
    return true;
  } catch (e) {
    ws.toast(t("The commit stayed local — push failed: {e}", { e: errorText(e) }), true);
    return false;
  }
}

/** Commit de ficheiros de release e, se escolhido, push. */
export async function commitReleases(ws: Ws, files: string[], message: string, push: boolean) {
  try {
    const sha = await api.releaseCommitMany(ws.project.root, files, message);
    ws.toast(t("Commit {sha} — {msg}", { sha, msg: message }));
  } catch (e) {
    ws.toast(t("The commit failed: {e}", { e: errorText(e) }), true);
    return;
  }
  if (push) await pushIfWanted(ws, true);
  await ws.refresh();
}

/** Os ficheiros de release do projecto que têm alterações por guardar. */
export function dirtyReleases(ws: Ws): string[] {
  const rel = new Set([
    ...ws.manifest.environments.map((e) => e.release).filter(Boolean),
    ...ws.manifest.products.flatMap((p) => Object.values(p.placements ?? {}).map((x) => x.release).filter(Boolean)),
  ] as string[]);
  // o git dá caminhos a partir da raiz do repositório, que pode estar acima do projecto
  return [...rel].filter((r) => ws.state.git.dirty.some((f) => f === r || f.endsWith(`/${r}`)));
}
