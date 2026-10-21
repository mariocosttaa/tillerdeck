import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, Copy, FlaskConical, Globe, Package, PackageCheck, PackageX, Rocket, TriangleAlert } from "lucide-react";
import { api, errorText, type Product, type Service } from "../../api";
import { canRun, useWs, type Ws } from "../context";
import { cmpVersion, makeTarget, serviceKey, shortVersion } from "../lib";
import { TechIcon, Tint, techLabel } from "../ui";

type Item = { p: Product; s: Service };
type Planned = Item & { value: string; old?: string };

/**
 * Instala versões num ambiente, UM serviço de cada vez:
 * escreve a linha desse serviço no release, faz o deploy, e se o deploy
 * falhar repõe a linha e pára. O release nunca fica a dizer uma versão que
 * não está instalada.
 */
async function applyVersions(ws: Ws, envId: string, plan: Planned[], title: string, commit: boolean) {
  const env = ws.manifest.environments.find((e) => e.id === envId)!;
  const done: Planned[] = [];
  for (const it of plan) {
    const key = serviceKey(it.p, it.s);
    let old: string;
    try {
      old = await api.releaseSet(ws.project.root, env.release!, it.s.releaseKey!, it.value);
    } catch (e) {
      ws.toast(`${it.s.label}: não consegui escrever o release — ${errorText(e)}`, true);
      break;
    }
    const target = makeTarget(it.s.actions.deploy, env.id)!;
    const [name, ...inline] = target.split(/\s+/);
    const vars: [string, string][] = inline.map((kv) => kv.split("=") as [string, string]);
    if (ws.makeInfo.get(name)?.usesConfirm) vars.push(["CONFIRM", "yes"]);
    const run = await ws.start({ kind: "make", target: name, vars }, { title: `${title} · ${it.s.label}`, env: env.id, service: key, action: "deploy", version: it.value });
    if (!run) {
      await api.releaseSet(ws.project.root, env.release!, it.s.releaseKey!, old).catch(() => {});
      break;
    }
    const end = await ws.waitExit(run.id);
    if (end.exitCode !== 0) {
      await api.releaseSet(ws.project.root, env.release!, it.s.releaseKey!, old).catch(() => {});
      ws.toast(`${it.s.label} falhou — a linha do release voltou a ${shortVersion(old)}. Os seguintes não correram.`, true);
      break;
    }
    done.push({ ...it, old });
  }
  await ws.refresh();
  if (done.length && commit) {
    const msg = `${title}: ${done.map((d) => `${d.s.label} ${shortVersion(d.value)}`).join(", ")} (${env.label})`;
    try {
      const sha = await api.releaseCommit(ws.project.root, env.release!, msg);
      ws.toast(`Commit ${sha} — ${msg}`);
      await ws.refresh();
    } catch (e) {
      ws.toast(`O commit falhou: ${errorText(e)}`, true);
    }
  } else if (done.length === plan.length && done.length) {
    ws.toast(`${done.length} serviço${done.length > 1 ? "s" : ""} instalado${done.length > 1 ? "s" : ""} em ${env.label}`);
  }
}

/** A versão de destino: a mesma tag, ou — se a tag traz o ambiente — a do registry. */
async function resolveValue(ws: Ws, s: Service, from: string, to: string): Promise<{ value?: string; source: string; error?: string }> {
  const src = ws.state.releases[from]?.[s.releaseKey!];
  if (!src) return { source: "", error: "sem versão na origem" };
  if (!s.perEnvImage) return { value: src, source: "same" };
  if (!ws.manifest.registry?.url || !s.image) return { source: "registry", error: "falta o registry ou a imagem nas Definições" };
  try {
    const m = await api.registryMatch(ws.manifest.registry.url, s.image, src, from, to);
    if (!m) return { source: "registry", error: `a tag ${src} não traz o ambiente` };
    if (m.candidates.length !== 1) return { source: "registry", error: m.candidates.length ? `${m.candidates.length} tags começam por ${m.prefix}` : `nenhuma tag ${m.prefix}* no registry` };
    return { value: m.candidates[0], source: "registry" };
  } catch (e) {
    return { source: "registry", error: errorText(e) };
  }
}

/**
 * Promover (ou voltar atrás, com `override`): resolve as versões, pede uma
 * confirmação para todos e corre `applyVersions`.
 */
