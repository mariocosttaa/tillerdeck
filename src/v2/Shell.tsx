import { useEffect, useState, type ReactNode } from "react";
import {
  Bell, Box, Boxes, Megaphone, Sparkles, ChevronsUpDown, DatabaseBackup, FileCode2, GitCompareArrows, History, LayoutGrid, Lock, PanelLeft, RefreshCw, Search, ServerCog, Settings, Settings2,
} from "lucide-react";
import { useWs, type Page } from "./context";
import { api, errorText } from "../api";
import { EnvDot } from "./ui";
import { cmpVersion, productOn, versionOf, where } from "./lib";
import { relTime, t } from "./i18n";
import { versionSource } from "./versions";
import { useAppVersion } from "./pages/Personal";
import { openSettings } from "./pages/Settings";

const isMac = navigator.userAgent.includes("Mac");

export function Shell({ title, children, onSwitchProject }: { title: string; children: ReactNode; onSwitchProject: () => void }) {
  const ws = useWs();
  const { manifest: m, env, page, go } = ws;
  const version = useAppVersion();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const promo = m.promotion[0];
  const from = m.environments.find((e) => e.id === promo?.from);
  const to = m.environments.find((e) => e.id === promo?.to);
  const ahead = from && to
    ? m.products.filter((p) => productOn(p, from.id) && productOn(p, to.id)).flatMap((p) => p.services.map((s) => ({ p, s })))
        .filter(({ p, s }) => s.releaseKey && (cmpVersion(versionOf(ws.state.releases, where(p, from), s), versionOf(ws.state.releases, where(p, to), s)) ?? 1) > 0).length
    : 0;
  const running = Object.values(ws.runs).filter((r) => r.running);

  const nav = (id: Page, icon: ReactNode, label: string, extra?: ReactNode) => (
    <button key={id} className={`nav ${page === id ? "on" : ""}`} onClick={() => go(id)}>
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {extra}
    </button>
  );
  const here = m.products.filter((p) => productOn(p, env.id));

  return (
    <div className="flex h-full">
      <aside className="flex w-[244px] shrink-0 flex-col px-3 pb-3">
        <div className="flex h-[52px] shrink-0 items-center px-1" data-tauri-drag-region>
          <span className="ml-auto" />
          <button className="ib !size-7" title={t("Sidebar")}><PanelLeft size={16} /></button>
        </div>
        <button className="raise mb-2 flex items-center gap-3 px-3 py-2.5 text-left" onClick={onSwitchProject} title={t("Open another project")}>
          <span className="grid size-8 shrink-0 place-items-center rounded-lg text-[13px] font-semibold text-white" style={{ background: "#6B5BF5" }}>
            {(m.name || ws.project.name).slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold">{ws.project.name}</span>
            <span className="block truncate text-[11.5px] text-fg-3">{m.environments.length === 1 ? t("1 server") : t("{n} servers", { n: m.environments.length })}</span>
          </span>
          <ChevronsUpDown size={16} className="text-fg-3" />
        </button>

        <div className="scroll min-h-0 flex-1 overflow-auto">
          <div className="nav-h">{t("Operations")}</div>
          {nav("servicos", <LayoutGrid size={16} />, t("Services"))}
          {m.products.some((p) => p.services.some((s) => versionSource(ws, s))) && nav("builds", <Boxes size={16} />, t("Builds"))}
          {promo && nav("promover", <GitCompareArrows size={16} />, t("Promote"), ahead > 0 && <span className="pill !h-5 !px-1.5 text-[11px] text-white" style={{ background: "var(--w-accent)" }}>{ahead}</span>)}
          {m.operations.some((o) => o.group === "backup") && nav("backups", <DatabaseBackup size={16} />, t("Backups"))}
          {nav("maquina", <ServerCog size={16} />, t("Machine"))}
          {(m.variables ?? []).some((v) => v.category === "notifications") && nav("notificacoes", <Megaphone size={16} />, t("Notifications"))}
          {here.length > 1 && (
            <>
              <div className="nav-h">{t("Products on {env}", { env: env.label })}</div>
              {here.map((p) => nav(`produto:${p.id}`, <Box size={16} />, p.label, <span className="text-[11.5px] text-fg-3">{p.services.length}</span>))}
            </>
          )}
          <div className="nav-h">{t("Project")}</div>
          {nav("execucoes", <History size={16} />, t("Runs"), running.length > 0 && <span className="relative flex size-2"><span className="am-ping absolute inline-flex size-full rounded-full bg-accent" /><span className="relative inline-flex size-2 rounded-full bg-accent" /></span>)}
          {nav("definicoes", <Settings2 size={16} />, t("Settings"), ws.state.problems.length > 0 && <span className="pill !h-5 !px-1.5 text-[11px]" style={{ color: "var(--warn)", background: "color-mix(in srgb, var(--warn) 15%, transparent)" }}>{ws.state.problems.length}</span>)}
          {nav("ficheiros", <FileCode2 size={16} />, t("Files"))}
        </div>

        <div className="relative mt-3">
          <div className="raise flex items-center gap-2.5 px-3 py-2.5 text-[12px]">
            <span className="relative flex size-2">
              {running.length > 0 && <span className="am-ping absolute inline-flex size-full rounded-full bg-accent" />}
              <span className={`relative inline-flex size-2 rounded-full ${running.length ? "bg-accent" : "bg-ok"}`} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{running.length ? t("{n} running", { n: running.length }) : t("Nothing running")}</span>
              {version && <span className="block truncate text-fg-3" title={t("App version")}>Tillerdeck <span className="font-mono">v{version}</span></span>}
            </span>
            <button className="ib !size-7" title={t("Preferences")} onClick={() => openSettings(go, "preferences")}><Settings size={15} /></button>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1 py-2 pr-2">
        <div className="panel flex h-full flex-col overflow-hidden">
          <header className="flex h-[56px] shrink-0 items-center gap-3 border-b hair px-5" data-tauri-drag-region>
            <h1 className="truncate text-[15px] font-semibold">{title}</h1>
            {page !== "ficheiros" && page !== "definicoes" && page !== "notificacoes" && (
              <div className="seg ml-3 shrink-0">
                {m.environments.map((e) => (
                  <button key={e.id} className={e.id === env.id ? "on" : ""} onClick={() => ws.setEnv(e.id)}>
                    <EnvDot env={e} size={7} />
                    {e.label}
                    {e.protected && <Lock size={11} className="text-fg-3" />}
                  </button>
                ))}
              </div>
            )}
            <button className="ml-auto hidden h-8 w-[280px] items-center gap-2 rounded-[9px] bg-raise px-3 text-[13px] text-fg-3 ring-1 ring-line hover:text-fg-2 xl:flex" onClick={ws.openPalette}>
              <Search size={15} />
              {t("Search or run an action")}
              <span className="kbd ml-auto">{isMac ? "⌘K" : "Ctrl K"}</span>
            </button>
            <button className="ib ml-auto xl:hidden" title={t("Search or run an action")} onClick={ws.openPalette}><Search size={17} /></button>
            <button
              className="ib"
              title={t("Refresh — last at {when}", { when: relTime(new Date(ws.refreshedAt).toISOString()) })}
              onClick={() => ws.refresh()}
            >
              <RefreshCw size={16} className={ws.refreshing ? "animate-spin" : ""} />
            </button>
            <button className="ib" title={t("Runs")} onClick={() => go("execucoes")}><Bell size={17} /></button>
          </header>
          {ws.state.auto && <AutoBar />}
          <div className="relative flex min-h-0 flex-1">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** O projecto abriu sem tillerdeck.json: diz de onde veio e oferece gravar. */
function AutoBar() {
  const ws = useWs();
  const a = ws.state.auto!;
  const [busy, setBusy] = useState(false);
  const from = a.template === "makefile-convention" ? t("your Makefile ({a} of {b} targets)", { a: a.matched, b: a.total }) : t("your playbooks");
  async function save() {
    setBusy(true);
    try {
      await api.manifestSave(ws.project.root, ws.manifest);
      await ws.refresh();
      ws.toast(t("tillerdeck.json saved"));
    } catch (e) {
      ws.toast(errorText(e), true);
    } finally {
      setBusy(false);
    }
  }
  async function adopt() {
    setBusy(true);
    try {
      await api.manifestAdoptLegacy(ws.project.root);
      await ws.refresh();
      ws.toast(t("Renamed to tillerdeck.json"));
    } catch (e) {
      ws.toast(errorText(e), true);
    } finally {
      setBusy(false);
    }
  }
  // o ficheiro do tempo do Ansible Mario: propõe-se renomeá-lo
  if (ws.state.legacyFile) {
    return (
      <div className="flex shrink-0 items-center gap-3 border-b hair px-5 py-2 text-[12.5px]" style={{ background: "color-mix(in srgb, var(--w-accent) 9%, transparent)" }}>
        <Sparkles size={14} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-fg-2">{t("This project has ansible-mario.json, the old name of the settings file. Rename it to use your settings.")}</span>
        <button className="b b-sm b-pri" disabled={busy} onClick={adopt}>{t("Rename to tillerdeck.json")}</button>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-3 border-b hair px-5 py-2 text-[12.5px]" style={{ background: "color-mix(in srgb, var(--w-accent) 9%, transparent)" }}>
      <Sparkles size={14} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate text-fg-2">{t("Automatic setup, read from {from}. Nothing is saved in the project yet.", { from })}</span>
      <button className="b b-sm" onClick={() => openSettings(ws.go, "products")}>{t("Review")}</button>
      <button className="b b-sm b-pri" disabled={busy} onClick={save}>{t("Save tillerdeck.json")}</button>
    </div>
  );
}
