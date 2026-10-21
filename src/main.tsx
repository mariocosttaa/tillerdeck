import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./legacy.css";
import { applyTheme, loadPrefs } from "./v2/prefs";
import { setLang } from "./v2/i18n";

// Antes do primeiro desenho: sem piscar no tema errado.
const prefs = loadPrefs();
applyTheme(prefs.theme);
setLang(prefs.lang);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
