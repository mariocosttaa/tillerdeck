// Traduções. O texto da interface está escrito em inglês no código (é a
// língua por omissão) e o português vive em `pt.ts`, chaveado pela frase
// inglesa. Uma frase sem tradução mostra-se em inglês — nunca em branco.
import type { Lang } from "./prefs";
import { PT } from "./pt";

let current: Lang = "en";

export function setLang(l: Lang) {
  current = l;
  document.documentElement.lang = l === "pt" ? "pt-PT" : "en";
}

export function lang(): Lang {
  return current;
}

/** `t("Deploy {name}", { name: "api" })` */
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = current === "pt" ? PT[key] ?? key : key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Plural simples: `tn(n, "{n} service", "{n} services")`. */
export function tn(n: number, one: string, many: string, vars?: Record<string, string | number>) {
  return t(n === 1 ? one : many, { n, ...vars });
}

/** Datas relativas na língua actual. */
export function relTime(iso?: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return t("just now");
  if (m < 60) return t("{n} min ago", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("{n} h ago", { n: h });
  const d = Math.round(h / 24);
  if (d === 1) return t("yesterday");
  if (d < 30) return t("{n} days ago", { n: d });
  return new Date(iso).toLocaleDateString(current === "pt" ? "pt-PT" : "en-GB", { day: "numeric", month: "short" });
}

export const locale = () => (current === "pt" ? "pt-PT" : "en-GB");

/**
 * Os erros vêm do Rust em português. Em inglês, os mais comuns traduzem-se;
 * os outros mostram-se como vêm (melhor que esconder a causa).
 */
const ERRORS: [RegExp, string][] = [
  [/^já há uma corrida em (\S+) — espera que acabe ou cancela-a$/, "There's already a run on $1 — wait for it to end or cancel it"],
  [/^esta corrida já terminou$/, "This run has already finished"],
  [/^não foi possível correr `([^`]+)`: (.*)$/s, "Couldn't run `$1`: $2"],
  [/^`([^`]+)` está fora do projecto$/, "`$1` is outside the project"],
  [/^sem credenciais para (\S+) — faz `docker login (\S+)`$/, "No credentials for $1 — run `docker login $2`"],
  [/^o registry (\S+) recusou as credenciais do docker login$/, "The registry $1 refused the docker login credentials"],
  [/^a imagem (\S+) não existe em (\S+)$/, "The image $1 doesn't exist in $2"],
  [/^(.*): `([^`]+)` aparece (\d+) vezes — esperava uma$/, "$1: `$2` appears $3 times — expected once"],
  [/^(\S+) está cifrado — usa o vault$/, "$1 is encrypted — use the vault"],
  [/^escolhe um inventário$/, "Choose an inventory"],
  [/^o projecto não é um repositório git$/, "The project isn't a git repository"],
  [/^ficheiro binário — não abre no editor$/, "Binary file — it doesn't open in the editor"],
  [/^este ficheiro está cifrado — grava-se pelo vault$/, "This file is encrypted — save it through the vault"],
];

export function translateError(msg: string): string {
  if (current === "pt") return msg;
  for (const [re, en] of ERRORS) if (re.test(msg)) return msg.replace(re, en);
  return msg;
}