export async function promoteServices(ws: Ws, items: Item[], override?: { value: string; title: string }, commit = false, manual: Record<string, string> = {}) {
  const promo = ws.manifest.promotion[0];
  const toId = override ? ws.env.id : promo?.to;
  if (!toId) return;
  const to = ws.manifest.environments.find((e) => e.id === toId)!;
  const plan: Planned[] = [];
  for (const it of items) {
    if (override) {
      plan.push({ ...it, value: override.value, old: ws.state.releases[toId]?.[it.s.releaseKey!] });
      continue;
    }
    const typed = manual[it.s.releaseKey!];
    const r = typed ? { value: typed, source: "manual" } : await resolveValue(ws, it.s, promo.from, promo.to);
    if (!r.value) {
      ws.toast(`${it.s.label}: ${r.error}`, true);
      return;
    }
    plan.push({ ...it, value: r.value, old: ws.state.releases[toId]?.[it.s.releaseKey!] });
  }
  const one = plan.length === 1 ? plan[0] : null;
  const title = override?.title ?? "Promover";
  ws.confirm({
    title: one ? `${title} · ${one.s.label}` : `${title} ${plan.length} serviços para ${to.label}`,
    subtitle: `${to.label} · ${to.release}`,
    env: to,
    icon: one ? <TechIcon kind={one.s.kind} size="lg" /> : <span className="grid size-12 place-items-center rounded-[13px] bg-raise-2"><Rocket size={20} /></span>,
    word: to.protected ? to.id : undefined,
    from: one ? shortVersion(one.old) : undefined,
    to: one ? shortVersion(one.value) : undefined,
    facts: [
      ...(!one ? plan.map((x) => ({ icon: <ArrowRight size={16} />, text: `${x.s.label}: ${shortVersion(x.old)} → ${shortVersion(x.value)}`, tone: "ok" as const })) : []),
      { icon: <Copy size={16} />, text: "Cada serviço: escreve a linha no release, faz o deploy; se falhar, repõe a linha e pára." },
    ],
    confirmLabel: one ? `${title}` : `${title} ${plan.length}`,
    onConfirm: () => applyVersions(ws, toId, plan, title, commit),
  });
}

