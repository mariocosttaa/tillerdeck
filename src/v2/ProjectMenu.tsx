import { useEffect, useRef, useState, type ReactNode } from "react";
import { FolderOpen, X } from "lucide-react";
import { t } from "./i18n";

const isMac = navigator.userAgent.includes("Mac");

export interface OpenProject {
  root: string;
  name: string;
  /** corridas a decorrer neste projecto */
  running: number;
}

/** Os projectos abertos ao mesmo tempo e como se muda entre eles. */
export interface Switcher {
  open: OpenProject[];
  active: string;
  recents: string[];
  switchTo: (root: string) => void;
  close: (root: string) => void;
  /** abre um caminho (dos recentes) ou, sem caminho, a escolha de pasta */
  openPath: (path?: string) => void;
}

const base = (r: string) => r.split("/").pop() ?? r;

/**
 * O menu do projecto no topo da barra lateral: os abertos (com um ponto
 * quando há corridas), os recentes e "Abrir…". ⌘1…⌘9 saltam entre abertos.
 */
export function ProjectMenu({ sw, className, children }: { sw: Switcher; className?: string; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shown) return;
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setShown(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setShown(false);
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [shown]);
  const others = sw.recents.filter((r) => !sw.open.some((o) => o.root === r)).slice(0, 5);
  const pick = (f: () => void) => () => {
    setShown(false);
    f();
  };

  return (
    <div ref={box} className="relative">
      <button className={className} onClick={() => setShown((x) => !x)} title={t("Switch project")} aria-expanded={shown}>
        {children}
      </button>
      {shown && (
        <div className="menu am-in absolute left-0 right-0 top-full z-40 mt-1 min-w-[240px] p-1.5">
          <p className="sec-h px-2 pb-1 pt-1">{t("Open projects")}</p>
          {sw.open.map((o, i) => (
            <div key={o.root} className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-hover ${o.root === sw.active ? "bg-hover" : ""}`}>
              <button className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={pick(() => sw.switchTo(o.root))} title={o.root}>
                <span className="grid size-6 shrink-0 place-items-center rounded-md text-[11px] font-semibold text-white" style={{ background: "#6B5BF5" }}>
                  {o.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{o.name}</span>
                {o.running > 0 && (
                  <span className="relative flex size-2" title={t("{n} running", { n: o.running })}>
                    <span className="am-ping absolute inline-flex size-full rounded-full bg-accent" />
                    <span className="relative inline-flex size-2 rounded-full bg-accent" />
                  </span>
                )}
                {i < 9 && <span className="kbd">{isMac ? "⌘" : "Ctrl "}{i + 1}</span>}
              </button>
              {sw.open.length > 1 && (
                <button className="ib !size-6 opacity-0 group-hover:opacity-100" title={t("Close project")} onClick={pick(() => sw.close(o.root))}>
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
          {others.length > 0 && (
            <>
              <p className="sec-h px-2 pb-1 pt-3">{t("Recent")}</p>
              {others.map((r) => (
                <button key={r} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover" onClick={pick(() => sw.openPath(r))} title={r}>
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-raise-2 text-[11px] font-semibold">{base(r).slice(0, 1).toUpperCase()}</span>
                  <span className="min-w-0 flex-1 truncate">{base(r)}</span>
                </button>
              ))}
            </>
          )}
          <div className="my-1.5 border-t hair" />
          <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover" onClick={pick(() => sw.openPath())}>
            <FolderOpen size={15} className="text-fg-3" />
            <span className="flex-1">{t("Open…")}</span>
            <span className="kbd">{isMac ? "⌘O" : "Ctrl O"}</span>
          </button>
        </div>
      )}
    </div>
  );
}
