import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CircleCheck, FileCode2, KeyRound, Plus, RotateCcw, Save, Trash2, TriangleAlert, Wand2, X } from "lucide-react";
import { api, errorText, type Action, type EnvDef, type Manifest, type Operation, type Product, type Service, type Variable, type Versions } from "../../api";
import { useWs } from "../context";
import { ENV_COLOR } from "../lib";
import { Chips, EnvDot, KINDS, Modal, Select, TechIcon, Tint, Toggle, techLabel, type Opt } from "../ui";
import { t, tn } from "../i18n";
import { GitSettings, Preferences } from "./Personal";
import { Wizard } from "./Detect";

export { Wizard };

type Tab = "general" | "servers" | "products" | "operations" | "variables" | "json" | "preferences" | "git";

/** Abrir as Definições num separador (o ⚙ da barra lateral abre as Preferências). */
export function openSettings(go: (p: "definicoes") => void, tab: Tab) {
  try { sessionStorage.setItem("tillerdeck.settingsTab", tab); } catch { /* sem armazenamento */ }
  go("definicoes");
  window.dispatchEvent(new CustomEvent("am-settings-tab", { detail: tab }));
}
const ACTIONS = ["deploy", "migrate", "seed", "maintenanceOn", "maintenanceOff"];
const actionLabel = (a: string) => ({ deploy: t("Deploy"), migrate: t("Migrate"), seed: t("Seed"), maintenanceOn: t("Close"), maintenanceOff: t("Reopen") })[a] ?? a;
const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

/** O que o Rust também valida — aqui enquanto se edita, sem gravar. */
function liveProblems(m: Manifest, targets: Set<string>, files: Set<string>): string[] {
  const out: string[] = [];
  const servers = new Set(m.environments.map((e) => e.id));
  for (const e of m.environments) {
    if (!files.has(e.inventory)) out.push(t("Server {s}: inventory {f} doesn't exist", { s: e.label, f: e.inventory }));
    if (e.release && !files.has(e.release)) out.push(t("Server {s}: release {f} doesn't exist", { s: e.label, f: e.release }));
  }
  const checkMake = (where: string, a: Action, tokens: string[]) => {
    if (a.make) {
      for (const tok of tokens.filter((x) => !a.envs?.length || a.envs.includes(x))) {
        const name = a.make.replace("{env}", tok).split(/\s+/)[0];
        if (!targets.has(name)) out.push(t("{w}: target {t} isn't in the Makefile", { w: where, t: name }));
      }
    } else if (a.playbook && !files.has(a.playbook)) out.push(t("{w}: playbook {f} doesn't exist", { w: where, f: a.playbook }));
  };
  for (const p of m.products) {
    const ss = p.environments?.length ? p.environments : [...servers];
    const tokens = ss.map((s) => p.placements?.[s]?.token ?? s);
    for (const s of p.services) for (const [n, a] of Object.entries(s.actions)) checkMake(`${p.label} · ${s.label} · ${actionLabel(n)}`, a, tokens);
  }
  for (const o of m.operations) checkMake(o.label, o.action, o.action.envs?.length ? o.action.envs : [...servers]);
  return out;
}

