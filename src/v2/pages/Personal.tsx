import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { CloudUpload, GitBranch, GitCommitHorizontal, Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { siGithub } from "simple-icons";
import { api, errorText, type GitRemote } from "../../api";
import { useWs } from "../context";
import { Select, Tint } from "../ui";
import { t, tn } from "../i18n";
import type { Theme } from "../prefs";
import { commitMessage, commitReleases, dirtyReleases, loadGit, pushIfWanted, saveGit, type AfterDeploy, type GitPrefs } from "../git";

let cachedVersion: string | null = null;
/** A versão da app, lida do binário. */
export function useAppVersion() {
  const [v, setV] = useState(cachedVersion);
  useEffect(() => {
    if (cachedVersion) return;
    getVersion()
      .then((x) => { cachedVersion = x; setV(x); })
      .catch(() => {});
  }, []);
  return v;
}

function Card({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="raise p-5">
      <p className="text-[14px] font-semibold">{title}</p>
      {sub && <p className="mt-0.5 text-[12.5px] text-fg-3">{sub}</p>}
      <div className="mt-4">{children}</div>
    </div>
  );
}

function Choice({ on, onClick, icon, label, hint }: { on: boolean; onClick: () => void; icon?: ReactNode; label: string; hint?: string }) {
  return (
    <button
      className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-4 py-3 text-left ring-1"
      style={on ? { background: "color-mix(in srgb, var(--w-accent) 14%, var(--w-raise))", boxShadow: "0 0 0 1px color-mix(in srgb, var(--w-accent) 55%, transparent)" } : { boxShadow: "0 0 0 1px var(--w-line)" }}
      onClick={onClick}
    >
      {icon && <span className={on ? "text-accent" : "text-fg-3"}>{icon}</span>}
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{label}</span>
        {hint && <span className="block truncate text-[11.5px] text-fg-3">{hint}</span>}
      </span>
    </button>
  );
}

/** Idioma, tema, actualização e a versão da app. Ficam neste computador. */
export function Preferences() {
  const ws = useWs();
  const p = ws.prefs;
  const version = useAppVersion();
  const themes: [Theme, ReactNode, string, string][] = [
    ["auto", <Monitor size={18} />, t("Auto"), t("follows the system")],
    ["light", <Sun size={18} />, t("Light"), ""],
    ["dark", <Moon size={18} />, t("Dark"), ""],
  ];
  return (
    <div className="grid max-w-[860px] gap-4">
      <Card title={t("Language")}>
        <div className="flex flex-wrap gap-2">
          <Choice on={p.lang === "en"} onClick={() => ws.setPrefs({ ...p, lang: "en" })} label="English" />
          <Choice on={p.lang === "pt"} onClick={() => ws.setPrefs({ ...p, lang: "pt" })} label="Português" />
        </div>
      </Card>
      <Card title={t("Theme")}>
        <div className="flex flex-wrap gap-2">
          {themes.map(([v, icon, label, hint]) => <Choice key={v} on={p.theme === v} onClick={() => ws.setPrefs({ ...p, theme: v })} icon={icon} label={label} hint={hint} />)}
        </div>
      </Card>
      <Card title={t("Refresh automatically")} sub={t("Reads releases, history and the inventory — never connects to the servers.")}>
        <Select
          className="w-[240px]"
          value={String(p.refreshMin)}
          onChange={(v) => ws.setPrefs({ ...p, refreshMin: Number(v) })}
          options={[0, 1, 3, 5, 10, 30].map((n) => ({ value: String(n), label: n === 0 ? t("Off") : t("Every {n} min", { n }) }))}
        />
      </Card>
      <Card title={t("About")}>
        <p className="text-[13px] text-fg-2">Ansible Mario <span className="font-mono text-fg">{version ? `v${version}` : "—"}</span></p>
        <p className="mt-1 text-[12px] text-fg-3">{t("These preferences are saved on this computer only.")}</p>
      </Card>
    </div>
  );
}

/** Guardar os releases no git: local agora, a ligação ao GitHub mais tarde. */
export function GitSettings() {
  const ws = useWs();
  const root = ws.project.root;
  const [g, setG] = useState<GitPrefs>(() => loadGit(root));
  const [r, setR] = useState<GitRemote | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api.gitRemote(root).then((x) => { setR(x); setErr(null); }).catch((e) => setErr(errorText(e)));
  useEffect(() => { load(); }, [root, ws.refreshedAt]);
  const set = (next: GitPrefs) => { setG(next); saveGit(root, next); };
  const dirty = dirtyReleases(ws);
  const target = g.branch || r?.branch || "";
  const wrongBranch = !!(g.branch && r?.branch && g.branch !== r.branch);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); load(); }
  }

  const modes: [AfterDeploy, string, string][] = [
    ["off", t("Nothing"), t("the release file changes; you commit it")],
    ["commit", t("Commit"), t("a local commit of the release file")],
    ["push", t("Commit and push"), t("then pushes the chosen branch")],
  ];

  if (!ws.state.git.branch && !r?.branch) {
    return <div className="max-w-xl text-fg-2">{t("The project isn't a git repository")}</div>;
  }

  return (
    <div className="grid max-w-[860px] gap-4">
      <Card title={t("Repository")}>
        <div className="grid gap-x-6 gap-y-2 text-[13px] md:grid-cols-[140px_1fr]">
          <span className="text-fg-3">{t("Current branch")}</span>
          <span className="flex items-center gap-2 font-mono"><GitBranch size={14} className="text-fg-3" />{r?.branch ?? "—"}</span>
          <span className="text-fg-3">{t("Remote")}</span>
          <span className="truncate font-mono text-fg-2 selectable">{r?.remote ? `${r.remote} · ${r.url ?? ""}` : t("none")}</span>
          <span className="text-fg-3">{t("Upstream")}</span>
          <span className="font-mono text-fg-2">
            {r?.upstream ?? t("not set — the first push sets it")}
            {r && r.ahead > 0 && <Tint className="ml-2" color="var(--w-accent)">{tn(r.ahead, "{n} commit to push", "{n} commits to push")}</Tint>}
            {r && r.behind > 0 && <Tint className="ml-2" color="var(--warn)">{tn(r.behind, "{n} behind", "{n} behind")}</Tint>}
          </span>
        </div>
        {err && <p className="mt-3 text-[12.5px] text-warn selectable">{err}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="b b-sm" disabled={busy || !dirty.length} onClick={() => act(() => commitReleases(ws, dirty, commitMessage.manual(dirty), g.after === "push"))}>
            <GitCommitHorizontal size={13} />{dirty.length ? tn(dirty.length, "Commit {n} release", "Commit {n} releases") : t("No release changes")}
          </button>
          <button className="b b-sm" disabled={busy || !r?.remote || !(r.ahead > 0 || !r.upstream) || wrongBranch} onClick={() => act(() => pushIfWanted(ws, true))}>
            <CloudUpload size={13} />{t("Push {branch}", { branch: target })}
          </button>
          <button className="ib !size-8" title={t("Refresh")} onClick={() => load()}><RefreshCw size={14} /></button>
        </div>
        <p className="mt-3 text-[11.5px] text-fg-3">{t("Uses the git credentials this computer already has (ssh agent or credential helper). The app never asks for a password and never force-pushes.")}</p>
      </Card>

      <Card title={t("After a deploy with a new version")} sub={t("Only when the deploy succeeds. If it fails, the release line goes back and nothing is committed.")}>
        <div className="flex flex-wrap gap-2">
          {modes.map(([v, label, hint]) => <Choice key={v} on={g.after === v} onClick={() => set({ ...g, after: v })} label={label} hint={hint} />)}
        </div>
        {g.after === "push" && (
          <div className="mt-4">
            <span className="label">{t("Branch to push")}</span>
            <Select
              className="w-[320px]"
              mono
              value={g.branch}
              onChange={(v) => set({ ...g, branch: v })}
              options={[{ value: "", label: t("the current branch ({b})", { b: r?.branch ?? "—" }) }, ...(r?.branches ?? []).map((b) => ({ value: b, label: b }))]}
            />
            {wrongBranch && <p className="mt-2 text-[12.5px] text-fg-2">{t("You're on {cur}: the commit goes straight to {b} without switching branch. Your branch and unsaved files stay as they are; only the changed release lines go.", { cur: r!.branch!, b: g.branch })}</p>}
          </div>
        )}
        <p className="mt-3 text-[11.5px] text-fg-3">{t("Messages follow Conventional Commits, for example:")} <span className="font-mono text-fg-2">{commitMessage.deploy("shop-api", "1.4.0", "Production")}</span></p>
      </Card>

      <div className="raise flex items-center gap-4 p-5 opacity-70">
        <span className="grid size-10 place-items-center rounded-xl bg-raise-2"><svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor"><path d={siGithub.path} /></svg></span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold">{t("Connect GitHub")}</span>
          <span className="block text-[12.5px] text-fg-3">{t("Authorise the app and commit through the GitHub API, without a local push.")}</span>
        </span>
        <Tint color="var(--w-accent)">{t("Coming soon")}</Tint>
      </div>
    </div>
  );
}
