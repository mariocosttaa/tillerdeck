import { translateError } from "./v2/i18n";
import { invoke } from "@tauri-apps/api/core";

export type FileKind =
  | "dir"
  | "playbook"
  | "inventory"
  | "release"
  | "vars"
  | "role"
  | "vault"
  | "config"
  | "makefile"
  | "other";

export interface FileEntry {
  path: string;
  isDir: boolean;
  kind: FileKind;
  vault: boolean;
}

export interface Project {
  root: string;
  name: string;
  hasConfig: boolean;
  files: FileEntry[];
  truncated: boolean;
}

export interface MakeTarget {
  name: string;
  description: string;
  section: string;
  recipe: string[];
  usesConfirm: boolean;
}

export interface InventoryGroup {
  name: string;
  hosts: string[];
  children: string[];
}

export interface CheckResult {
  ok: boolean;
  output: string;
}

export interface LintIssue {
  line: number;
  column: number;
  rule: string;
  message: string;
  severity: string;
}

export interface ConfigSetting {
  name: string;
  origin: string;
  value: unknown;
}

export interface RunMeta {
  title: string;
  env?: string;
  service?: string;
  action?: string;
  version?: string;
}

export interface HistoryEntry {
  id: string;
  root: string;
  label: string;
  argv: string[];
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  cancelled: boolean;
  logPath: string;
  meta?: RunMeta;
}

export interface Environment {
  path: string;
  tools: { name: string; path: string | null }[];
  ansibleVersion: string | null;
}

export type RunSpec =
  | {
      kind: "playbook";
      playbook: string;
      inventory: string;
      extraVarFiles: string[];
      limit: string;
      tags: string;
      skipTags: string;
      check: boolean;
      diff: boolean;
      verbosity: number;
      extraArgs: string;
    }
  | { kind: "make"; target: string; vars: [string, string][] };

export const api = {
  openProject: (path: string) => invoke<Project>("open_project", { path }),
  readFile: (root: string, path: string) => invoke<string>("read_file", { root, path }),
  writeFile: (root: string, path: string, content: string) =>
    invoke<void>("write_file", { root, path, content }),
  configDump: (root: string) => invoke<ConfigSetting[]>("config_dump", { root }),
  makeTargets: (root: string) => invoke<MakeTarget[]>("make_targets", { root }),
  inventory: (root: string, inventory: string) =>
    invoke<InventoryGroup[]>("inventory", { root, inventory }),
  syntaxCheck: (root: string, playbook: string, inventory?: string) =>
    invoke<CheckResult>("syntax_check", { root, playbook, inventory: inventory || null }),
  lint: (root: string, path: string) => invoke<LintIssue[]>("lint", { root, path }),
  vaultView: (root: string, path: string) => invoke<string>("vault_view", { root, path }),
  vaultSave: (root: string, path: string, content: string) =>
    invoke<void>("vault_save", { root, path, content }),
  runStart: (root: string, spec: RunSpec, meta?: RunMeta) =>
    invoke<HistoryEntry>("run_start", { root, spec, meta: meta ?? null }),
  runCancel: (id: string) => invoke<string>("run_cancel", { id }),
  runHistory: () => invoke<HistoryEntry[]>("run_history"),
  runLog: (id: string) => invoke<string>("run_log", { id }),
  environment: () => invoke<Environment>("environment"),
  initialProject: () => invoke<string | null>("initial_project"),
  setDirty: (dirty: boolean) => invoke<void>("set_dirty", { dirty }),
  forceQuit: () => invoke<void>("force_quit"),
  // v2
  projectState: (root: string) => invoke<ProjectState>("project_state", { root }),
  templateReport: (root: string, template: string, lang: string) => invoke<TemplateReport>("template_report", { root, template, lang }),
  varSet: (root: string, file: string, key: string, value: string) => invoke<string>("var_set", { root, file, key, value }),
  vaultKeySet: (root: string, file: string, key: string, value: string) => invoke<void>("vault_key_set", { root, file, key, value }),
  vaultKeyHas: (root: string, file: string, key: string) => invoke<boolean>("vault_key_has", { root, file, key }),
  manifestSave: (root: string, manifest: Manifest) => invoke<void>("manifest_save", { root, manifest }),
  releaseSet: (root: string, release: string, key: string, value: string) =>
    invoke<string>("release_set", { root, release, key, value }),
  releaseHistory: (root: string, release: string, key: string) =>
    invoke<Revision[]>("release_history", { root, release, key }),
  releaseCommit: (root: string, release: string, message: string) =>
    invoke<string>("release_commit", { root, release, message }),
  maintenanceState: (root: string, inventory: string) =>
    invoke<Record<string, boolean>>("maintenance_state", { root, inventory }),
  registryMatch: (url: string, image: string, fromTag: string, from: string, to: string) =>
    invoke<{ prefix: string; candidates: string[] } | null>("registry_match", { url, image, fromTag, from, to }),
  releaseCommitMany: (root: string, files: string[], message: string) => invoke<string>("release_commit_many", { root, files, message }),
  gitRemote: (root: string) => invoke<GitRemote>("git_remote", { root }),
  releasePublish: (root: string, files: string[], message: string, branch: string) => invoke<string>("release_publish", { root, files, message, branch }),
  gitPush: (root: string, branch: string) => invoke<string>("git_push", { root, branch }),
  registryBuilds: (url: string, image: string, format: string | undefined, env: string | undefined, limit?: number) =>
    invoke<Build[]>("registry_builds", { url, image, format: format || null, env: env || null, limit: limit ?? null }),
  gitCommits: (root: string, repo: string, branch?: string, limit?: number) =>
    invoke<Commit[]>("git_commits", { root, repo, branch: branch || null, limit: limit ?? null }),
};

