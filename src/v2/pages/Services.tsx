import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CircleCheck, CircleX, Construction, FileCode2, GitCompareArrows, Lock, Rocket, Sparkles, TriangleAlert, Undo2, X } from "lucide-react";
import { api, errorText, type Product, type Revision, type Service } from "../../api";
import { actionMeta, canRun, runServiceAction, useWs } from "../context";
import { cmpVersion, commitOf, lastRun, maintenanceKey, maintenanceState, productOn, serviceKey, shortVersion, versionOf, where } from "../lib";
import { EnvDot, Modal, TechIcon, Tint, techLabel } from "../ui";
import { relTime, t, tn } from "../i18n";
import { promoteServices } from "./Promote";

type Filter = "all" | "apps" | "infra" | "diff";

/** O outro lado da promoção, visto deste servidor. */
function otherSide(ws: ReturnType<typeof useWs>) {
  const promo = ws.manifest.promotion[0];
  if (!promo) return { promo: undefined, other: undefined };
  const otherId = promo.from === ws.env.id ? promo.to : promo.to === ws.env.id ? promo.from : undefined;
  return { promo, other: ws.manifest.environments.find((e) => e.id === otherId) };
}

export function Services({ productId }: { productId?: string }) {
  const ws = useWs();
  const { manifest: m, env } = ws;
  const [filter, setFilter] = useState<Filter>("all");
  const { promo, other } = otherSide(ws);

  const products = m.products.filter((p) => productOn(p, env.id) && (!productId || p.id === productId));
  const versionHere = (p: Product, s: Service) => versionOf(ws.state.releases, where(p, env), s);
  const versionThere = (p: Product, s: Service) => (other && productOn(p, other.id) ? versionOf(ws.state.releases, where(p, other), s) : undefined);
  const differs = (p: Product, s: Service) => {
    const a = versionHere(p, s), b = versionThere(p, s);
    return !!a && !!b && cmpVersion(a, b) !== 0;
  };
  const apps = products.flatMap((p) => p.services.filter((s) => s.releaseKey).map((s) => ({ p, s })));
  const nDiff = apps.filter(({ p, s }) => differs(p, s)).length;

  const all = products.flatMap((p) => p.services.map((s) => ({ p, s })));
  const firstApp = all.find(({ s }) => s.releaseKey) ?? all[0];
  const selectedKey = ws.selected && all.some(({ p, s }) => serviceKey(p, s) === ws.selected) ? ws.selected : firstApp ? serviceKey(firstApp.p, firstApp.s) : null;
  const sel = all.find(({ p, s }) => serviceKey(p, s) === selectedKey);

  const mine = (h: (typeof ws.history)[number]) => h.root === ws.project.root && h.meta?.env === env.id;
  const lastDeploy = useMemo(() => ws.history.find((h) => mine(h) && h.meta?.action === "deploy" && h.exitCode === 0), [ws.history, env.id]);
  const failures = ws.history.filter((h) => mine(h) && h.endedAt && h.exitCode !== 0 && !h.cancelled && Date.now() - new Date(h.startedAt).getTime() < 7 * 864e5).length;
  const closed = all.filter(({ p, s }) => {
    const mk = maintenanceKey(s);
    const flag = mk ? ws.maint[where(p, env).inventory]?.[mk] : undefined;
    return maintenanceState(ws.history, ws.project.root, env.id, serviceKey(p, s), flag).closed;
  }).length;

  const stat = (n: string | number, label: string, color?: string) => (
    <div className="min-w-[96px]">
      <p className="text-[22px] font-semibold tracking-tight tabular-nums" style={{ color }}>{n}</p>
      <p className="whitespace-nowrap text-[12px] text-fg-2">{label}</p>
    </div>
  );
  const show = (p: Product, s: Service) =>
    filter === "all" || (filter === "apps" && !!s.releaseKey) || (filter === "infra" && !s.releaseKey) || (filter === "diff" && differs(p, s));

  return (
    <>
      <section className="scroll relative min-w-0 flex-1 overflow-auto px-6 pb-24 pt-5">
        {!productId && (
          <div className={`raise glow-${env.color} relative overflow-hidden px-6 py-5`}>
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <EnvDot env={env} size={9} />
                  <h2 className="text-[20px] font-semibold tracking-tight">{env.label}</h2>
                  {env.protected && <Tint color="var(--env-production)"><Lock size={11} />{t("protected")}</Tint>}
                </div>
                <p className="mt-1 truncate font-mono text-[12px] text-fg-3 selectable">{[env.inventory, env.release].filter(Boolean).join(" · ")}</p>
              </div>
              {promo && other && nDiff > 0 && (
                promo.from === env.id ? (
                  <button className="b b-pri" onClick={() => ws.go("promover")}>
                    <GitCompareArrows size={16} />{t("Promote {n} to {env}", { n: nDiff, env: other.label })}<ArrowRight size={16} />
                  </button>
                ) : (
                  <button className="b" onClick={() => ws.go("promover")}><GitCompareArrows size={16} />{tn(nDiff, "{n} differs from {env} — review", "{n} differ from {env} — review", { env: other.label })}</button>
                )
              )}
            </div>
            <div className="mt-5 flex flex-wrap gap-x-10 gap-y-3">
              {stat(all.length, t("services"))}
              {other && stat(nDiff, t("differ from {env}", { env: other.label }), nDiff ? (promo?.from === env.id ? "var(--w-accent)" : "var(--env-staging)") : undefined)}
              {stat(lastDeploy ? relTime(lastDeploy.endedAt) : "—", t("last deploy from here"))}
              {stat(closed, t("closed to the public"), closed ? "var(--warn)" : undefined)}
              {stat(failures, t("failures in 7 days"), failures ? "var(--danger)" : undefined)}
            </div>
          </div>
        )}

        <div className={`flex items-center gap-2 ${productId ? "" : "mt-6"}`}>
          <div className="seg">
            {(["all", "apps", "infra", "diff"] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {{ all: t("All"), apps: t("Apps"), infra: t("Infra"), diff: t("Different") }[f]}
              </button>
            ))}
          </div>
          <span className="ml-auto hidden text-[12px] text-fg-3 lg:inline">{t("Click a service to see everything")}</span>
        </div>

        <div className="mt-4 space-y-6">
          {products.length === 0 && <p className="px-1 text-fg-3">{t("No products on this server.")}</p>}
          {products.map((p) => {
            const appRows = p.services.filter((s) => s.releaseKey && show(p, s));
            const infra = p.services.filter((s) => !s.releaseKey && show(p, s));
            if (!appRows.length && !infra.length) return null;
            return (
              <div key={p.id}>
                <div className="mb-2 flex items-baseline gap-2 px-1">
                  <h3 className="text-[14px] font-semibold">{p.label}</h3>
                  <span className="truncate text-[12.5px] text-fg-3">{p.description}</span>
                </div>
                <div className="space-y-1">
                  {appRows.map((s) => (
                    <Row key={s.id} p={p} s={s} differs={differs(p, s)} selected={serviceKey(p, s) === selectedKey} />
                  ))}
                </div>
                {infra.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
                    {infra.map((s) => {
                      const key = serviceKey(p, s);
                      const on = key === selectedKey;
                      return (
                        <button
                          key={s.id}
                          onClick={() => ws.select(key)}
                          className="flex items-center gap-2 rounded-[10px] py-1.5 pl-1.5 pr-3 text-[12.5px]"
                          style={{
                            background: on ? "color-mix(in srgb, var(--w-accent) 12%, var(--w-raise))" : "var(--w-raise)",
                            boxShadow: `0 0 0 1px ${on ? "color-mix(in srgb, var(--w-accent) 45%, transparent)" : "var(--w-line)"}`,
                          }}
                        >
                          <TechIcon kind={s.kind} size="sm" />
                          {s.label}
                          {s.description && <span className="text-fg-3">· {s.description}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
      {sel && <Inspector p={sel.p} s={sel.s} />}
    </>
  );
}

function Status({ p, s, differs }: { p: Product; s: Service; differs: boolean }) {
  const ws = useWs();
  const env = ws.env;
  const key = serviceKey(p, s);
  const mk = maintenanceKey(s);
  const ms = maintenanceState(ws.history, ws.project.root, env.id, key, mk ? ws.maint[where(p, env).inventory]?.[mk] : undefined);
  const last = lastRun(ws.history, ws.project.root, env.id, key);
  const { promo } = otherSide(ws);
  const running = Object.values(ws.runs).some((r) => r.running && r.entry.meta?.service === key && r.entry.meta?.env === env.id);
  if (running) return <Tint color="var(--w-accent)"><span className="size-1.5 animate-pulse rounded-full bg-accent" />{t("Running")}</Tint>;
  if (ms.closed) return <span title={ms.source === "action" ? t("from the last action run here") : t("from the inventory")}><Tint color="var(--warn)"><Construction size={12} />{t("Closed")}</Tint></span>;
  if (last && last.endedAt && last.exitCode !== 0 && !last.cancelled) return <Tint color="var(--danger)"><CircleX size={12} />{t("Failed")}</Tint>;
  if (differs && promo?.from === env.id) return <Tint color="var(--w-accent)"><Sparkles size={12} />{t("Ready to promote")}</Tint>;
  if (differs && promo?.to === env.id) {
    // a produção pode estar À FRENTE (um deploy feito com versão escolhida)
    const from = ws.manifest.environments.find((e) => e.id === promo.from);
    const d = from ? cmpVersion(versionOf(ws.state.releases, where(p, from), s), versionOf(ws.state.releases, where(p, env), s)) : null;
    if (d !== null && d < 0) return <Tint color="var(--ok)"><Sparkles size={12} />{t("Ahead of {env}", { env: from!.label })}</Tint>;
    return <Tint color="var(--env-staging)"><TriangleAlert size={12} />{t("Behind")}</Tint>;
  }
  return <span className="pill bg-raise-2 text-fg-2"><span className="size-1.5 rounded-full bg-ok" />{t("Stable")}</span>;
}

function Row({ p, s, differs, selected }: { p: Product; s: Service; differs: boolean; selected: boolean }) {
  const ws = useWs();
  const env = ws.env;
  const key = serviceKey(p, s);
  const tag = versionOf(ws.state.releases, where(p, env), s);
  const last = lastRun(ws.history, ws.project.root, env.id, key);
  return (
    <div className={`row group flex items-center gap-4 px-3 py-2.5 ${selected ? "sel" : ""}`} onClick={() => ws.select(key)}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <TechIcon kind={s.kind} />
        <div className="min-w-0">
          <p className="truncate whitespace-nowrap text-[14px] font-medium">{s.label}</p>
          <p className="truncate whitespace-nowrap text-[12px] text-fg-3">{techLabel(s.kind)}</p>
        </div>
      </div>
      <span className="chip-env shrink-0"><EnvDot env={env} size={6} /><span className="font-mono">{tag ? shortVersion(tag) : "—"}</span></span>
      <div className="w-[160px] shrink-0"><Status p={p} s={s} differs={differs} /></div>
      <div className="hidden w-[76px] shrink-0 whitespace-nowrap text-[12.5px] text-fg-2 min-[1320px]:block">{last?.endedAt ? relTime(last.endedAt) : "—"}</div>
      <div className={`flex w-[96px] shrink-0 items-center justify-end ${selected ? "" : "opacity-0 group-hover:opacity-100"}`}>
        {canRun(ws, p, s, "deploy") && (
          <button className={`b b-sm ${env.protected ? "b-prod" : "b-pri"}`} onClick={(e) => { e.stopPropagation(); runServiceAction(ws, p, s, "deploy"); }}>
            <Rocket size={14} />{t("Deploy")}
          </button>
        )}
      </div>
    </div>
  );
}

function Inspector({ p, s }: { p: Product; s: Service }) {
  const ws = useWs();
  const { env } = ws;
  const key = serviceKey(p, s);
  const [rollback, setRollback] = useState(false);
  const w = where(p, env);
  const { promo, other } = otherSide(ws);
  const here = versionOf(ws.state.releases, w, s);
  const there = other && productOn(p, other.id) ? versionOf(ws.state.releases, where(p, other), s) : undefined;
  const d = here && there ? cmpVersion(here, there) : 0;
  const mk = maintenanceKey(s);
  const ms = maintenanceState(ws.history, ws.project.root, env.id, key, mk ? ws.maint[w.inventory]?.[mk] : undefined);
  const lastDeploy = lastRun(ws.history, ws.project.root, env.id, key, "deploy");
  const activity = ws.history.filter((h) => h.root === ws.project.root && h.meta?.service === key).slice(0, 6);
  const acts = ["migrate", "seed", "maintenanceOn", "maintenanceOff"].filter((a) => s.actions[a]);

  return (
    <aside className="scroll w-[372px] shrink-0 overflow-auto border-l hair px-5 pb-6 pt-5">
      <div className="flex items-center gap-3.5">
        <TechIcon kind={s.kind} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[17px] font-semibold tracking-tight">{s.label}</p>
          <p className="truncate text-[12.5px] text-fg-2">{techLabel(s.kind)} · {p.label}{s.description ? ` · ${s.description}` : ""}</p>
        </div>
        {ms.closed !== undefined && (
          <span title={ms.source === "action" ? t("from the last action run here") : t("from the inventory")}>
            {ms.closed ? <Tint color="var(--warn)"><Construction size={12} />{t("Closed")}</Tint> : <Tint color="var(--ok)">{t("Open")}</Tint>}
          </span>
        )}
      </div>

      {s.releaseKey && (
        <div className="mt-5 rounded-xl bg-raise p-4" style={{ boxShadow: `0 0 0 1px color-mix(in srgb, var(--env-${env.color}) 40%, transparent)` }}>
          <p className="flex items-center gap-2 text-[12px] text-fg-2"><EnvDot env={env} size={6} />{t("Version on {env}", { env: env.label })}</p>
          <p className="mt-1.5 truncate font-mono text-[24px] font-medium tracking-tight">{here ? shortVersion(here) : "—"}</p>
          <p className="truncate text-[11.5px] text-fg-3">
            <span className="font-mono">{commitOf(here)}</span>
            {lastDeploy?.endedAt ? ` · ${t("deployed {when}", { when: relTime(lastDeploy.endedAt) })}` : ""}
            {` · ${w.release ?? ""}`}
          </p>
        </div>
      )}
      {other && there && d !== 0 && (
        <button
          className="mt-2 flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[12.5px]"
          style={{ background: "color-mix(in srgb, var(--w-accent) 10%, transparent)", color: "var(--w-accent)" }}
          onClick={() => (promo?.from === env.id ? promoteServices(ws, [{ p, s }]) : ws.setEnv(other.id))}
        >
          <Sparkles size={14} />
          {t("{env} has {v}", { env: other.label, v: shortVersion(there) })}
          <span className="ml-auto font-medium">{promo?.from === env.id ? t("Promote") : t("See {env}", { env: other.label })}</span>
        </button>
      )}

      <p className="sec-h mb-2 mt-6">{t("Actions on {env}", { env: env.label })}</p>
      <div className="grid grid-cols-2 gap-2">
        {s.actions.deploy && (
          <button
            className="tile col-span-2 !flex-row items-center"
            disabled={!canRun(ws, p, s, "deploy")}
            onClick={() => runServiceAction(ws, p, s, "deploy")}
            style={{
              background: `linear-gradient(135deg, color-mix(in srgb, ${env.protected ? "var(--env-production)" : "var(--w-accent)"} 22%, transparent), transparent)`,
              boxShadow: `0 0 0 1px color-mix(in srgb, ${env.protected ? "var(--env-production)" : "var(--w-accent)"} 45%, transparent)`,
            }}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-[10px] text-white" style={{ background: env.protected ? "#d94343" : "var(--w-accent)" }}><Rocket size={17} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold">{t("Deploy")}</span>
              <span className="block truncate text-[12px] text-fg-2">
                {!canRun(ws, p, s, "deploy") ? t("not available on {env}", { env: env.label }) : here ? t("installs {v} from the release", { v: shortVersion(here) }) : t("applies the configuration")}
              </span>
            </span>
          </button>
        )}
        {acts.map((a) => {
          const meta = actionMeta(a);
          const ok = canRun(ws, p, s, a);
          const current = (a === "maintenanceOn" && ms.closed === true) || (a === "maintenanceOff" && ms.closed === false);
          return (
            <button key={a} className="tile" disabled={!ok} onClick={() => runServiceAction(ws, p, s, a)}>
              <span className="flex items-center justify-between">
                <span className="grid size-8 place-items-center rounded-[9px] bg-raise-2">{meta.icon}</span>
                {current && <span className="text-[11px] text-fg-3">{t("current")}</span>}
              </span>
              <span><span className="block text-[13px] font-medium">{meta.label}</span><span className="block text-[11.5px] text-fg-3">{!ok ? t("not available on {env}", { env: env.label }) : s.actions[a]?.includesDeploy ? (a === "seed" ? t("deploys, migrates and seeds") : t("deploys and migrates")) : meta.sub}</span></span>
            </button>
          );
        })}
        {s.releaseKey && w.release && (
          <button className="tile" onClick={() => setRollback(true)}>
            <span className="grid size-8 place-items-center rounded-[9px] bg-raise-2"><Undo2 size={16} /></span>
            <span><span className="block text-[13px] font-medium">{t("Previous version")}</span><span className="block text-[11.5px] text-fg-3">{t("from git history")}</span></span>
          </button>
        )}
      </div>

      <div className="mt-3 space-y-1 text-[12px] text-fg-3">
        {s.container && <p>{t("Container")} <span className="font-mono text-fg-2 selectable">{s.container}</span></p>}
        {s.releaseKey && <p>{t("Version in")} <span className="font-mono text-fg-2">{w.release}</span> · <span className="font-mono text-fg-2">{s.releaseKey}</span></p>}
        {s.actions.deploy?.make && <p>{t("Deploy")} <span className="font-mono text-fg-2 selectable">make {s.actions.deploy.make.replace("{env}", w.token)}</span></p>}
        {ms.source !== "unknown" && <p>{t("Maintenance state")}: {ms.source === "action" ? t("from the last action run here") : t("from the inventory")} ({w.inventory})</p>}
      </div>

      <p className="sec-h mb-2 mt-6">{t("Activity")}</p>
      {activity.length === 0 ? (
        <p className="text-[12.5px] text-fg-3">{t("Nothing run from the app yet.")}</p>
      ) : (
        <div className="relative space-y-3 pl-5 text-[12.5px]">
          <span className="absolute bottom-1 left-[5px] top-1 w-px bg-line-2" />
          {activity.map((h) => {
            const ok = h.exitCode === 0;
            const e = ws.manifest.environments.find((x) => x.id === h.meta?.env);
            return (
              <button key={h.id} className="relative block w-full text-left" onClick={() => ws.focusRun(h.id)}>
                <span className="absolute -left-5 top-1 size-[11px] rounded-full" style={{ background: !h.endedAt ? "var(--w-accent)" : ok ? "var(--ok)" : h.cancelled ? "var(--warn)" : "var(--danger)", boxShadow: "0 0 0 3px var(--w-panel)" }} />
                <p className="font-medium">
                  {h.meta?.title.split(" · ")[0]}
                  {h.meta?.action === "deploy" && h.meta?.version ? ` ${shortVersion(h.meta.version)}` : ""} {e && <span className="font-normal text-fg-3">· {e.label}</span>}
                </p>
                <p className="text-fg-3">{relTime(h.startedAt)}{h.endedAt && !ok ? (h.cancelled ? ` · ${t("cancelled")}` : ` · ${t("failed")}`) : ""}</p>
              </button>
            );
          })}
        </div>
      )}
      {rollback && <Rollback p={p} s={s} onClose={() => setRollback(false)} />}
    </aside>
  );
}

function Rollback({ p, s, onClose }: { p: Product; s: Service; onClose: () => void }) {
  const ws = useWs();
  const w = where(p, ws.env);
  const [revs, setRevs] = useState<Revision[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const current = versionOf(ws.state.releases, w, s);
  useEffect(() => {
    api.releaseHistory(ws.project.root, w.release!, s.releaseKey!).then(setRevs).catch((e) => setErr(errorText(e)));
  }, []);
  return (
    <Modal onClose={onClose} width={560}>
      <div className="p-6">
        <div className="flex items-center gap-3">
          <TechIcon kind={s.kind} size="lg" />
          <div className="min-w-0 flex-1"><p className="text-[16px] font-semibold">{t("Go back to a previous version")}</p><p className="truncate text-[12.5px] text-fg-2">{s.label} · {ws.env.label} · {w.release}</p></div>
          <button className="ib" onClick={onClose}><X size={16} /></button>
        </div>
        <p className="mt-4 text-[12.5px] text-fg-2">{t("Pick a version from git history. The app rewrites the {key} line in the release and deploys — if the deploy fails, the line goes back to what it was.", { key: s.releaseKey! })}</p>
        <div className="scroll mt-4 max-h-[340px] space-y-1 overflow-auto">
          {err && <p className="text-danger">{err}</p>}
          {!revs && !err && <p className="text-fg-3">{t("reading git…")}</p>}
          {revs?.map((r) => {
            const cur = r.value === current;
            return (
              <button key={r.commit + r.value} disabled={cur} className="row flex w-full items-center gap-3 px-3 py-2.5 text-left disabled:opacity-60"
                onClick={() => { onClose(); promoteServices(ws, [{ p, s }], { value: r.value, title: t("Roll back") }); }}>
                {cur ? <CircleCheck size={16} className="text-ok" /> : <Undo2 size={16} className="text-fg-3" />}
                <span className="w-28 font-mono text-[14px]">{r.short}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">{r.subject}</span>
                <span className="text-[12px] text-fg-3">{cur ? t("installed") : r.date}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-5 flex justify-start">
          <button className="b b-ghost" onClick={() => { onClose(); ws.go("ficheiros"); }}><FileCode2 size={14} />{t("Open the release file")}</button>
        </div>
      </div>
    </Modal>
  );
}
