import type { ReactNode } from "react";
import {
  Bell, Box, ChevronsUpDown, DatabaseBackup, FileCode2, GitCompareArrows, History, LayoutGrid, Lock, PanelLeft, Search, ServerCog, Settings2,
} from "lucide-react";
import { useWs, type Page } from "./context";
import { EnvDot } from "./ui";
import { cmpVersion } from "./lib";

const isMac = navigator.userAgent.includes("Mac");

export function Shell({ title, children, onSwitchProject }: { title: string; children: ReactNode; onSwitchProject: () => void }) {
  const ws = useWs();
  const { manifest: m, env, page, go } = ws;

  const promo = m.promotion[0];
  const ahead = promo
    ? m.products.flatMap((p) => p.services).filter((s) => s.releaseKey && (cmpVersion(ws.state.releases[promo.from]?.[s.releaseKey], ws.state.releases[promo.to]?.[s.releaseKey]) ?? 0) > 0).length
    : 0;
  const running = Object.values(ws.runs).filter((r) => r.running);

  const nav = (id: Page, icon: ReactNode, label: string, extra?: ReactNode) => (
    <button key={id} className={`nav ${page === id ? "on" : ""}`} onClick={() => go(id)}>
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {extra}
    </button>
  );

  return (
    <div className="flex h-full">
      <aside className="flex w-[244px] shrink-0 flex-col px-3 pb-3">
        <div className="flex h-[52px] shrink-0 items-center px-1" data-tauri-drag-region>
          <span className="ml-auto" />
          <button className="ib !size-7" title="Barra lateral"><PanelLeft size={16} /></button>
        </div>
        <button className="raise mb-2 flex items-center gap-3 px-3 py-2.5 text-left" onClick={onSwitchProject} title="Abrir outro projecto (⌘O)">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg text-[13px] font-bold text-white" style={{ background: "linear-gradient(135deg,#7c6cff,#4a8cff)" }}>
            {(m.name || ws.project.name).slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold">{ws.project.name}</span>
            <span className="block truncate text-[11.5px] text-fg-3">{m.environments.length} ambiente{m.environments.length === 1 ? "" : "s"}</span>
          </span>
          <ChevronsUpDown size={16} className="text-fg-3" />
        </button>

        <div className="scroll min-h-0 flex-1 overflow-auto">
          <div className="nav-h">Operações</div>
          {nav("servicos", <LayoutGrid size={16} />, "Serviços")}
          {promo && nav("promover", <GitCompareArrows size={16} />, "Promover", ahead > 0 && <span className="pill !h-5 !px-1.5 text-[11px] text-white" style={{ background: "var(--w-accent)" }}>{ahead}</span>)}
          {m.operations.some((o) => o.group === "backup") && nav("backups", <DatabaseBackup size={16} />, "Backups")}
          {nav("maquina", <ServerCog size={16} />, "Máquina")}
          {m.products.length > 1 && (
            <>
              <div className="nav-h">Produtos</div>
              {m.products.map((p) => nav(`produto:${p.id}`, <Box size={16} />, p.label, <span className="text-[11.5px] text-fg-3">{p.services.length}</span>))}
            </>
          )}
          <div className="nav-h">Projecto</div>
          {nav("execucoes", <History size={16} />, "Execuções", running.length > 0 && <span className="relative flex size-2"><span className="am-ping absolute inline-flex size-full rounded-full bg-accent" /><span className="relative inline-flex size-2 rounded-full bg-accent" /></span>)}
          {nav("definicoes", <Settings2 size={16} />, "Definições", ws.state.problems.length > 0 && <span className="pill !h-5 !px-1.5 text-[11px]" style={{ color: "var(--warn)", background: "color-mix(in srgb, var(--warn) 15%, transparent)" }}>{ws.state.problems.length}</span>)}
          {nav("ficheiros", <FileCode2 size={16} />, "Ficheiros")}
        </div>

        <div className="raise mt-3 flex items-center gap-2.5 px-3 py-2.5 text-[12px]">
          <span className="relative flex size-2">
            {running.length > 0 && <span className="am-ping absolute inline-flex size-full rounded-full bg-accent" />}
            <span className={`relative inline-flex size-2 rounded-full ${running.length ? "bg-accent" : "bg-ok"}`} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{running.length ? `${running.length} a correr` : "Nada a correr"}</span>
            <span className="block truncate text-fg-3">{ws.state.git.branch ? `git · ${ws.state.git.branch}` : "sem git"}{ws.state.git.dirty.length ? ` · ${ws.state.git.dirty.length} por commitar` : ""}</span>
          </span>
        </div>
      </aside>

      <div className="min-w-0 flex-1 py-2 pr-2">
        <div className="panel flex h-full flex-col overflow-hidden">
          <header className="flex h-[56px] shrink-0 items-center gap-3 border-b hair px-5" data-tauri-drag-region>
            <h1 className="text-[15px] font-semibold">{title}</h1>
            {page !== "ficheiros" && page !== "definicoes" && (
              <div className="seg ml-3">
                {m.environments.map((e) => (
                  <button key={e.id} className={e.id === env.id ? "on" : ""} onClick={() => ws.setEnv(e.id)}>
                    <EnvDot env={e} size={7} />
                    {e.label}
                    {e.protected && <Lock size={11} className="text-fg-3" />}
                  </button>
                ))}
              </div>
            )}
            <button className="ml-auto flex h-8 w-[300px] items-center gap-2 rounded-[9px] bg-raise px-3 text-[13px] text-fg-3 ring-1 ring-line hover:text-fg-2" onClick={ws.openPalette}>
              <Search size={15} />
              Procurar ou correr uma acção
              <span className="kbd ml-auto">{isMac ? "⌘K" : "Ctrl K"}</span>
            </button>
            <button className="ib" title="Execuções" onClick={() => go("execucoes")}><Bell size={17} /></button>
          </header>
          <div className="relative flex min-h-0 flex-1">{children}</div>
        </div>
      </div>
    </div>
  );
}
