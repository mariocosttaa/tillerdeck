import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, Copy, FlaskConical, Globe, Package, PackageCheck, PackageX, Rocket, TriangleAlert } from "lucide-react";
import { api, errorText, type EnvDef, type Product, type Service } from "../../api";
import { canRun, specFor, useWs, type Ws } from "../context";
import { cmpVersion, makeTarget, productOn, serviceKey, shortVersion, versionOf, where } from "../lib";
import { TechIcon, Tint, techLabel } from "../ui";
import { t, tn } from "../i18n";

type Item = { p: Product; s: Service };
type Planned = Item & { value: string; old?: string };

/**
 * Instala versões num servidor, UM serviço de cada vez:
 * escreve a linha desse serviço no release onde o produto vive, faz o
 * deploy, e se o deploy falhar repõe a linha e pára. O release nunca fica a
 * dizer uma versão que não está instalada.
 */
async function applyVersions(ws: Ws, server: EnvDef, plan: Planned[], title: string, commit: boolean) {
  const done: Planned[] = [];
  const touched = new Set<string>();
  for (const it of plan) {
    const w = where(it.p, server);
    const key = serviceKey(it.p, it.s);
    let old: string;
    try {
      old = await api.releaseSet(ws.project.root, w.release!, it.s.releaseKey!, it.value);
    } catch (e) {
      ws.toast(t("{s}: couldn't write the release — {e}", { s: it.s.label, e: errorText(e) }), true);
      break;
    }
    touched.add(w.release!);
    const target = makeTarget(it.s.actions.deploy, w.token)!;
    const run = await ws.start(specFor(ws, w, target, undefined), { title: `${title} · ${it.s.label}`, env: server.id, service: key, action: "deploy", version: it.value });
    if (!run) {
      await api.releaseSet(ws.project.root, w.release!, it.s.releaseKey!, old).catch(() => {});
      break;
    }
    const end = await ws.waitExit(run.id);
    if (end.exitCode !== 0) {
      await api.releaseSet(ws.project.root, w.release!, it.s.releaseKey!, old).catch(() => {});
      ws.toast(t("{s} failed — the release line went back to {v}. The next ones didn't run.", { s: it.s.label, v: shortVersion(old) }), true);
      break;
    }
    done.push({ ...it, old });
  }
  await ws.refresh();
  if (done.length && commit) {
    const msg = `${title}: ${done.map((d) => `${d.s.label} ${shortVersion(d.value)}`).join(", ")} (${server.label})`;
    for (const file of touched) {
      try {
        const sha = await api.releaseCommit(ws.project.root, file, msg);
        ws.toast(t("Commit {sha} — {msg}", { sha, msg }));
      } catch (e) {
        ws.toast(t("The commit failed: {e}", { e: errorText(e) }), true);
      }
    }
    await ws.refresh();
  } else if (done.length === plan.length && done.length) {
    ws.toast(tn(done.length, "{n} service installed on {env}", "{n} services installed on {env}", { env: server.label }));
  }
}

/** A versão de destino: a mesma tag, ou — se a tag traz o ambiente — a do registry. */
async function resolveValue(ws: Ws, p: Product, s: Service, from: EnvDef, to: EnvDef): Promise<{ value?: string; error?: string }> {
  const src = versionOf(ws.state.releases, where(p, from), s);
  if (!src) return { error: t("no version on {env}", { env: from.label }) };
  if (!s.perEnvImage) return { value: src };
  if (!ws.manifest.registry?.url || !s.image) return { error: t("set the registry and image in Settings") };
  try {
    const m = await api.registryMatch(ws.manifest.registry.url, s.image, src, where(p, from).token, where(p, to).token);
    if (!m) return { error: t("the tag {tag} doesn't carry the environment", { tag: src }) };
    if (m.candidates.length !== 1) return { error: m.candidates.length ? t("{n} tags start with {p}", { n: m.candidates.length, p: m.prefix }) : t("no {p}* tag in the registry", { p: m.prefix }) };
    return { value: m.candidates[0] };
  } catch (e) {
    return { error: errorText(e) };
  }
}

/**
 * Promover (ou voltar atrás, com `override`): resolve as versões, pede uma
 * confirmação para todos e corre `applyVersions`.
 */
