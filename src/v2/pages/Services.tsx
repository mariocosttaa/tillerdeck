import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight, CircleCheck, CircleX, Construction, Ellipsis, FileCode2, GitCompareArrows, Lock, Rocket, Sparkles, Undo2,
} from "lucide-react";
import { api, errorText, type Product, type Revision, type Service } from "../../api";
import { ACTION_META, canRun, runServiceAction, useWs } from "../context";
import { cmpVersion, commitOf, lastRun, maintenanceKey, relTime, serviceKey, shortVersion } from "../lib";
import { EnvDot, Modal, TechIcon, Tint, techLabel } from "../ui";
import { promoteServices } from "./Promote";

type Filter = "todos" | "apps" | "infra" | "diferentes";

export function Services({ productId }: { productId?: string }) {
  const ws = useWs();
  const { manifest: m, env } = ws;
  const [filter, setFilter] = useState<Filter>("todos");
  const [maint, setMaint] = useState<Record<string, boolean>>({});

  // O estado de manutenção vem do inventário do ambiente (só as flags).
  useEffect(() => {
    let live = true;
    setMaint({});
    api.maintenanceState(ws.project.root, env.inventory).then((x) => live && setMaint(x)).catch(() => {});
    return () => {
      live = false;
    };
  }, [env.id, ws.project.root]);

  const promo = m.promotion.find((p) => p.from === env.id || p.to === env.id);
  const other = promo ? (promo.from === env.id ? promo.to : promo.from) : undefined;
  const otherEnv = m.environments.find((e) => e.id === other);
  const rel = ws.state.releases[env.id] ?? {};
  const orel = other ? ws.state.releases[other] ?? {} : {};

  const products = productId ? m.products.filter((p) => p.id === productId) : m.products;
  const apps = products.flatMap((p) => p.services.filter((s) => s.releaseKey).map((s) => ({ p, s })));
  const diff = (s: Service) => (s.releaseKey && other ? cmpVersion(rel[s.releaseKey], orel[s.releaseKey]) : 0);
  const ahead = promo && env.id === promo.from ? apps.filter(({ s }) => (diff(s) ?? 1) !== 0) : [];
  const behind = promo && env.id === promo.to ? apps.filter(({ s }) => (diff(s) ?? 1) !== 0) : [];

  const all = products.flatMap((p) => p.services.map((s) => ({ p, s })));
  const selectedKey = ws.selected && all.some(({ p, s }) => serviceKey(p, s) === ws.selected) ? ws.selected : all.find(({ s }) => s.releaseKey) ? serviceKey(all.find(({ s }) => s.releaseKey)!.p, all.find(({ s }) => s.releaseKey)!.s) : all[0] ? serviceKey(all[0].p, all[0].s) : null;
  const sel = all.find(({ p, s }) => serviceKey(p, s) === selectedKey);

  const lastDeploy = useMemo(
    () => ws.history.find((h) => h.root === ws.project.root && h.meta?.env === env.id && h.meta?.action === "deploy" && h.exitCode === 0),
    [ws.history, env.id, ws.project.root],
  );
  const failures = ws.history.filter((h) => h.root === ws.project.root && h.meta?.env === env.id && h.endedAt && h.exitCode !== 0 && !h.cancelled && Date.now() - new Date(h.startedAt).getTime() < 7 * 864e5).length;
  const closed = Object.values(maint).filter(Boolean).length;

  const stat = (n: string | number, label: string, color?: string) => (
    <div>
      <p className="text-[22px] font-semibold tracking-tight tabular-nums" style={{ color }}>{n}</p>
      <p className="text-[12px] text-fg-2">{label}</p>
    </div>
  );

  const show = (s: Service) =>
    filter === "todos" || (filter === "apps" && !!s.releaseKey) || (filter === "infra" && !s.releaseKey) || (filter === "diferentes" && !!s.releaseKey && (diff(s) ?? 1) !== 0);

  return (
    <>
      <section className="scroll relative min-w-0 flex-1 overflow-auto px-6 pb-24 pt-5">
        {!productId && (
          <div className={`raise glow-${env.color} relative overflow-hidden px-6 py-5`}>
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <EnvDot env={env} size={9} />
                  <h2 className="text-[20px] font-semibold tracking-tight">{env.label}</h2>
                  {env.protected && <Tint color="var(--env-production)"><Lock size={11} />protegido</Tint>}
                </div>
                <p className="mt-1 truncate font-mono text-[12px] text-fg-3 selectable">{[env.inventory, env.release].filter(Boolean).join(" · ")}</p>
              </div>
              {promo && env.id === promo.from && ahead.length > 0 && (
                <button className="b b-pri" onClick={() => ws.go("promover")}>
                  <GitCompareArrows size={16} />Promover {ahead.length} para {otherEnv?.label.toLowerCase()}<ArrowRight size={16} />
                </button>
              )}
              {promo && env.id === promo.to && behind.length > 0 && (
                <button className="b" onClick={() => ws.go("promover")}><GitCompareArrows size={16} />{behind.length} diferente{behind.length > 1 ? "s" : ""} da {otherEnv?.label.toLowerCase()} — rever</button>
              )}
            </div>
            <div className="mt-5 flex flex-wrap gap-x-10 gap-y-3">
              {stat(m.products.reduce((a, p) => a + p.services.length, 0), "serviços")}
              {promo && env.id === promo.from && stat(ahead.length, `diferentes da ${otherEnv?.label.toLowerCase()}`, ahead.length ? "var(--w-accent)" : undefined)}
              {promo && env.id === promo.to && stat(behind.length, `diferentes da ${otherEnv?.label.toLowerCase()}`, behind.length ? "var(--env-staging)" : undefined)}
              {stat(lastDeploy ? relTime(lastDeploy.endedAt) : "—", "último deploy daqui")}
              {Object.keys(maint).length > 0 && stat(closed, "fechados ao público", closed ? "var(--warn)" : undefined)}
              {stat(failures, "falhas em 7 dias", failures ? "var(--danger)" : undefined)}
            </div>
          </div>
        )}

        <div className={`flex items-center gap-2 ${productId ? "" : "mt-6"}`}>
          <div className="seg">
            {(["todos", "apps", "infra", "diferentes"] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {{ todos: "Todos", apps: "Apps", infra: "Infra", diferentes: "Com diferenças" }[f]}
              </button>
            ))}
          </div>
          <span className="ml-auto text-[12px] text-fg-3">Clica num serviço para ver tudo</span>
        </div>

        <div className="mt-4 space-y-6">
          {products.map((p) => {
            const appRows = p.services.filter((s) => s.releaseKey && show(s));
            const infra = p.services.filter((s) => !s.releaseKey && show(s));
            if (!appRows.length && !infra.length) return null;
            return (
              <div key={p.id}>
                <div className="mb-2 flex items-baseline gap-2 px-1">
                  <h3 className="text-[14px] font-semibold">{p.label}</h3>
                  <span className="text-[12.5px] text-fg-3">{p.description}</span>
                </div>
                <div className="space-y-1">
                  {appRows.map((s) => (
                    <Row key={s.id} p={p} s={s} other={other} rel={rel} orel={orel} maint={maint} selected={serviceKey(p, s) === selectedKey} />
                  ))}
                </div>
                {infra.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
                    {infra.map((s) => {
                      const key = serviceKey(p, s);
                      return (
                        <button
                          key={s.id}
                          onClick={() => ws.select(key)}
                          className="flex items-center gap-2 rounded-[10px] py-1.5 pl-1.5 pr-3 text-[12.5px]"
                          style={{
                            background: key === selectedKey ? "color-mix(in srgb, var(--w-accent) 12%, var(--w-raise))" : "var(--w-raise)",
                            boxShadow: `0 0 0 1px ${key === selectedKey ? "color-mix(in srgb, var(--w-accent) 45%, transparent)" : "var(--w-line)"}`,
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
      {sel && <Inspector p={sel.p} s={sel.s} other={other} maint={maint} />}
    </>
  );
}

function Row({ p, s, other, rel, orel, maint, selected }: { p: Product; s: Service; other?: string; rel: Record<string, string>; orel: Record<string, string>; maint: Record<string, boolean>; selected: boolean }) {
  const ws = useWs();
  const env = ws.env;
  const key = serviceKey(p, s);
  const tag = rel[s.releaseKey!];
  const ot = other ? orel[s.releaseKey!] : undefined;
  const d = other ? cmpVersion(tag, ot) : 0;
  const otherEnv = ws.manifest.environments.find((e) => e.id === other);
  const mk = maintenanceKey(s);
  const closed = mk ? maint[mk] : false;
  const last = lastRun(ws.history, ws.project.root, env.id, key);
  const promo = ws.manifest.promotion.find((x) => x.from === env.id);
  const running = Object.values(ws.runs).find((r) => r.running && r.entry.meta?.service === key && r.entry.meta?.env === env.id);

  const status = running ? (
    <Tint color="var(--w-accent)"><span className="size-1.5 animate-pulse rounded-full bg-accent" />A correr</Tint>
  ) : closed ? (
    <Tint color="var(--warn)"><Construction size={12} />Fechado</Tint>
  ) : last && last.exitCode !== 0 && !last.cancelled ? (
    <Tint color="var(--danger)"><CircleX size={12} />Falhou</Tint>
  ) : promo && d !== 0 && tag && ot ? (
    <Tint color="var(--w-accent)"><Sparkles size={12} />Pronto a promover</Tint>
  ) : (
    <span className="pill bg-raise-2 text-fg-2"><span className="size-1.5 rounded-full bg-ok" />Estável</span>
  );

  return (
    <div className={`row group flex items-center gap-4 px-3 py-2.5 ${selected ? "sel" : ""}`} onClick={() => ws.select(key)}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <TechIcon kind={s.kind} />
        <div className="min-w-0">
          <p className="truncate whitespace-nowrap text-[14px] font-medium">{s.label}</p>
          <p className="truncate whitespace-nowrap text-[12px] text-fg-3">{techLabel(s.kind)}</p>
        </div>
      </div>
      <span className="chip-env shrink-0" title={otherEnv && ot && d !== 0 ? `${otherEnv.label}: ${shortVersion(ot)}` : undefined}>
        <EnvDot env={env} size={6} /><span className="font-mono">{tag ? shortVersion(tag) : "—"}</span>
      </span>
      <div className="w-[150px] shrink-0">{status}</div>
      <div className="hidden w-[72px] shrink-0 whitespace-nowrap text-[12.5px] text-fg-2 min-[1320px]:block">{last?.endedAt ? relTime(last.endedAt) : "—"}</div>
      <div className={`flex w-[96px] shrink-0 items-center justify-end gap-1 ${selected ? "" : "opacity-0 group-hover:opacity-100"}`}>
        {canRun(ws, s, "deploy") && (
          <button className={`b b-sm ${env.protected ? "b-prod" : "b-pri"}`} onClick={(e) => { e.stopPropagation(); runServiceAction(ws, p, s, "deploy"); }}>
            <Rocket size={14} />Deploy
          </button>
        )}
      </div>
    </div>
  );
}

function Inspector({ p, s, other, maint }: { p: Product; s: Service; other?: string; maint: Record<string, boolean> }) {
  const ws = useWs();
  const { env, manifest: m } = ws;
  const key = serviceKey(p, s);
  const [rollback, setRollback] = useState(false);
  const order = [env.id, other].filter(Boolean) as string[];
  const promo = m.promotion[0];
  const cards = s.releaseKey ? (promo ? [promo.from, promo.to] : order) : [];
  const d = s.releaseKey && promo ? cmpVersion(ws.state.releases[promo.from]?.[s.releaseKey], ws.state.releases[promo.to]?.[s.releaseKey]) : 0;
  const mk = maintenanceKey(s);
  const closed = mk ? maint[mk] : undefined;
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
        {closed !== undefined && (closed ? <Tint color="var(--warn)"><Construction size={12} />Fechado</Tint> : <Tint color="var(--ok)">Aberto</Tint>)}
      </div>

      {cards.length > 0 && (
        <>
          <div className="mt-5 flex items-center gap-2">
            {cards.map((id, i) => {
              const e = m.environments.find((x) => x.id === id)!;
              const v = ws.state.releases[id]?.[s.releaseKey!];
              const last = lastRun(ws.history, ws.project.root, id, key, "deploy");
              return (
                <div key={id} className="contents">
                  {i === 1 && <span className="grid size-7 shrink-0 place-items-center rounded-full bg-raise-2 text-accent"><ArrowRight size={14} /></span>}
                  <div className="min-w-0 flex-1 rounded-xl bg-raise p-3" style={{ boxShadow: `0 0 0 1px ${id === env.id ? `color-mix(in srgb, var(--env-${e.color}) 45%, transparent)` : "var(--w-line)"}` }}>
                    <p className="flex items-center gap-2 text-[12px] text-fg-2"><EnvDot env={e} size={6} />{e.label}</p>
                    <p className="mt-1.5 truncate font-mono text-[20px] font-medium tracking-tight">{v ? shortVersion(v) : "—"}</p>
                    <p className="truncate text-[11.5px] text-fg-3"><span className="font-mono">{commitOf(v)}</span>{last?.endedAt ? ` · ${relTime(last.endedAt)}` : ""}</p>
                  </div>
                </div>
              );
            })}
          </div>
          {promo && d !== 0 && ws.state.releases[promo.from]?.[s.releaseKey!] && (
            <button className="mt-2 flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[12.5px] text-accent" style={{ background: "color-mix(in srgb, var(--w-accent) 10%, transparent)" }} onClick={() => promoteServices(ws, [{ p, s }])}>
              <Sparkles size={14} />A {m.environments.find((e) => e.id === promo.from)?.label.toLowerCase()} tem outra versão<span className="ml-auto font-medium">Promover</span>
            </button>
          )}
        </>
      )}

      <p className="sec-h mb-2 mt-6">Acções em {env.label}</p>
      <div className="grid grid-cols-2 gap-2">
        {s.actions.deploy && (
          <button
            className="tile col-span-2 !flex-row items-center"
            disabled={!canRun(ws, s, "deploy")}
            onClick={() => runServiceAction(ws, p, s, "deploy")}
            style={{
              background: `linear-gradient(135deg, color-mix(in srgb, ${env.protected ? "var(--env-production)" : "var(--w-accent)"} 22%, transparent), transparent)`,
              boxShadow: `0 0 0 1px color-mix(in srgb, ${env.protected ? "var(--env-production)" : "var(--w-accent)"} 45%, transparent)`,
            }}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-[10px] text-white" style={{ background: env.protected ? "#d94343" : "var(--w-accent)" }}><Rocket size={17} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold">Fazer deploy</span>
              <span className="block truncate text-[12px] text-fg-2">
                {!canRun(ws, s, "deploy") ? `não existe em ${env.label}` : s.releaseKey && ws.state.releases[env.id]?.[s.releaseKey] ? `instala a ${shortVersion(ws.state.releases[env.id][s.releaseKey])} do release` : "aplica a configuração"}
              </span>
            </span>
          </button>
        )}
        {acts.map((a) => (
          <button key={a} className="tile" disabled={!canRun(ws, s, a)} onClick={() => runServiceAction(ws, p, s, a)}>
            <span className="grid size-8 place-items-center rounded-[9px] bg-raise-2">{ACTION_META[a].icon}</span>
            <span><span className="block text-[13px] font-medium">{ACTION_META[a].label}</span><span className="block text-[11.5px] text-fg-3">{canRun(ws, s, a) ? ACTION_META[a].sub : `não existe em ${env.label}`}</span></span>
          </button>
        ))}
        {s.releaseKey && env.release && (
          <button className="tile" onClick={() => setRollback(true)}>
            <span className="grid size-8 place-items-center rounded-[9px] bg-raise-2"><Undo2 size={16} /></span>
            <span><span className="block text-[13px] font-medium">Versão anterior</span><span className="block text-[11.5px] text-fg-3">do histórico do git</span></span>
          </button>
        )}
      </div>

      <div className="mt-3 space-y-1 text-[12px] text-fg-3">
        {s.container && <p>Container <span className="font-mono text-fg-2 selectable">{s.container}</span></p>}
        {s.releaseKey && <p>Versão em <span className="font-mono text-fg-2">{env.release}</span> · <span className="font-mono text-fg-2">{s.releaseKey}</span></p>}
        {s.actions.deploy?.make && <p>Deploy <span className="font-mono text-fg-2 selectable">make {s.actions.deploy.make.replace("{env}", env.id)}</span></p>}
      </div>

      <p className="sec-h mb-2 mt-6">Actividade</p>
      {activity.length === 0 ? (
        <p className="text-[12.5px] text-fg-3">Ainda nada corrido a partir da app.</p>
      ) : (
        <div className="relative space-y-3 pl-5 text-[12.5px]">
          <span className="absolute bottom-1 left-[5px] top-1 w-px bg-line-2" />
          {activity.map((h) => {
            const ok = h.exitCode === 0;
            const e = m.environments.find((x) => x.id === h.meta?.env);
            return (
              <button key={h.id} className="relative block w-full text-left" onClick={() => ws.focusRun(h.id)}>
                <span className="absolute -left-5 top-1 size-[11px] rounded-full" style={{ background: !h.endedAt ? "var(--w-accent)" : ok ? "var(--ok)" : h.cancelled ? "var(--warn)" : "var(--danger)", boxShadow: "0 0 0 3px var(--w-panel)" }} />
                <p className="font-medium">{h.meta?.title.split(" · ")[0]}{h.meta?.action === "deploy" && h.meta?.version ? ` ${shortVersion(h.meta.version)}` : ""} {e && <span className="font-normal text-fg-3">· {e.label}</span>}</p>
                <p className="text-fg-3">{relTime(h.startedAt)}{h.endedAt && !ok ? (h.cancelled ? " · cancelada" : " · falhou") : ""}</p>
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
  const env = ws.env;
  const [revs, setRevs] = useState<Revision[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const current = ws.state.releases[env.id]?.[s.releaseKey!];
  useEffect(() => {
    api.releaseHistory(ws.project.root, env.release!, s.releaseKey!).then(setRevs).catch((e) => setErr(errorText(e)));
  }, []);
  return (
    <Modal onClose={onClose} width={560}>
      <div className="p-6">
        <div className="flex items-center gap-3">
          <TechIcon kind={s.kind} size="lg" />
          <div><p className="text-[16px] font-semibold">Voltar a uma versão anterior</p><p className="text-[12.5px] text-fg-2">{s.label} · {env.label} · {env.release}</p></div>
        </div>
        <p className="mt-4 text-[12.5px] text-fg-2">Escolhe uma versão do histórico do git. A app troca a linha <span className="font-mono">{s.releaseKey}</span> no release e faz o deploy — se o deploy falhar, a linha volta ao que estava.</p>
        <div className="mt-4 max-h-[340px] space-y-1 overflow-auto scroll">
          {err && <p className="text-danger">{err}</p>}
          {!revs && !err && <p className="text-fg-3">a ler o git…</p>}
          {revs?.map((r) => {
            const cur = r.value === current;
            return (
              <button key={r.commit + r.value} disabled={cur} className="row flex w-full items-center gap-3 px-3 py-2.5 text-left disabled:opacity-60"
                onClick={() => { onClose(); promoteServices(ws, [{ p, s }], { value: r.value, title: "Voltar atrás" }); }}>
                {cur ? <CircleCheck size={16} className="text-ok" /> : <Undo2 size={16} className="text-fg-3" />}
                <span className="w-28 font-mono text-[14px]">{r.short}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">{r.subject}</span>
                <span className="text-[12px] text-fg-3">{cur ? "instalada" : r.date}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-5 flex justify-between">
          <button className="b b-ghost" onClick={() => { onClose(); ws.go("ficheiros"); }}><FileCode2 size={14} />Abrir o release</button>
          <button className="b" onClick={onClose}><Ellipsis size={14} />Fechar</button>
        </div>
      </div>
    </Modal>
  );
}