export function Promote() {
  const ws = useWs();
  const { manifest: m } = ws;
  const promo = m.promotion[0];
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [commit, setCommit] = useState(false);
  const [reg, setReg] = useState<Record<string, { value?: string; error?: string; loading?: boolean }>>({});
  // Sem registry (ou sem resposta): a tag escreve-se à mão.
  const [manual, setManual] = useState<Record<string, string>>({});

  const from = m.environments.find((e) => e.id === promo?.from);
  const to = m.environments.find((e) => e.id === promo?.to);
  const all: Item[] = useMemo(() => m.products.flatMap((p) => p.services.filter((s) => s.releaseKey).map((s) => ({ p, s }))), [m]);
  const rf = promo ? ws.state.releases[promo.from] ?? {} : {};
  const rt = promo ? ws.state.releases[promo.to] ?? {} : {};
  const differs = all.filter(({ s }) => rf[s.releaseKey!] && cmpVersion(rf[s.releaseKey!], rt[s.releaseKey!]) !== 0);
  const same = all.filter((x) => !differs.includes(x));
  const sel = chosen ?? new Set(differs.filter(({ s }) => (cmpVersion(rf[s.releaseKey!], rt[s.releaseKey!]) ?? 1) > 0).map(({ p, s }) => serviceKey(p, s)));

  // As apps com uma imagem por ambiente: perguntar já ao registry.
  useEffect(() => {
    if (!promo) return;
    for (const { s } of differs.filter(({ s }) => s.perEnvImage)) {
      if (reg[s.releaseKey!]) continue;
      setReg((r) => ({ ...r, [s.releaseKey!]: { loading: true } }));
      resolveValue(ws, s, promo.from, promo.to).then((x) => setReg((r) => ({ ...r, [s.releaseKey!]: x })));
    }
  }, [promo?.from, ws.state.releases]);

  if (!promo || !from || !to) {
    return <div className="p-10 text-fg-2">Este projecto não tem um caminho de promoção. Define um nas Definições (por exemplo, staging → produção).</div>;
  }

  const picked = differs.filter(({ p, s }) => sel.has(serviceKey(p, s)));
  const blocked = picked.filter(({ s }) => s.perEnvImage && !reg[s.releaseKey!]?.value && !manual[s.releaseKey!]);
  const notDeployable = picked.filter(({ s }) => !canRun({ ...ws, env: to }, s, "deploy"));
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
              <div><p className="text-[17px] font-semibold">{from.label}</p><p className="text-[12px] text-fg-2">onde se testa</p></div>
            </div>
            <div className="flex flex-1 items-center gap-2">
              <span className="h-px flex-1" style={{ background: `linear-gradient(90deg,var(--env-${from.color}),var(--w-accent))` }} />
              <Tint color="var(--w-accent)"><Package size={12} />a mesma imagem, sem reconstruir</Tint>
              <span className="h-px flex-1" style={{ background: `linear-gradient(90deg,var(--w-accent),var(--env-${to.color}))` }} />
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right"><p className="text-[17px] font-semibold">{to.label}</p><p className="text-[12px] text-fg-2">{to.protected ? "protegido" : "destino"}</p></div>
              <span className="grid size-11 place-items-center rounded-xl" style={{ background: `color-mix(in srgb,var(--env-${to.color}) 18%,transparent)`, color: `var(--env-${to.color})` }}><Globe size={20} /></span>
            </div>
          </div>
        </div>

        <div className="mb-2 mt-6 flex items-baseline gap-2 px-1">
          <h3 className="text-[14px] font-semibold">Diferentes</h3>
          <span className="text-[12.5px] text-fg-3">{differs.length ? `${differs.length} serviço${differs.length > 1 ? "s" : ""} com outra versão em ${from.label.toLowerCase()}` : "nada a promover — estão iguais"}</span>
        </div>
        <div className="space-y-2">
          {differs.map(({ p, s }) => {
            const k = serviceKey(p, s);
            const on = sel.has(k);
            const d = cmpVersion(rf[s.releaseKey!], rt[s.releaseKey!]);
            const r = reg[s.releaseKey!];
            return (
              <div key={k} className={`row flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 ${on ? "sel" : ""}`} onClick={() => toggle(k)} style={on ? {} : { background: "var(--w-raise)", boxShadow: "0 0 0 1px var(--w-line)" }}>
                <span className="grid size-5 shrink-0 place-items-center rounded-[6px]" style={on ? { background: "var(--w-accent)", color: "#fff" } : { boxShadow: "inset 0 0 0 1.5px var(--w-fg-3)" }}>{on && <Check size={14} />}</span>
                <TechIcon kind={s.kind} />
                <div className="w-48 min-w-0"><p className="truncate text-[14px] font-medium">{s.label}</p><p className="truncate text-[12px] text-fg-3">{p.label} · {techLabel(s.kind)}</p></div>
                <div className="flex flex-1 items-center gap-3">
                  <div className="whitespace-nowrap"><p className="text-[11.5px] text-fg-3">{to.label} agora</p><p className={`font-mono text-[15px] text-fg-2 ${on ? "line-through decoration-1" : ""}`}>{shortVersion(rt[s.releaseKey!]) || "—"}</p></div>
                  <ArrowRight size={16} style={{ color: (d ?? 1) > 0 ? "var(--w-accent)" : "var(--warn)" }} />
                  <div className="whitespace-nowrap"><p className="text-[11.5px] text-fg-3">Vai ficar</p><p className="font-mono text-[15px] font-medium text-ok">{shortVersion(r?.value ?? manual[s.releaseKey!] ?? rf[s.releaseKey!])}</p></div>
                  {d !== null && d < 0 && <Tint color="var(--warn)"><TriangleAlert size={12} />{to.label.toLowerCase()} está à frente</Tint>}
                </div>
                {s.perEnvImage ? (
                  r?.loading ? <span className="pill bg-raise-2 text-fg-3">a perguntar ao registry…</span>
                  : r?.value ? <Tint color="var(--ok)"><PackageCheck size={13} />tag encontrada no registry</Tint>
                  : <span title={r?.error}><Tint color="var(--warn)"><PackageX size={13} />tag à mão</Tint></span>
                ) : (
                  <span className="pill bg-raise-2 text-fg-2"><Copy size={13} />a mesma tag</span>
                )}
                {s.perEnvImage && !r?.loading && !r?.value && (
                  <div className="flex basis-full items-center gap-2 pl-[90px] text-[12.5px]" onClick={(e) => e.stopPropagation()}>
                    <span className="text-fg-3">{r?.error ?? "sem resposta do registry"} — escreve a tag de {to.label.toLowerCase()}:</span>
                    <input
                      className="field !h-8 !w-72 font-mono !text-[12px]"
                      placeholder={`${shortVersion(rf[s.releaseKey!])}-${to.id}-…`}
                      defaultValue={manual[s.releaseKey!] ?? ""}
                      onChange={(e) => setManual({ ...manual, [s.releaseKey!]: e.target.value.trim() })}
                      spellCheck={false}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {same.length > 0 && (
          <>
            <div className="mb-2 mt-6 flex items-baseline gap-2 px-1"><h3 className="text-[14px] font-semibold">Já iguais</h3><span className="text-[12.5px] text-fg-3">nada a fazer</span></div>
            <div className="flex flex-wrap gap-2">
              {same.map(({ p, s }) => (
                <span key={serviceKey(p, s)} className="flex items-center gap-2 rounded-[10px] bg-raise py-1.5 pl-1.5 pr-3 text-[12.5px] ring-1 ring-line">
                  <TechIcon kind={s.kind} size="sm" />{s.label}<span className="font-mono text-fg-3">{shortVersion(rt[s.releaseKey!])}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </section>

      <aside className="flex w-[372px] shrink-0 flex-col border-l hair px-5 pb-5 pt-5">
        <p className="text-[15px] font-semibold">O que vai acontecer</p>
        <ol className="mt-4 space-y-4">
          {[
            ["Um serviço de cada vez", `escreve a linha dele em ${to.release} — os comentários ficam`],
            ["Deploy desse serviço", "com o alvo do Makefile, como no terminal"],
            ["Se falhar, pára", "repõe a linha do release; os seguintes não correm"],
          ].map(([t, d], i) => (
            <li key={i} className="flex gap-3">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-raise-2 text-[12px] font-semibold">{i + 1}</span>
              <div><p className="font-medium">{t}</p><p className="text-[12px] text-fg-3">{d}</p></div>
            </li>
          ))}
        </ol>
        {picked.length > 0 && (
          <div className="mt-5">
            <p className="sec-h mb-2">Ordem</p>
            <div className="space-y-1.5 text-[13px]">
              {picked.map(({ s }, i) => <p key={s.releaseKey} className="flex items-center gap-2"><span className="w-4 text-right text-fg-3">{i + 1}</span>{s.label}</p>)}
            </div>
          </div>
        )}
        <label className="mt-5 flex items-center gap-2.5 rounded-[10px] bg-raise px-3 py-2.5 text-[13px] ring-1 ring-line" onClick={() => setCommit(!commit)}>
          <span className="relative h-5 w-9 shrink-0 rounded-full transition" style={{ background: commit ? "var(--w-accent)" : "var(--w-raise-2)", boxShadow: "inset 0 0 0 1px var(--w-line-2)" }}>
            <span className="absolute top-0.5 size-4 rounded-full bg-white transition-all" style={{ left: commit ? 18 : 2 }} />
          </span>
          Fazer commit do release no fim
        </label>
        <div className="mt-auto pt-4">
          {blocked.length > 0 && <p className="mb-2 text-[12px] text-danger">{blocked.map((x) => x.s.label).join(", ")}: falta a tag de {to.label.toLowerCase()}.</p>}
          {notDeployable.length > 0 && <p className="mb-2 text-[12px] text-danger">{notDeployable.map((x) => x.s.label).join(", ")}: sem alvo de deploy em {to.label.toLowerCase()}.</p>}
          <button className="b b-pri h-11 w-full justify-center text-[14px]" disabled={!picked.length || blocked.length > 0 || notDeployable.length > 0} onClick={() => promoteServices(ws, picked, undefined, commit, manual)}>
            <Rocket size={16} />Promover {picked.length} serviço{picked.length === 1 ? "" : "s"}
          </button>
          {to.protected && <p className="mt-2 text-center text-[12px] text-fg-3">Pede a palavra <span className="font-mono" style={{ color: "var(--env-production)" }}>{to.id}</span> uma vez.</p>}
        </div>
      </aside>
    </>
  );
}
