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
  runStart: (root: string, spec: RunSpec) => invoke<HistoryEntry>("run_start", { root, spec }),
  runCancel: (id: string) => invoke<string>("run_cancel", { id }),
  runHistory: () => invoke<HistoryEntry[]>("run_history"),
  runLog: (id: string) => invoke<string>("run_log", { id }),
  environment: () => invoke<Environment>("environment"),
  initialProject: () => invoke<string | null>("initial_project"),
  setDirty: (dirty: boolean) => invoke<void>("set_dirty", { dirty }),
  forceQuit: () => invoke<void>("force_quit"),
};

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
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