export function errorText(e: unknown): string {
  return translateError(typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
}

/** O nome de um ambiente a partir de um caminho: `inventories/staging.ini` → `staging`. */
export function stem(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.(ini|ya?ml|json|cfg)$/i, "");
}

const PROD = /(^|[^a-z])(prod|production|producao|produção|prd|live)([^a-z]|$)/i;

export function looksLikeProduction(...values: (string | undefined)[]): boolean {
  return values.some((v) => !!v && PROD.test(v));
}

export function shellQuote(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// v2 — o ansible-mario.json
// ---------------------------------------------------------------------------

export interface Action {
  make?: string;
  playbook?: string;
  envs?: string[];
  /** também instala a versão do release (migrar = deploy com migrações) */
  includesDeploy?: boolean;
}

/** De onde vêm as versões que se podem escolher num deploy. */
export interface Versions {
  source: "registry" | "git" | "none";
  /** `{version}-{env}-{commit}-{build}` */
  tagFormat?: string;
  repo?: string;
  branch?: string;
  commitFormat?: "short" | "full";
  limit?: number;
}

export interface GitRemote {
  branch?: string;
  branches: string[];
  remote?: string;
  url?: string;
  upstream?: string;
  ahead: number;
  behind: number;
}

export interface Build {
  tag: string;
  created?: string;
  digest?: string;
  version?: string;
  commit?: string;
  env?: string;
  size?: number;
}

export interface Commit {
  sha: string;
  short: string;
  date: string;
  subject: string;
  author: string;
}

export interface Service {
  id: string;
  label: string;
  kind: string;
  releaseKey?: string;
  image?: string;
  perEnvImage?: boolean;
  container?: string;
  description?: string;
  versions?: Versions;
  actions: Record<string, Action>;
}

export interface Placement {
  token: string;
  inventory: string;
  release?: string;
}

export interface Product {
  id: string;
  label: string;
  description: string;
  /** servidores onde existe; vazio = todos */
  environments?: string[];
  /** servidor → onde vive lá (inventário, release, alvo) */
  placements?: Record<string, Placement>;
  services: Service[];
}

export interface Variable {
  id: string;
  label: string;
  group: string;
  kind: "bool" | "text" | "secret" | string;
  key: string;
  files: Record<string, string>;
}

export interface Operation {
  id: string;
  label: string;
  group: string;
  description: string;
  action: Action;
  destructive: boolean;
}

export interface EnvDef {
  id: string;
  label: string;
  inventory: string;
  release?: string;
  color: string;
  protected: boolean;
}

export interface Manifest {
  $schema?: string;
  version: number;
  name: string;
  template?: string;
  environments: EnvDef[];
  promotion: { from: string; to: string }[];
  registry?: { url: string };
  products: Product[];
  operations: Operation[];
  variables?: Variable[];
}

export interface ProjectState {
  manifest: Manifest | null;
  manifestError: string | null;
  problems: { path: string; message: string }[];
  targets: string[];
  /** ficheiro de release → chave → valor */
  releases: Record<string, Record<string, string>>;
  /** ficheiro → chave → valor (variáveis que não são segredos) */
  values: Record<string, Record<string, string>>;
  git: { branch: string | null; dirty: string[] };
  callbacks: string[];
}

export interface TemplateReport {
  template: string;
  compatible: boolean;
  matched: number;
  total: number;
  manifest: Manifest;
  unmatched: string[];
  warnings: string[];
}

export interface Revision {
  value: string;
  short: string;
  commit: string;
  date: string;
  subject: string;
}