export async function promoteServices(ws: Ws, items: Item[], override?: { value: string; title: string }, commit = false, manual: Record<string, string> = {}) {
  const promo = ws.manifest.promotion[0];
  const server = override ? ws.env : ws.manifest.environments.find((e) => e.id === promo?.to);
  const from = ws.manifest.environments.find((e) => e.id === promo?.from);
  if (!server) return;
  const plan: Planned[] = [];
  for (const it of items) {
    const old = versionOf(ws.state.releases, where(it.p, server), it.s);
    if (override) {
      plan.push({ ...it, value: override.value, old });
      continue;
    }
    const typed = manual[serviceKey(it.p, it.s)];
    const r = typed ? { value: typed } : await resolveValue(ws, it.p, it.s, from!, server);
    if (!r.value) {
      ws.toast(`${it.s.label}: ${r.error}`, true);
      return;
    }
    plan.push({ ...it, value: r.value, old });
  }
  const one = plan.length === 1 ? plan[0] : null;
  const title = override?.title ?? t("Promote");
  // A palavra é o alvo (`production`, `testes`) — o mesmo que o Makefile pede.
  const tokens = [...new Set(plan.map((x) => where(x.p, server).token))];
  ws.confirm({
    title: one ? `${title} · ${one.s.label}` : t("{title} {n} services to {env}", { title, n: plan.length, env: server.label }),
    subtitle: `${server.label} · ${[...new Set(plan.map((x) => where(x.p, server).release))].join(" · ")}`,
    env: server,
    icon: one ? <TechIcon kind={one.s.kind} size="lg" /> : <span className="grid size-12 place-items-center rounded-[13px] bg-raise-2"><Rocket size={20} /></span>,
    word: server.protected ? tokens.join(",") : undefined,
    from: one ? shortVersion(one.old) : undefined,
    to: one ? shortVersion(one.value) : undefined,
    facts: [
      ...(!one ? plan.map((x) => ({ icon: <ArrowRight size={16} />, text: `${x.s.label}: ${shortVersion(x.old)} → ${shortVersion(x.value)}`, tone: "ok" as const })) : []),
      { icon: <Copy size={16} />, text: t("For each service: write its line in the release, deploy; if it fails, restore the line and stop.") },
    ],
    confirmLabel: one ? title : `${title} ${plan.length}`,
    onConfirm: () => applyVersions(ws, server, plan, title, commit),
  });
}

