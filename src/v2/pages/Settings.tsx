import { useEffect, useMemo, useState } from "react";
import { CircleCheck, FileCode2, Plus, Save, TriangleAlert, Trash2, Wand2 } from "lucide-react";
import { api, errorText, type Manifest, type Service, type TemplateReport } from "../../api";
import { useWs } from "../context";
import { ENV_COLOR } from "../lib";
import { KINDS, Modal, TechIcon, Tint, techLabel } from "../ui";

/** Formulário e JSON são a mesma coisa: editar um muda o outro. */
export function Settings() {
  const ws = useWs();
  const [draft, setDraft] = useState<Manifest>(ws.manifest);
  const [json, setJson] = useState(() => JSON.stringify(ws.manifest, null, 2));
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(ws.manifest);

  useEffect(() => {
    setDraft(ws.manifest);
    setJson(JSON.stringify(ws.manifest, null, 2));
  }, [ws.manifest]);

  function update(next: Manifest) {
    setDraft(next);
    setJson(JSON.stringify(next, null, 2));
    setJsonErr(null);
  }
  function editJson(text: string) {
    setJson(text);
    try {
      setDraft(JSON.parse(text));
      setJsonErr(null);
    } catch (e) {
      setJsonErr(errorText(e));
    }
  }
  async function save() {
    try {
      await api.manifestSave(ws.project.root, draft);
      await ws.refresh();
      ws.toast("ansible-mario.json gravado");
    } catch (e) {
      ws.toast(errorText(e), true);
    }
  }
  const setSvc = (pi: number, si: number, patch: Partial<Service>) => {
    const products = draft.products.map((p, i) => (i !== pi ? p : { ...p, services: p.services.map((s, j) => (j === si ? { ...s, ...patch } : s)) }));
    update({ ...draft, products });
  };
  const keys = useMemo(() => [...new Set(Object.values(ws.state.releases).flatMap((r) => Object.keys(r)))].sort(), [ws.state.releases]);

  return (
    <>
      <section className="scroll min-w-0 flex-1 space-y-5 overflow-auto px-6 pb-10 pt-5">
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-[13px] text-fg-2">Guardadas em <span className="font-mono text-fg">{ws.project.name}/ansible-mario.json</span> — vão com o repositório, a equipa vê o mesmo.</p>
          <button className="b" onClick={() => setWizard(true)}><Wand2 size={15} />Aplicar template</button>
          <button className="b b-pri" disabled={!dirty || !!jsonErr} onClick={save}><Save size={15} />Guardar</button>
        </div>

        {ws.state.problems.length > 0 && (
          <div className="raise p-4" style={{ boxShadow: "0 0 0 1px color-mix(in srgb, var(--warn) 45%, transparent)" }}>
            <p className="flex items-center gap-2 font-medium text-warn"><TriangleAlert size={15} />{ws.state.problems.length} problema{ws.state.problems.length > 1 ? "s" : ""} — os botões afectados ficam desligados</p>
            <ul className="mt-2 space-y-1 text-[12.5px] text-fg-2">
              {ws.state.problems.slice(0, 8).map((p, i) => <li key={i}><span className="font-mono text-fg-3">{p.path}</span> · {p.message}</li>)}
            </ul>
          </div>
        )}

        <section className="raise p-5">
          <h2 className="text-[15px] font-semibold">Projecto</h2>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label><span className="label">Nome</span><input className="field" value={draft.name} onChange={(e) => update({ ...draft, name: e.target.value })} /></label>
            <label><span className="label">Registry (para as apps com uma imagem por ambiente)</span><input className="field font-mono" placeholder="https://registry.exemplo.pt" value={draft.registry?.url ?? ""} onChange={(e) => update({ ...draft, registry: e.target.value ? { url: e.target.value } : undefined })} /></label>
          </div>
          {draft.registry?.url && <p className="mt-2 text-[12px] text-fg-3">Credenciais: as do <span className="font-mono">docker login</span> (config.json ou Keychain). Não ficam neste ficheiro.</p>}
        </section>

        <section className="raise p-5">
          <h2 className="text-[15px] font-semibold">Ambientes</h2>
          <div className="mt-3 space-y-2">
            {draft.environments.map((e, i) => (
              <div key={e.id} className="grid grid-cols-[150px_120px_1fr_1fr_90px] items-center gap-3">
                <input className="field" value={e.label} onChange={(x) => update({ ...draft, environments: draft.environments.map((y, j) => (j === i ? { ...y, label: x.target.value } : y)) })} />
                <select className="field" value={e.color} onChange={(x) => update({ ...draft, environments: draft.environments.map((y, j) => (j === i ? { ...y, color: x.target.value } : y)) })}>
                  {Object.keys(ENV_COLOR).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <span className="truncate font-mono text-[12px] text-fg-3">{e.inventory}</span>
                <span className="truncate font-mono text-[12px] text-fg-3">{e.release ?? "sem release"}</span>
                <label className="flex items-center justify-end gap-2 text-[12.5px]">
                  <input type="checkbox" checked={e.protected} onChange={(x) => update({ ...draft, environments: draft.environments.map((y, j) => (j === i ? { ...y, protected: x.target.checked } : y)) })} />
                  protegido
                </label>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-3 text-[12.5px]">
            <span className="text-fg-2">Promoção</span>
            <select className="field !w-40" value={draft.promotion[0]?.from ?? ""} onChange={(x) => update({ ...draft, promotion: x.target.value ? [{ from: x.target.value, to: draft.promotion[0]?.to ?? draft.environments.find((e) => e.id !== x.target.value)?.id ?? "" }] : [] })}>
              <option value="">(nenhuma)</option>
              {draft.environments.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
            <span>→</span>
            <select className="field !w-40" disabled={!draft.promotion[0]} value={draft.promotion[0]?.to ?? ""} onChange={(x) => update({ ...draft, promotion: [{ from: draft.promotion[0].from, to: x.target.value }] })}>
              {draft.environments.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
          </div>
        </section>

        <section className="raise p-5">
          <h2 className="text-[15px] font-semibold">Produtos e serviços</h2>
          <div className="mt-3 space-y-5">
            {draft.products.map((p, pi) => (
              <div key={p.id}>
                <div className="grid grid-cols-[200px_1fr] gap-3">
                  <input className="field font-semibold" value={p.label} onChange={(e) => update({ ...draft, products: draft.products.map((x, i) => (i === pi ? { ...x, label: e.target.value } : x)) })} />
                  <input className="field" placeholder="descrição" value={p.description} onChange={(e) => update({ ...draft, products: draft.products.map((x, i) => (i === pi ? { ...x, description: e.target.value } : x)) })} />
                </div>
                <div className="mt-2 space-y-1.5">
                  {p.services.map((s, si) => (
                    <div key={s.id + si} className="grid grid-cols-[34px_170px_130px_170px_1fr_auto] items-center gap-2 pl-2">
                      <TechIcon kind={s.kind} size="sm" />
                      <input className="field !h-8" value={s.label} onChange={(e) => setSvc(pi, si, { label: e.target.value })} />
                      <select className="field !h-8" value={s.kind} onChange={(e) => setSvc(pi, si, { kind: e.target.value })}>
                        {KINDS.map((k) => <option key={k} value={k}>{techLabel(k)}</option>)}
                      </select>
                      <select className="field !h-8 font-mono !text-[12px]" value={s.releaseKey ?? ""} onChange={(e) => setSvc(pi, si, { releaseKey: e.target.value || undefined })}>
                        <option value="">sem versão</option>
                        {keys.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                      <span className="truncate text-[12px] text-fg-3">{Object.keys(s.actions).join(" · ")}</span>
                      <label className="flex items-center gap-1.5 text-[12px] text-fg-2" title="A tag traz o ambiente (-staging-): promover pergunta ao registry">
                        <input type="checkbox" checked={!!s.perEnvImage} onChange={(e) => setSvc(pi, si, { perEnvImage: e.target.checked })} />tag por ambiente
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </section>

      <aside className="flex w-[440px] shrink-0 flex-col border-l hair p-4">
        <div className="flex items-center gap-2 text-[12.5px]">
          <FileCode2 size={15} className="text-fg-3" /><span className="font-mono">ansible-mario.json</span>
          <span className="ml-auto">{jsonErr ? <Tint color="var(--danger)">JSON inválido</Tint> : dirty ? <Tint color="var(--w-accent)">por gravar</Tint> : <Tint color="var(--ok)"><CircleCheck size={12} />gravado</Tint>}</span>
        </div>
        <textarea
          className="scroll selectable mt-3 min-h-0 flex-1 resize-none rounded-xl bg-console p-4 font-mono text-[11.5px] leading-[1.6] text-[#c8c8cc] outline-none ring-1 ring-line focus:ring-accent"
          value={json}
          spellCheck={false}
          onChange={(e) => editJson(e.target.value)}
        />
        {jsonErr && <p className="mt-2 text-[12px] text-danger">{jsonErr}</p>}
        <p className="mt-2 text-[12px] text-fg-3">Os segredos nunca vêm para aqui — ficam no vault.</p>
      </aside>
      {wizard && <Wizard root={ws.project.root} name={ws.project.name} toast={ws.toast} onClose={() => setWizard(false)} onApplied={async () => { setWizard(false); await ws.refresh(); }} />}
    </>
  );
}

/** Aplicar um template: a app lê o projecto e propõe; grava-se depois de rever. */
export function Wizard({ root, name, toast, onClose, onApplied, first }: { root: string; name: string; toast: (t: string, bad?: boolean) => void; onClose: () => void; onApplied: () => void; first?: boolean }) {
  const [reports, setReports] = useState<Record<string, TemplateReport | null>>({});
  const [choice, setChoice] = useState<string>("makefile-convention");
  useEffect(() => {
    for (const t of ["makefile-convention", "playbooks"]) api.templateReport(root, t).then((r) => setReports((x) => ({ ...x, [t]: r }))).catch(() => setReports((x) => ({ ...x, [t]: null })));
  }, []);
  useEffect(() => {
    if (reports["makefile-convention"] && !reports["makefile-convention"].compatible && reports.playbooks?.compatible) setChoice("playbooks");
  }, [reports]);
  const r = reports[choice];
  const services = r ? r.manifest.products.reduce((a, p) => a + p.services.length, 0) : 0;

  async function apply() {
    if (!r) return;
    try {
      await api.manifestSave(root, r.manifest);
      toast("ansible-mario.json criado — revê nas Definições");
      onApplied();
    } catch (e) {
      toast(errorText(e), true);
    }
  }

  const option = (id: string, title: string, desc: React.ReactNode) => {
    const rep = reports[id];
    return (
      <button className="flex w-full gap-3 rounded-xl p-4 text-left" style={{ boxShadow: choice === id ? "0 0 0 2px var(--w-accent)" : "0 0 0 1px var(--w-line-2)" }} onClick={() => setChoice(id)}>
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full" style={choice === id ? { background: "var(--w-accent)", color: "#fff" } : { boxShadow: "inset 0 0 0 1.5px var(--w-fg-3)" }}>{choice === id && <CircleCheck size={13} />}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 font-medium">
            {title}
            {rep === undefined ? <span className="text-[12px] text-fg-3">a analisar…</span> : rep?.compatible ? <Tint color="var(--ok)">compatível · {rep.matched}/{rep.total}</Tint> : <Tint color="var(--w-fg-3)">não compatível</Tint>}
          </span>
          <span className="mt-0.5 block text-[12px] text-fg-3">{desc}</span>
        </span>
      </button>
    );
  };

  return (
    <Modal onClose={onClose} width={660}>
      <div className="p-7">
        <span className="grid size-10 place-items-center rounded-xl text-accent" style={{ background: "color-mix(in srgb, var(--w-accent) 15%, transparent)" }}><Wand2 size={20} /></span>
        <h2 className="mt-4 text-[20px] font-semibold tracking-tight">{first ? `O ${name} ainda não tem definições` : "Aplicar um template"}</h2>
        <p className="mt-1 text-fg-2">A app lê o projecto e propõe. {first ? "Sem definições, o modo Ficheiros continua disponível." : "Substitui o ansible-mario.json actual."}</p>
        <div className="mt-5 space-y-2">
          {option("makefile-convention", "Convenção do Makefile", <>Alvos <span className="font-mono">verbo-produto-tecnologia-ambiente</span>, como <span className="font-mono">deploy-saco-nestjs-staging</span>.</>)}
          {option("playbooks", "Só playbooks", "Um botão por playbook, com o inventário e o release do ambiente.")}
        </div>
        {r && (
          <>
            <div className="mt-5 grid grid-cols-4 gap-2 rounded-xl bg-raise-2 p-4 text-center">
              {[[r.manifest.environments.length, "ambientes"], [r.manifest.products.length, "produtos"], [services, "serviços"], [r.manifest.operations.length, "operações"]].map(([n, l]) => (
                <div key={l as string}><p className="text-[20px] font-semibold">{n}</p><p className="text-[12px] text-fg-3">{l}</p></div>
              ))}
            </div>
            {r.unmatched.length > 0 && <p className="mt-3 text-[12px] text-fg-3">Ficaram de fora: <span className="font-mono">{r.unmatched.join(", ")}</span></p>}
            {r.warnings.map((w) => <p key={w} className="mt-1 text-[12px] text-warn">{w}</p>)}
          </>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button className="b" onClick={onClose}>{first ? "Agora não" : "Cancelar"}</button>
          <button className="b b-pri" disabled={!r || !r.compatible} onClick={apply}><Plus size={15} />Criar ansible-mario.json</button>
        </div>
        {!first && <p className="mt-3 flex items-center gap-1.5 text-[12px] text-fg-3"><Trash2 size={12} />As tuas alterações manuais ao ficheiro actual perdem-se.</p>}
      </div>
    </Modal>
  );
}
