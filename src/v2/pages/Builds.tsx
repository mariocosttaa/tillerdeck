import { useEffect, useMemo, useState } from "react";
import { GitCommitHorizontal, Package, RefreshCw, Rocket } from "lucide-react";
import { canRun, useWs } from "../context";
import { productOn, serviceKey, shortVersion, versionOf, where } from "../lib";
import { EnvDot, Select, TechIcon } from "../ui";
import { relTime, t } from "../i18n";
import { cached, formatSize, loadChoices, loadError, sourceLabel, versionSource, type Choice } from "../versions";

/**
 * As builds recentes de cada serviço (tags do registry ou commits), com a
 * data, o commit e onde cada uma está instalada. Daqui faz-se o deploy de
 * qualquer uma no servidor escolhido em cima.
 */
export function Builds() {
  const ws = useWs();
  const { manifest: m, env } = ws;
  const items = useMemo(
    () => m.products.filter((p) => productOn(p, env.id)).flatMap((p) => p.services.filter((s) => versionSource(ws, s)).map((s) => ({ p, s }))),
    [m, env.id],
  );
  const [key, setKey] = useState(() => localStorage.getItem(`tillerdeck.builds.${ws.project.root}`) ?? "");
  const cur = items.find((x) => serviceKey(x.p, x.s) === key) ?? items[0];
  const [list, setList] = useState<Choice[] | null>(null);
  const [at, setAt] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (force = false) => {
    if (!cur) return;
    const hit = !force && cached(ws, cur.p, cur.s, env);
    if (hit) { setList(hit.list); setAt(hit.at); setError(null); return; }
    setLoading(true);
    setError(null);
    loadChoices(ws, cur.p, cur.s, env, force)
      .then((r) => { setList(r.list); setAt(r.at); })
      .catch((e) => { setList(null); setError(loadError(e)); })
      .finally(() => setLoading(false));
  };
  useEffect(() => { setList(null); load(); }, [cur && serviceKey(cur.p, cur.s), env.id]);

  if (!cur) {
    return (
      <div className="max-w-xl p-10 text-fg-2">
        <p className="text-[15px] font-semibold text-fg">{t("No service has a version source")}</p>
        <p className="mt-2">{t("In Settings → Products, give a service an image in the registry (and the registry URL in General), or a git repository. Then its builds show here.")}</p>
      </div>
    );
  }
  const { p, s } = cur;
  // sempre por data, da mais recente para a mais antiga; sem data, no fim
  const when = (c: Choice) => (c.date ? Date.parse(c.date) || 0 : 0);
  const sorted = list ? [...list].sort((a, b) => when(b) - when(a)) : null;
  const src = versionSource(ws, s)!;
  const servers = m.environments.filter((e) => productOn(p, e.id));
  const deployable = canRun(ws, p, s, "deploy");
  const choose = (k: string) => {
    setKey(k);
    try { localStorage.setItem(`tillerdeck.builds.${ws.project.root}`, k); } catch { /* sem armazenamento */ }
  };

  return (
    <section className="scroll min-w-0 flex-1 overflow-auto px-6 pb-8 pt-5">
      <div className="flex items-center gap-3">
        <Select
          className="w-[260px] shrink-0"
          value={serviceKey(p, s)}
          onChange={choose}
          options={items.map((x) => ({ value: serviceKey(x.p, x.s), label: x.s.label, hint: x.p.label }))}
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3"><Package size={13} className="mr-1 inline" />{sourceLabel(ws, src, s)}{src.tagFormat ? ` · ${src.tagFormat}` : ""}</span>
        <span className="shrink-0 text-[12px] text-fg-3">{at ? t("updated {when}", { when: relTime(new Date(at).toISOString()) }) : ""}</span>
        <button className="b b-sm shrink-0" onClick={() => load(true)} disabled={loading}><RefreshCw size={13} className={loading ? "animate-spin" : ""} />{t("Refresh")}</button>
      </div>

      <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(servers.length, 3)}, minmax(0,1fr))` }}>
        {servers.map((e) => {
          const v = versionOf(ws.state.releases, where(p, e), s);
          return (
            <div key={e.id} className="raise flex items-center gap-3 px-4 py-3">
              <EnvDot env={e} size={8} />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-fg-3">{t("Installed on {env}", { env: e.label })}</span>
                <span className="block truncate font-mono text-[14px] font-medium">{shortVersion(v) || "—"}</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="raise mt-4 overflow-hidden">
        <div className="flex items-center gap-3 border-b hair px-4 py-2.5 text-[11.5px] font-medium text-fg-3">
          <TechIcon kind={s.kind} size="sm" />
          <span className="flex-1">{src.source === "git" ? t("Recent commits") : t("Recent builds")}</span>
          <span className="w-[110px] text-right">{t("Built")}</span>
          <span className="w-[150px]" />
        </div>
        {loading && !list && <p className="px-4 py-8 text-center text-fg-3">{src.source === "git" ? t("reading the commits…") : t("asking the registry…")}</p>}
        {error && <p className="px-4 py-5 text-warn selectable">{error}</p>}
        {list && !list.length && <p className="px-4 py-8 text-center text-fg-3">{t("No builds match the tag format.")}</p>}
        {sorted?.map((c) => {
          const here = servers.filter((e) => versionOf(ws.state.releases, where(p, e), s) === c.value);
          const isHere = here.some((e) => e.id === env.id);
          return (
            <div key={c.value} className="group flex items-center gap-3 border-b hair px-4 py-2.5 last:border-0 hover:bg-raise-2">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13.5px] font-medium">{c.version ?? c.commit ?? shortVersion(c.value)}</span>
                  {c.commit && c.version && <span className="pill !h-5 bg-raise-2 font-mono text-[11px] text-fg-2"><GitCommitHorizontal size={11} />{c.commit}</span>}
                  {here.map((e) => (
                    <span key={e.id} className="pill !h-5 text-[11px]" style={{ color: `var(--env-${e.color})`, background: `color-mix(in srgb, var(--env-${e.color}) 14%, transparent)` }}><EnvDot env={e} size={6} />{e.label}</span>
                  ))}
                </span>
                <span className="block truncate font-mono text-[11.5px] text-fg-3 selectable">{c.title ?? c.value}</span>
              </span>
              <span className="w-[110px] text-right text-[12px] text-fg-2" title={c.date ? new Date(c.date).toLocaleString() : ""}>
                {c.date ? relTime(c.date) : "—"}
                <span className="block text-[11px] text-fg-3">{c.size ? formatSize(c.size) : c.author ?? ""}</span>
              </span>
              <span className="flex w-[150px] justify-end">
                <button
                  className={`b b-sm opacity-0 group-hover:opacity-100 focus:opacity-100 ${env.protected ? "b-prod" : "b-pri"}`}
                  disabled={!deployable}
                  title={deployable ? "" : t("not available on {env}", { env: env.label })}
                  onClick={() => ws.openDeploy({ p, s, action: "deploy", preset: c.value })}
                >
                  <Rocket size={13} />{isHere ? t("Redeploy") : t("Deploy to {env}", { env: env.label })}
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11.5px] text-fg-3">{t("Dates and commits come from the image (OCI labels) when it has them, otherwise from the tag format. The list is read when you open it or press Refresh.")}</p>
    </section>
  );
}