export function Promote() {
  const ws = useWs();
  const { manifest: m } = ws;
  const promo = m.promotion[0];
  const from = m.environments.find((e) => e.id === promo?.from);
  const to = m.environments.find((e) => e.id === promo?.to);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [commit, setCommit] = useState(false);
  const [reg, setReg] = useState<Record<string, { value?: string; error?: string; loading?: boolean }>>({});
  // Sem registry (ou sem resposta): a tag escreve-se à mão.
  const [manual, setManual] = useState<Record<string, string>>({});

  // Só os produtos que existem nos dois lados.
  const all: Item[] = useMemo(
    () => (from && to ? m.products.filter((p) => productOn(p, from.id) && productOn(p, to.id)).flatMap((p) => p.services.filter((s) => s.releaseKey && s.actions.deploy).map((s) => ({ p, s }))) : []),
    [m, from?.id, to?.id],
  );
  const vf = (x: Item) => (from ? versionOf(ws.state.releases, where(x.p, from), x.s) : undefined);
  const vt = (x: Item) => (to ? versionOf(ws.state.releases, where(x.p, to), x.s) : undefined);
  const differs = all.filter((x) => vf(x) && cmpVersion(vf(x), vt(x)) !== 0);
  const same = all.filter((x) => !differs.includes(x));
  const sel = chosen ?? new Set(differs.filter((x) => (cmpVersion(vf(x), vt(x)) ?? 1) > 0).map((x) => serviceKey(x.p, x.s)));

  useEffect(() => {
    if (!from || !to) return;
    for (const x of differs.filter((x) => x.s.perEnvImage)) {
      const k = serviceKey(x.p, x.s);
      if (reg[k]) continue;
      setReg((r) => ({ ...r, [k]: { loading: true } }));
      resolveValue(ws, x.p, x.s, from, to).then((v) => setReg((r) => ({ ...r, [k]: v })));
    }
  }, [from?.id, ws.state.releases]);

  if (!promo || !from || !to) {
    return <div className="p-10 text-fg-2">{t("This project has no promotion path. Set one in Settings (for example staging → production).")}</div>;
  }

  const picked = differs.filter((x) => sel.has(serviceKey(x.p, x.s)));
  const blocked = picked.filter((x) => x.s.perEnvImage && !reg[serviceKey(x.p, x.s)]?.value && !manual[serviceKey(x.p, x.s)]);
  const notDeployable = picked.filter((x) => !canRun(ws, x.p, x.s, "deploy", to));
  const toggle = (k: string) => {
    const n = new Set(sel);
    n.has(k) ? n.delete(k) : n.add(k);
    setChosen(n);
  };

  return (
    <>
      <section className="scroll min-w-0 flex-1 overflow-auto px-6 pb-8 pt-5">
        <div className="raise relative overflow-hidden px-6 py-5" style={{ background: `linear-gradient(100deg, color-mix(in srgb,var(--env-${from.color}) 12%,transparent), transparent 45%, color-mix(in srgb,var(--env-${to.color}) 12%,transparent)), var(--w-raise)` }}>
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-3">
              <span className="grid size-11 place-items-center rounded-xl" style={{ background: `color-mix(in srgb,var(--env-${from.color}) 18%,transparent)`, color: `var(--env-${from.color})` }}><FlaskConical size={20} /></span>
              <div><p className="text-[17px] font-semibold">{from.label}</p><p className="text-[12px] text-fg-2">{t("where it's tested")}</p></div>
            </div>
            <div className="flex flex-1 items-center gap-2">
              <span className="h-px flex-1" style={{ background: `linear-gradient(90deg,var(--env-${from.color}),var(--w-accent))` }} />
              <Tint color="var(--w-accent)"><Package size={12} />{t("the same image, no rebuild")}</Tint>
              <span className="h-px flex-1" style={{ background: `linear-gradient(90deg,var(--w-accent),var(--env-${to.color}))` }} />
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right"><p className="text-[17px] font-semibold">{to.label}</p><p className="text-[12px] text-fg-2">{to.protected ? t("protected") : t("target")}</p></div>
              <span className="grid size-11 place-items-center rounded-xl" style={{ background: `color-mix(in srgb,var(--env-${to.color}) 18%,transparent)`, color: `var(--env-${to.color})` }}><Globe size={20} /></span>
            </div>
          </div>
        </div>

        <div className="mb-2 mt-6 flex items-baseline gap-2 px-1">
          <h3 className="text-[14px] font-semibold">{t("Different")}</h3>
          <span className="text-[12.5px] text-fg-3">{differs.length ? tn(differs.length, "{n} service has another version on {env}", "{n} services have another version on {env}", { env: from.label }) : t("nothing to promote — they match")}</span>
        </div>
        <div className="space-y-2">
          {differs.map((x) => {
            const { p, s } = x;
            const k = serviceKey(p, s);
            const on = sel.has(k);
            const d = cmpVersion(vf(x), vt(x));
            const r = reg[k];
            return (
              <div key={k} className={`row flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 ${on ? "sel" : ""}`} onClick={() => toggle(k)} style={on ? {} : { background: "var(--w-raise)", boxShadow: "0 0 0 1px var(--w-line)" }}>
                <span className="grid size-5 shrink-0 place-items-center rounded-[6px]" style={on ? { background: "var(--w-accent)", color: "#fff" } : { boxShadow: "inset 0 0 0 1.5px var(--w-fg-3)" }}>{on && <Check size={14} />}</span>
                <TechIcon kind={s.kind} />
                <div className="w-48 min-w-0"><p className="truncate text-[14px] font-medium">{s.label}</p><p className="truncate text-[12px] text-fg-3">{p.label} · {techLabel(s.kind)}</p></div>
                <div className="flex flex-1 items-center gap-3">
                  <div className="whitespace-nowrap"><p className="text-[11.5px] text-fg-3">{t("{env} now", { env: to.label })}</p><p className={`font-mono text-[15px] text-fg-2 ${on ? "line-through decoration-1" : ""}`}>{shortVersion(vt(x)) || "—"}</p></div>
                  <ArrowRight size={16} style={{ color: (d ?? 1) > 0 ? "var(--w-accent)" : "var(--warn)" }} />
                  <div className="whitespace-nowrap"><p className="text-[11.5px] text-fg-3">{t("Will be")}</p><p className="font-mono text-[15px] font-medium text-ok">{shortVersion(r?.value ?? manual[k] ?? vf(x))}</p></div>
                  {d !== null && d < 0 && <Tint color="var(--warn)"><TriangleAlert size={12} />{t("{env} is ahead", { env: to.label })}</Tint>}
                </div>
                {s.perEnvImage ? (
                  r?.loading ? <span className="pill bg-raise-2 text-fg-3">{t("asking the registry…")}</span>
                  : r?.value ? <Tint color="var(--ok)"><PackageCheck size={13} />{t("tag found in the registry")}</Tint>
                  : <span title={r?.error}><Tint color="var(--warn)"><PackageX size={13} />{t("tag by hand")}</Tint></span>
                ) : (
                  <span className="pill bg-raise-2 text-fg-2"><Copy size={13} />{t("the same tag")}</span>
                )}
                {s.perEnvImage && !r?.loading && !r?.value && (
                  <div className="flex basis-full items-center gap-2 pl-[90px] text-[12.5px]" onClick={(e) => e.stopPropagation()}>
                    <span className="text-fg-3">{r?.error ?? t("no answer from the registry")} — {t("type the {env} tag:", { env: to.label })}</span>
                    <input className="field !h-8 !w-72 font-mono !text-[12px]" placeholder={`${shortVersion(vf(x))}-${where(p, to).token}-…`} defaultValue={manual[k] ?? ""} onChange={(e) => setManual({ ...manual, [k]: e.target.value.trim() })} spellCheck={false} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {same.length > 0 && (
          <>
            <div className="mb-2 mt-6 flex items-baseline gap-2 px-1"><h3 className="text-[14px] font-semibold">{t("Already the same")}</h3><span className="text-[12.5px] text-fg-3">{t("nothing to do")}</span></div>
            <div className="flex flex-wrap gap-2">
              {same.map((x) => (
                <span key={serviceKey(x.p, x.s)} className="flex items-center gap-2 rounded-[10px] bg-raise py-1.5 pl-1.5 pr-3 text-[12.5px] ring-1 ring-line">
                  <TechIcon kind={x.s.kind} size="sm" />{x.s.label}<span className="font-mono text-fg-3">{shortVersion(vt(x))}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </section>

      <aside className="flex w-[372px] shrink-0 flex-col border-l hair px-5 pb-5 pt-5">
        <p className="text-[15px] font-semibold">{t("What will happen")}</p>
        <ol className="mt-4 space-y-4">
          {[
            [t("One service at a time"), t("writes its line in the release — comments stay")],
            [t("Deploy that service"), t("with the Makefile target, as in the terminal")],
            [t("If it fails, it stops"), t("restores the release line; the next ones don't run")],
          ].map(([a, b], i) => (
            <li key={i} className="flex gap-3">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-raise-2 text-[12px] font-semibold">{i + 1}</span>
              <div><p className="font-medium">{a}</p><p className="text-[12px] text-fg-3">{b}</p></div>
            </li>
          ))}
        </ol>
        {picked.length > 0 && (
          <div className="mt-5">
            <p className="sec-h mb-2">{t("Order")}</p>
            <div className="space-y-1.5 text-[13px]">
              {picked.map((x, i) => <p key={serviceKey(x.p, x.s)} className="flex items-center gap-2"><span className="w-4 text-right text-fg-3">{i + 1}</span>{x.s.label}</p>)}
            </div>
          </div>
        )}
        <label className="mt-5 flex items-center gap-2.5 rounded-[10px] bg-raise px-3 py-2.5 text-[13px] ring-1 ring-line" onClick={() => setCommit(!commit)}>
          <span className="relative h-5 w-9 shrink-0 rounded-full transition" style={{ background: commit ? "var(--w-accent)" : "var(--w-raise-2)", boxShadow: "inset 0 0 0 1px var(--w-line-2)" }}>
            <span className="absolute top-0.5 size-4 rounded-full bg-white transition-all" style={{ left: commit ? 18 : 2 }} />
          </span>
          {t("Commit the release at the end")}
        </label>
        <div className="mt-auto pt-4">
          {blocked.length > 0 && <p className="mb-2 text-[12px] text-danger">{t("{list}: missing the {env} tag.", { list: blocked.map((x) => x.s.label).join(", "), env: to.label })}</p>}
          {notDeployable.length > 0 && <p className="mb-2 text-[12px] text-danger">{t("{list}: no deploy target on {env}.", { list: notDeployable.map((x) => x.s.label).join(", "), env: to.label })}</p>}
          <button className="b b-pri h-11 w-full justify-center text-[14px]" disabled={!picked.length || blocked.length > 0 || notDeployable.length > 0} onClick={() => promoteServices(ws, picked, undefined, commit, manual)}>
            <Rocket size={16} />{tn(picked.length, "Promote {n} service", "Promote {n} services")}
          </button>
          {to.protected && <p className="mt-2 text-center text-[12px] text-fg-3">{t("Asks for the word {w} once.", { w: to.id })}</p>}
        </div>
      </aside>
    </>
  );
}
