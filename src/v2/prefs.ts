// Preferências desta pessoa neste computador — não vão para o ansible-mario.json.
import { getCurrentWindow } from "@tauri-apps/api/window";

export type Lang = "en" | "pt";
export type Theme = "auto" | "light" | "dark";
export interface Prefs {
  lang: Lang;
  theme: Theme;
  /** minutos entre actualizações automáticas; 0 = desligado */
  refreshMin: number;
}

const KEY = "ansible-mario.prefs";
export const DEFAULT_PREFS: Prefs = { lang: "en", theme: "auto", refreshMin: 3 };

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* sem armazenamento: fica só nesta sessão */
  }
}

/** Aplica o tema à página e à janela (barra de título nativa incluída). */
export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  getCurrentWindow()
    .setTheme(t === "auto" ? null : t)
    .catch(() => {});
}

export function isDark(t: Theme) {
  return t === "dark" || (t === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}