export function Settings() {
  const ws = useWs();
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const v = sessionStorage.getItem("tillerdeck.settingsTab") as Tab | null;
      sessionStorage.removeItem("tillerdeck.settingsTab");
      return v ?? "products";
    } catch {
      return "products";
    }
  });
  useEffect(() => {
    const on = (e: Event) => setTab((e as CustomEvent<Tab>).detail);
    window.addEventListener("am-settings-tab", on);
    return () => window.removeEventListener("am-settings-tab", on);
  }, []);
  const personal = tab === "preferences" || tab === "git";
  const [draft, setDraft] = useState<Manifest>(ws.manifest);
  const [json, setJson] = useState(() => JSON.stringify(ws.manifest, null, 2));
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  const saved = JSON.stringify(ws.manifest);
  // sem ficheiro (template automático) há sempre o que gravar
  const changed = JSON.stringify(draft) !== saved;
  const dirty = changed || !!ws.state.auto;

  // A actualização automática não pode apagar o que se está a editar.
  useEffect(() => {
    if (!changed) {
      setDraft(ws.manifest);
      setJson(JSON.stringify(ws.manifest, null, 2));
    }
  }, [saved]);

  const update = (next: Manifest) => {
    setDraft(next);
    setJson(JSON.stringify(next, null, 2));
    setJsonErr(null);
  };
  async function save() {
    try {
      await api.manifestSave(ws.project.root, draft);
      await ws.refresh();
      ws.toast(t("tillerdeck.json saved"));
    } catch (e) {
      ws.toast(errorText(e), true);
    }
  }

  const files = useMemo(() => new Set(ws.project.files.filter((f) => !f.isDir).map((f) => f.path)), [ws.project.files]);
  const problems = useMemo(() => liveProblems(draft, ws.targets, files), [draft, ws.targets, files]);
  const tabs: [Tab, string, number?][] = [
    ["general", t("General")],
    ["servers", t("Servers"), draft.environments.length],
    ["products", t("Products"), draft.products.length],
    ["operations", t("Operations"), draft.operations.length],
    ["variables", t("Variables"), draft.variables?.length ?? 0],
    ["json", "JSON"],
  ];
  const mine: [Tab, string][] = [["preferences", t("Preferences")], ["git", "Git"]];

  return (
    <section className="scroll min-w-0 flex-1 overflow-auto">
      <div className="sticky top-0 z-20 border-b hair px-6 pb-3 pt-4" style={{ background: "var(--w-panel)" }}>
        <div className="flex flex-wrap items-center gap-3">
          {personal ? (
            <p className="min-w-0 flex-1 text-[13px] text-fg-2">{t("Saved on this computer only — each person chooses their own.")}</p>
          ) : (
            <p className="min-w-0 flex-1 text-[13px] text-fg-2">
              {ws.state.auto
                ? <>{t("Automatic — read from the project. Save to create")} <span className="font-mono text-fg">{ws.project.name}/tillerdeck.json</span>.</>
                : <>{t("Saved in")} <span className="font-mono text-fg">{ws.project.name}/tillerdeck.json</span> — {t("it travels with the repository, the team sees the same.")}</>}
            </p>
          )}
          {!personal && <button className="b" onClick={() => setWizard(true)}><Wand2 size={15} />{t("Detect again")}</button>}
          {changed && <button className="b b-ghost" onClick={() => update(ws.manifest)}><RotateCcw size={15} />{t("Discard")}</button>}
          {(!personal || dirty) && <button className="b b-pri" disabled={!dirty || !!jsonErr} onClick={save}><Save size={15} />{dirty ? t("Save") : t("Saved")}</button>}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="seg">
            {tabs.map(([id, label, n]) => (
              <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                {label}{n !== undefined && <span className="text-fg-3">{n}</span>}
              </button>
            ))}
          </div>
          <div className="seg">
            {mine.map(([id, label]) => (
              <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          {problems.length > 0 && <span className="ml-auto"><Tint color="var(--warn)"><TriangleAlert size={12} />{tn(problems.length, "{n} problem", "{n} problems")}</Tint></span>}
        </div>
      </div>

      <div className="space-y-5 px-6 pb-12 pt-5">
        {tab === "preferences" && <Preferences />}
        {tab === "git" && <GitSettings />}
        {!personal && problems.length > 0 && (
          <div className="raise p-4" style={{ boxShadow: "0 0 0 1px color-mix(in srgb, var(--warn) 45%, transparent)" }}>
            <p className="flex items-center gap-2 font-medium text-warn"><TriangleAlert size={15} />{t("Affected buttons are disabled until this is fixed")}</p>
            <ul className="mt-2 space-y-1 text-[12.5px] text-fg-2">{problems.slice(0, 10).map((p, i) => <li key={i}>{p}</li>)}</ul>
          </div>
        )}
        {tab === "general" && <General m={draft} set={update} />}
        {tab === "servers" && <Servers m={draft} set={update} />}
        {tab === "products" && <Products m={draft} set={update} />}
        {tab === "operations" && <Operations m={draft} set={update} />}
        {tab === "variables" && <Variables m={draft} set={update} dirty={changed} />}
        {tab === "json" && (
          <div>
            <div className="mb-2 flex items-center gap-2 text-[12.5px]">
              <FileCode2 size={15} className="text-fg-3" /><span className="font-mono">tillerdeck.json</span>
              <span className="ml-auto">{jsonErr ? <Tint color="var(--danger)">{t("invalid JSON")}</Tint> : dirty ? <Tint color="var(--w-accent)">{t("unsaved")}</Tint> : <Tint color="var(--ok)"><CircleCheck size={12} />{t("saved")}</Tint>}</span>
            </div>
            <textarea
              className="scroll selectable h-[calc(100vh-260px)] w-full resize-none rounded-xl bg-console p-4 font-mono text-[12px] leading-[1.6] text-[#c8c8cc] outline-none ring-1 ring-line focus:ring-accent"
              value={json}
              spellCheck={false}
              onChange={(e) => {
                setJson(e.target.value);
                try {
                  setDraft(JSON.parse(e.target.value));
                  setJsonErr(null);
                } catch (err) {
                  setJsonErr(errorText(err));
                }
              }}
            />
            {jsonErr && <p className="mt-2 text-[12px] text-danger">{jsonErr}</p>}
            <p className="mt-2 text-[12px] text-fg-3">{t("The form and the JSON are the same thing. Secrets never come here — they stay in the vault.")}</p>
          </div>
        )}
      </div>
      {wizard && <Wizard root={ws.project.root} name={ws.project.name} toast={ws.toast} autoTemplate={ws.state.auto?.template} current={ws.state.auto ? undefined : ws.manifest} onClose={() => setWizard(false)} onApplied={async () => { setWizard(false); await ws.refresh(); }} />}
    </section>
  );
}

// ---------------------------------------------------------------------------

function Card({ title, hint, action, children }: { title: ReactNode; hint?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="raise p-5">
      <div className="flex items-center gap-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {hint && <span className="text-[12px] text-fg-3">{hint}</span>}
        <span className="ml-auto">{action}</span>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

/** Listas de opções a partir do projecto real. */
function useOptions() {
  const ws = useWs();
  return useMemo(() => {
    const files = ws.project.files.filter((f) => !f.isDir);
    const inventories: Opt[] = files.filter((f) => f.kind === "inventory").map((f) => ({ value: f.path, label: f.path }));
    const yml = files.filter((f) => /\.ya?ml$/.test(f.path) && !f.vault);
    const releases: Opt[] = yml.filter((f) => f.kind === "release" || /release/.test(f.path)).map((f) => ({ value: f.path, label: f.path }));
    const ymlFiles: Opt[] = yml.map((f) => ({ value: f.path, label: f.path }));
    const vaults: Opt[] = files.filter((f) => f.vault).map((f) => ({ value: f.path, label: f.path }));
    const playbooks: Opt[] = files.filter((f) => f.kind === "playbook").map((f) => ({ value: f.path, label: f.path }));
    // Alvos do make, com o ambiente trocado por {env} quando acabam num alvo conhecido.
    const tokens = new Set([...ws.manifest.environments.map((e) => e.id), ...ws.manifest.products.flatMap((p) => Object.values(p.placements ?? {}).map((x) => x.token))]);
    const patterns = new Map<string, Set<string>>();
    for (const tg of ws.targets) {
      const tail = tg.split("-").pop()!;
      const key = tokens.has(tail) ? tg.slice(0, -tail.length) + "{env}" : tg;
      if (!patterns.has(key)) patterns.set(key, new Set());
      if (tokens.has(tail)) patterns.get(key)!.add(tail);
    }
    const targets: Opt[] = [...patterns.entries()].sort().map(([k, envs]) => ({ value: k, label: k, hint: [...envs].join(", ") }));
    const keys: Opt[] = [...new Set(Object.values(ws.state.releases).flatMap((r) => Object.keys(r)))].sort().map((k) => ({ value: k, label: k }));
    return { inventories, releases, ymlFiles, vaults, playbooks, targets, keys };
  }, [ws.project.files, ws.targets, ws.state.releases, ws.manifest]);
}

function General({ m, set }: { m: Manifest; set: (m: Manifest) => void }) {
  const envOpts: Opt[] = m.environments.map((e) => ({ value: e.id, label: e.label, icon: <EnvDot env={e} size={7} /> }));
  return (
    <>
      <Card title={t("Project")}>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t("Name")}><input className="field" value={m.name} onChange={(e) => set({ ...m, name: e.target.value })} /></Field>
          <Field label={t("Registry (for apps with one image per environment)")}>
            <input className="field font-mono" placeholder="https://registry.example.com" value={m.registry?.url ?? ""} onChange={(e) => set({ ...m, registry: e.target.value ? { url: e.target.value } : undefined })} />
          </Field>
        </div>
        {m.registry?.url && <p className="mt-2 text-[12px] text-fg-3">{t("Credentials come from docker login (config.json or Keychain). They are never stored in this file.")}</p>}
      </Card>
      <Card title={t("Promotion")} hint={t("the same image goes from one server to the other")}>
        <div className="flex flex-wrap items-center gap-3">
          <Select className="w-52" value={m.promotion[0]?.from ?? ""} placeholder={t("(none)")} options={[{ value: "", label: t("(none)") }, ...envOpts]}
            onChange={(v) => set({ ...m, promotion: v ? [{ from: v, to: m.promotion[0]?.to && m.promotion[0].to !== v ? m.promotion[0].to : m.environments.find((e) => e.id !== v)?.id ?? "" }] : [] })} />
          <span className="text-fg-3">→</span>
          <Select className="w-52" disabled={!m.promotion[0]} value={m.promotion[0]?.to ?? ""} options={envOpts.filter((o) => o.value !== m.promotion[0]?.from)}
            onChange={(v) => set({ ...m, promotion: [{ from: m.promotion[0].from, to: v }] })} />
        </div>
      </Card>
    </>
  );
}

function Servers({ m, set }: { m: Manifest; set: (m: Manifest) => void }) {
  const o = useOptions();
  const colors: Opt[] = Object.keys(ENV_COLOR).map((c) => ({ value: c, label: c, icon: <span className="size-2.5 rounded-full" style={{ background: ENV_COLOR[c] }} /> }));
  const upd = (i: number, patch: Partial<EnvDef>) => set({ ...m, environments: m.environments.map((e, j) => (j === i ? { ...e, ...patch } : e)) });
  return (
    <Card
      title={t("Servers")}
      hint={t("each one is a machine — the tabs at the top")}
      action={<button className="b b-sm" onClick={() => set({ ...m, environments: [...m.environments, { id: `server-${m.environments.length + 1}`, label: t("New server"), inventory: o.inventories[0]?.value ?? "", color: "neutral", protected: false }] })}><Plus size={14} />{t("Server")}</button>}
    >
      <div className="space-y-3">
        {m.environments.map((e, i) => (
          <div key={i} className="rounded-xl bg-raise-2/40 p-3 ring-1 ring-line">
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_150px_auto]">
              <Field label={t("Name")}><input className="field" value={e.label} onChange={(x) => upd(i, { label: x.target.value })} /></Field>
              <Field label={t("Id (replaces {env} in targets)")}><input className="field font-mono" value={e.id} onChange={(x) => upd(i, { id: slug(x.target.value) })} /></Field>
              <Field label={t("Colour")}><Select value={e.color} options={colors} onChange={(v) => upd(i, { color: v })} /></Field>
              <div className="flex items-end gap-3 pb-1.5">
                <label className="flex items-center gap-2 text-[12.5px]"><Toggle on={e.protected} onChange={(v) => upd(i, { protected: v })} />{t("protected")}</label>
                <button className="ib" title={t("Remove")} onClick={() => set({ ...m, environments: m.environments.filter((_, j) => j !== i) })}><Trash2 size={15} /></button>
              </div>
              <Field label={t("Inventory")} className="md:col-span-2"><Select mono value={e.inventory} options={o.inventories} onChange={(v) => upd(i, { inventory: v })} /></Field>
              <Field label={t("Release (versions)")} className="md:col-span-2"><Select mono value={e.release ?? ""} options={[{ value: "", label: t("(none)") }, ...o.releases]} onChange={(v) => upd(i, { release: v || undefined })} /></Field>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ActionEditor({ name, a, tokens, onChange }: { name: string; a?: Action; tokens: string[]; onChange: (a?: Action) => void }) {
  const o = useOptions();
  const mode = !a ? "none" : a.make !== undefined ? "make" : "playbook";
  return (
    <div className="grid items-center gap-2 md:grid-cols-[110px_130px_1fr_auto]">
      <span className="text-[12.5px] font-medium">{actionLabel(name)}</span>
      <Select value={mode} options={[{ value: "none", label: t("—") }, { value: "make", label: "make" }, { value: "playbook", label: "playbook" }]}
        onChange={(v) => onChange(v === "none" ? undefined : v === "make" ? { make: o.targets[0]?.value ?? "", envs: a?.envs } : { playbook: o.playbooks[0]?.value ?? "", envs: a?.envs })} />
      {mode === "make" && <Select mono value={a!.make ?? ""} options={o.targets} onChange={(v) => onChange({ ...a, make: v })} />}
      {mode === "playbook" && <Select mono value={a!.playbook ?? ""} options={o.playbooks} onChange={(v) => onChange({ ...a, make: undefined, playbook: v })} />}
      {mode === "none" && <span className="text-[12px] text-fg-3">{t("no button")}</span>}
      {mode !== "none" && tokens.length > 1 ? (
        <Chips options={tokens.map((x) => ({ value: x, label: x }))} value={a!.envs?.length ? a!.envs : tokens} onChange={(v) => onChange({ ...a, envs: v.length === tokens.length ? undefined : v })} />
      ) : <span />}
      {mode !== "none" && (name === "migrate" || name === "seed") && (
        <label className="flex items-center gap-2 text-[12px] text-fg-2 md:col-start-2 md:col-end-5">
          <Toggle on={!!a!.includesDeploy} onChange={(v) => onChange({ ...a, includesDeploy: v || undefined })} />
          {t("It also deploys (installs the release version), so no separate deploy runs before it")}
        </label>
      )}
    </div>
  );
}

/** De onde vêm as versões que o deploy deixa escolher (e a página das builds). */
function VersionsEditor({ s, onChange }: { s: Service; onChange: (v?: Versions) => void }) {
  const v = s.versions;
  const src = v?.source ?? (s.image ? "registry" : "none");
  const set = (patch: Partial<Versions>) => onChange({ source: src as Versions["source"], ...v, ...patch });
  return (
    <div className="space-y-2">
      <p className="sec-h">{t("Versions to choose from when deploying")}</p>
      <div className="grid gap-3 md:grid-cols-4">
        <Field label={t("Source")}>
          <Select value={src} onChange={(x) => (x === "none" && !s.image ? onChange(undefined) : set({ source: x as Versions["source"] }))}
            options={[{ value: "registry", label: t("Registry builds (image tags)") }, { value: "git", label: t("Git commits") }, { value: "none", label: t("None — keep the release version") }]} />
        </Field>
        {src === "registry" && (
          <Field label={t("Tag format")} className="md:col-span-2">
            <input className="field font-mono" placeholder="{version}-{commit}-{build}" value={v?.tagFormat ?? ""} onChange={(e) => set({ tagFormat: e.target.value || undefined })} spellCheck={false} />
          </Field>
        )}
        {src === "git" && (
          <>
            <Field label={t("Repository (relative to the project)")}><input className="field font-mono" placeholder="../my-api" value={v?.repo ?? ""} onChange={(e) => set({ repo: e.target.value || undefined })} spellCheck={false} /></Field>
            <Field label={t("Branch")}><input className="field font-mono" placeholder="main" value={v?.branch ?? ""} onChange={(e) => set({ branch: e.target.value || undefined })} spellCheck={false} /></Field>
            <Field label={t("Written to the release as")}>
              <Select value={v?.commitFormat ?? "short"} onChange={(x) => set({ commitFormat: x as "short" | "full" })} options={[{ value: "short", label: t("short commit (7)") }, { value: "full", label: t("full commit (40)") }]} />
            </Field>
          </>
        )}
        {src !== "none" && (
          <Field label={t("How many to show")}><input className="field" type="number" min={1} max={100} value={v?.limit ?? 20} onChange={(e) => set({ limit: Number(e.target.value) || undefined })} /></Field>
        )}
      </div>
      {src === "registry" && <p className="text-[11.5px] text-fg-3">{t("Fields: {version} {env} {commit} {build}. Only tags that match are listed; with {env}, only the server's own tags. Dates and commits from the image labels win over the tag.")}</p>}
    </div>
  );
}

function Products({ m, set }: { m: Manifest; set: (m: Manifest) => void }) {
  const o = useOptions();
  const [open, setOpen] = useState<string | null>(null);
  const servers: Opt[] = m.environments.map((e) => ({ value: e.id, label: e.label, icon: <EnvDot env={e} size={6} /> }));
  const updP = (i: number, patch: Partial<Product>) => set({ ...m, products: m.products.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const updS = (pi: number, si: number, patch: Partial<Service>) => updP(pi, { services: m.products[pi].services.map((s, j) => (j === si ? { ...s, ...patch } : s)) });
  return (
    <>
      {m.products.map((p, pi) => {
        const on = p.environments?.length ? p.environments : m.environments.map((e) => e.id);
        const tokens = on.map((s) => p.placements?.[s]?.token ?? s);
        return (
          <Card
            key={pi}
            title={<span className="flex items-center gap-2">{p.label}<span className="text-[12px] font-normal text-fg-3">{tn(p.services.length, "{n} service", "{n} services")}</span></span>}
            action={<button className="ib" title={t("Remove product")} onClick={() => set({ ...m, products: m.products.filter((_, j) => j !== pi) })}><Trash2 size={15} /></button>}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t("Name")}><input className="field" value={p.label} onChange={(e) => updP(pi, { label: e.target.value })} /></Field>
              <Field label={t("Description")}><input className="field" value={p.description} onChange={(e) => updP(pi, { description: e.target.value })} /></Field>
              <Field label={t("Exists on")} className="md:col-span-2">
                <Chips options={servers} value={on} onChange={(v) => updP(pi, { environments: v.length === m.environments.length ? undefined : v })} />
              </Field>
            </div>
            {on.map((sid) => {
              const pl = p.placements?.[sid];
              const srv = m.environments.find((e) => e.id === sid);
              return (
                <div key={sid} className="mt-3 rounded-xl p-3 ring-1 ring-line">
                  <label className="flex items-center gap-2 text-[12.5px]">
                    <Toggle on={!!pl} onChange={(v) => {
                      const next = { ...(p.placements ?? {}) };
                      if (v) next[sid] = { token: sid, inventory: srv?.inventory ?? "", release: srv?.release };
                      else delete next[sid];
                      updP(pi, { placements: Object.keys(next).length ? next : undefined });
                    }} />
                    {t("On {env}, it lives in its own inventory/release", { env: srv?.label ?? sid })}
                  </label>
                  {pl && (
                    <div className="mt-3 grid gap-3 md:grid-cols-3">
                      <Field label={t("Target id ({env})")}><input className="field font-mono" value={pl.token} onChange={(e) => updP(pi, { placements: { ...p.placements, [sid]: { ...pl, token: slug(e.target.value) } } })} /></Field>
                      <Field label={t("Inventory")}><Select mono value={pl.inventory} options={o.inventories} onChange={(v) => updP(pi, { placements: { ...p.placements, [sid]: { ...pl, inventory: v } } })} /></Field>
                      <Field label={t("Release")}><Select mono value={pl.release ?? ""} options={[{ value: "", label: t("(none)") }, ...o.releases]} onChange={(v) => updP(pi, { placements: { ...p.placements, [sid]: { ...pl, release: v || undefined } } })} /></Field>
                    </div>
                  )}
                </div>
              );
            })}

            <p className="sec-h mb-2 mt-5">{t("Services")}</p>
            <div className="space-y-1.5">
              {p.services.map((s, si) => {
                const k = `${pi}.${si}`;
                const expanded = open === k;
                return (
                  <div key={si} className="rounded-xl ring-1 ring-line">
                    <button className="flex w-full items-center gap-3 px-3 py-2 text-left" onClick={() => setOpen(expanded ? null : k)}>
                      <TechIcon kind={s.kind} size="sm" />
                      <span className="font-medium">{s.label}</span>
                      <span className="text-[12px] text-fg-3">{techLabel(s.kind)}{s.releaseKey ? ` · ${s.releaseKey}` : ""}</span>
                      <span className="ml-auto text-[12px] text-fg-3">{Object.keys(s.actions).map(actionLabel).join(" · ")}</span>
                    </button>
                    {expanded && (
                      <div className="space-y-4 border-t hair p-3">
                        <div className="grid gap-3 md:grid-cols-3">
                          <Field label={t("Name")}><input className="field" value={s.label} onChange={(e) => updS(pi, si, { label: e.target.value })} /></Field>
                          <Field label={t("Technology")}><Select value={s.kind} options={KINDS.map((x) => ({ value: x, label: techLabel(x), icon: <TechIcon kind={x} size="sm" /> }))} onChange={(v) => updS(pi, si, { kind: v })} /></Field>
                          <Field label={t("Version key in the release")}><Select mono value={s.releaseKey ?? ""} options={[{ value: "", label: t("(no version)") }, ...o.keys]} onChange={(v) => updS(pi, si, { releaseKey: v || undefined })} /></Field>
                          <Field label={t("Container")}><input className="field font-mono" value={s.container ?? ""} onChange={(e) => updS(pi, si, { container: e.target.value || undefined })} /></Field>
                          <Field label={t("Image in the registry")}><input className="field font-mono" value={s.image ?? ""} onChange={(e) => updS(pi, si, { image: e.target.value || undefined })} /></Field>
                          <Field label={t("Description")}><input className="field" value={s.description ?? ""} onChange={(e) => updS(pi, si, { description: e.target.value || undefined })} /></Field>
                        </div>
                        <label className="flex items-center gap-2 text-[12.5px]"><Toggle on={!!s.perEnvImage} onChange={(v) => updS(pi, si, { perEnvImage: v })} />{t("The tag carries the environment (-staging-): promoting asks the registry")}</label>
                        <VersionsEditor s={s} onChange={(versions) => updS(pi, si, { versions })} />
                        <div className="space-y-2">
                          <p className="sec-h">{t("Buttons")}</p>
                          {ACTIONS.map((a) => (
                            <ActionEditor key={a} name={a} a={s.actions[a]} tokens={tokens}
                              onChange={(next) => {
                                const actions = { ...s.actions };
                                if (next) actions[a] = next;
                                else delete actions[a];
                                updS(pi, si, { actions });
                              }} />
                          ))}
                        </div>
                        <div className="flex justify-end"><button className="b b-sm" onClick={() => updP(pi, { services: p.services.filter((_, j) => j !== si) })}><Trash2 size={13} />{t("Remove service")}</button></div>
                      </div>
                    )}
                  </div>
                );
              })}
              <button className="b b-sm mt-1" onClick={() => {
                updP(pi, { services: [...p.services, { id: `service-${p.services.length + 1}`, label: t("New service"), kind: "service", actions: {} }] });
                setOpen(`${pi}.${p.services.length}`);
              }}><Plus size={14} />{t("Service")}</button>
            </div>
          </Card>
        );
      })}
      <button className="b" onClick={() => set({ ...m, products: [...m.products, { id: `product-${m.products.length + 1}`, label: t("New product"), description: "", services: [] }] })}><Plus size={15} />{t("Product")}</button>
    </>
  );
}

function Operations({ m, set }: { m: Manifest; set: (m: Manifest) => void }) {
  const o = useOptions();
  const servers: Opt[] = m.environments.map((e) => ({ value: e.id, label: e.label, icon: <EnvDot env={e} size={6} /> }));
  const groups: Opt[] = ["machine", "backup", "observability", "verify", "maintenance", "other"].map((g) => ({ value: g, label: { machine: t("Provisioning"), backup: t("Backups"), observability: t("Observability"), verify: t("Verify"), maintenance: t("Maintenance"), other: t("Other") }[g]! }));
  const upd = (i: number, patch: Partial<Operation>) => set({ ...m, operations: m.operations.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <Card title={t("Operations")} hint={t("machine, backups, observability, checks")}
      action={<button className="b b-sm" onClick={() => set({ ...m, operations: [...m.operations, { id: `op-${m.operations.length + 1}`, label: t("New operation"), group: "other", description: "", action: { make: o.targets[0]?.value ?? "" }, destructive: false }] })}><Plus size={14} />{t("Operation")}</button>}>
      <div className="space-y-2">
        {m.operations.map((op, i) => (
          <div key={i} className="grid items-center gap-2 rounded-xl p-3 ring-1 ring-line md:grid-cols-[1fr_150px_1.3fr_auto]">
            <input className="field" value={op.label} onChange={(e) => upd(i, { label: e.target.value })} />
            <Select value={op.group} options={groups} onChange={(v) => upd(i, { group: v })} />
            <Select mono value={op.action.make ?? ""} options={o.targets} onChange={(v) => upd(i, { action: { ...op.action, make: v } })} />
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[12px]" title={t("Deletes or restores data: asks for the typed word everywhere")}><Toggle on={op.destructive} onChange={(v) => upd(i, { destructive: v })} />{t("destructive")}</label>
              <button className="ib" onClick={() => set({ ...m, operations: m.operations.filter((_, j) => j !== i) })}><Trash2 size={15} /></button>
            </div>
            <input className="field md:col-span-2" placeholder={t("Description")} value={op.description} onChange={(e) => upd(i, { description: e.target.value })} />
            <div className="md:col-span-2"><Chips options={servers} value={op.action.envs?.length ? op.action.envs : m.environments.map((e) => e.id)} onChange={(v) => upd(i, { action: { ...op.action, envs: v.length === m.environments.length ? undefined : v } })} /></div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Variáveis do projecto: os valores mudam-se aqui e gravam-se logo no ficheiro. */
function Variables({ m, set, dirty }: { m: Manifest; set: (m: Manifest) => void; dirty: boolean }) {
  const ws = useWs();
  const o = useOptions();
  const [secret, setSecret] = useState<{ v: Variable; server: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const vars = m.variables ?? [];
  const groups = [...new Set(vars.map((v) => v.group || t("Other")))];
  const value = (v: Variable, server: string) => ws.state.values[v.files[server]]?.[v.key];

  async function write(v: Variable, server: string, val: string) {
    try {
      await ws.toast(t("Saving…"));
      await api.varSet(ws.project.root, v.files[server], v.key, val);
      await ws.refresh();
      ws.toast(t("{key} = {val} in {file}. It applies on the next deploy.", { key: v.key, val, file: v.files[server] }));
    } catch (e) {
      ws.toast(errorText(e), true);
    }
  }

  return (
    <>
      <div className="raise p-4 text-[12.5px] text-fg-2">
        {t("These are values in your Ansible files (host_vars). Changing one writes that line in the file right away — comments stay — and it takes effect on the next deploy or provisioning. Secrets are written encrypted into the vault and never shown.")}
        {dirty && <p className="mt-2 text-warn">{t("Save the settings before adding or removing variables.")}</p>}
      </div>
      {groups.map((g) => (
        <Card key={g} title={<span className="font-mono text-[14px]">{g}</span>}>
          <div className="space-y-1">
            {vars.filter((v) => (v.group || t("Other")) === g).map((v) => (
              <div key={v.id} className="flex flex-wrap items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover">
                <div className="min-w-[240px] flex-1">
                  <p className="font-medium">{v.label}</p>
                  <p className="font-mono text-[11.5px] text-fg-3">{v.key}</p>
                </div>
                {Object.keys(v.files).map((server) => {
                  const env = m.environments.find((e) => e.id === server);
                  const val = value(v, server);
                  return (
                    <div key={server} className="flex items-center gap-2 rounded-lg bg-raise-2 px-2.5 py-1.5 text-[12.5px]" title={v.files[server]}>
                      {env && <EnvDot env={env} size={6} />}
                      <span className="text-fg-2">{env?.label ?? server}</span>
                      {v.kind === "bool" && <Toggle on={val === "true"} onChange={(x) => write(v, server, String(x))} />}
                      {v.kind === "text" && <input className="field !h-7 !w-56 font-mono !text-[12px]" defaultValue={val ?? ""} onBlur={(e) => e.target.value !== (val ?? "") && write(v, server, JSON.stringify(e.target.value))} />}
                      {v.kind === "secret" && <button className="b b-sm" onClick={() => setSecret({ v, server })}><KeyRound size={13} />{t("Change…")}</button>}
                    </div>
                  );
                })}
                <button className="ib" title={t("Remove from the app (the file stays)")} disabled={dirty} onClick={() => set({ ...m, variables: vars.filter((x) => x.id !== v.id) })}><X size={14} /></button>
              </div>
            ))}
          </div>
        </Card>
      ))}
      <button className="b" disabled={dirty} onClick={() => setAdding(true)}><Plus size={15} />{t("Variable")}</button>
      {secret && <SecretDialog v={secret.v} server={secret.server} onClose={() => setSecret(null)} />}
      {adding && <AddVariable m={m} files={o.ymlFiles} vaults={o.vaults} onClose={() => setAdding(false)} onAdd={(v) => { set({ ...m, variables: [...vars, v] }); setAdding(false); }} />}
    </>
  );
}

export function SecretDialog({ v, server, onClose }: { v: Variable; server: string; onClose: () => void }) {
  const ws = useWs();
  const [has, setHas] = useState<boolean | null>(null);
  const [val, setVal] = useState("");
  const file = v.files[server];
  useEffect(() => {
    api.vaultKeyHas(ws.project.root, file, v.key).then(setHas).catch(() => setHas(null));
  }, []);
  async function save() {
    try {
      await api.vaultKeySet(ws.project.root, file, v.key, val);
      ws.toast(t("{key} written encrypted in {file}", { key: v.key, file }));
      onClose();
    } catch (e) {
      ws.toast(errorText(e), true);
    }
  }
  return (
    <Modal onClose={onClose} width={500}>
      <div className="p-6">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-raise-2"><KeyRound size={18} /></span>
          <div className="min-w-0 flex-1"><p className="text-[16px] font-semibold">{v.label}</p><p className="truncate font-mono text-[12px] text-fg-3">{file} · {v.key}</p></div>
          <button className="ib" onClick={onClose}><X size={16} /></button>
        </div>
        <p className="mt-4 text-[12.5px] text-fg-2">
          {has === null ? t("checking the vault…") : has ? t("It has a value. The current value is never shown — type a new one to replace it.") : t("It has no value yet.")}
        </p>
        <input className="field mt-3 font-mono" type="password" autoFocus placeholder={t("new value")} value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && val && save()} />
        <p className="mt-2 text-[12px] text-fg-3">{t("Decrypted in memory, the line is replaced, then encrypted again. Nothing is written in plain text.")}</p>
        <div className="mt-5 flex justify-end gap-2"><button className="b" onClick={onClose}>{t("Cancel")}</button><button className="b b-pri" disabled={!val} onClick={save}>{t("Save encrypted")}</button></div>
      </div>
    </Modal>
  );
}

function AddVariable({ m, files, vaults, onClose, onAdd }: { m: Manifest; files: Opt[]; vaults: Opt[]; onClose: () => void; onAdd: (v: Variable) => void }) {
  const [v, setV] = useState<Variable>({ id: "", label: "", group: "", kind: "bool", key: "", files: {} });
  const opts = v.kind === "secret" ? vaults : files;
  return (
    <Modal onClose={onClose} width={560}>
      <div className="space-y-3 p-6">
        <p className="text-[16px] font-semibold">{t("New variable")}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Name")}><input className="field" value={v.label} onChange={(e) => setV({ ...v, label: e.target.value })} /></Field>
          <Field label={t("Group")}><input className="field" value={v.group} onChange={(e) => setV({ ...v, group: e.target.value })} /></Field>
          <Field label={t("Kind")}><Select value={v.kind} options={[{ value: "bool", label: t("On / off") }, { value: "text", label: t("Text") }, { value: "secret", label: t("Secret (vault)") }]} onChange={(k) => setV({ ...v, kind: k, files: {} })} /></Field>
          <Field label={t("Key")}><input className="field font-mono" value={v.key} onChange={(e) => setV({ ...v, key: e.target.value.trim() })} /></Field>
        </div>
        {m.environments.map((e) => (
          <Field key={e.id} label={t("File on {env}", { env: e.label })}>
            <Select mono value={v.files[e.id] ?? ""} options={[{ value: "", label: t("(not on this server)") }, ...opts]} onChange={(f) => {
              const next = { ...v.files };
              if (f) next[e.id] = f;
              else delete next[e.id];
              setV({ ...v, files: next });
            }} />
          </Field>
        ))}
        <div className="flex justify-end gap-2 pt-2">
          <button className="b" onClick={onClose}>{t("Cancel")}</button>
          <button className="b b-pri" disabled={!v.label || !v.key || !Object.keys(v.files).length} onClick={() => onAdd({ ...v, id: v.key + (m.variables?.some((x) => x.id === v.key) ? `-${Date.now()}` : "") })}>{t("Add")}</button>
        </div>
      </div>
    </Modal>
  );
}

