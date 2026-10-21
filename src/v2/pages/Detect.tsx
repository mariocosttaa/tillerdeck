import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Plus, Save, Trash2, Wand2 } from "lucide-react";
import { api, errorText, type Manifest, type TemplateReport } from "../../api";
import { opGroupLabel } from "../lib";
import { EnvDot, Modal, TechIcon, Tint } from "../ui";
import { lang, t } from "../i18n";

type Key = string;
const svcKey = (p: string, s: string) => `svc:${p}/${s}`;

/** Tira o que a pessoa desmarcou, com as referências a servidores que saíram. */
function keep(m: Manifest, out: Set<Key>, labels: Record<Key, string>): Manifest {
  const envs = m.environments.filter((e) => !out.has(`env:${e.id}`)).map((e) => ({ ...e, label: labels[`env:${e.id}`] ?? e.label }));
  const ids = new Set(envs.map((e) => e.id));
  const envsOf = (list?: string[]) => list?.filter((e) => ids.has(e));
  const products = m.products
    // um produto só de servidores que saíram também sai (vazio quereria dizer "em todos")
    .filter((p) => !p.environments?.length || p.environments.some((e) => ids.has(e)))
    .map((p) => ({
      ...p,
      environments: envsOf(p.environments),
      placements: p.placements && Object.fromEntries(Object.entries(p.placements).filter(([e]) => ids.has(e))),
      services: p.services
        .filter((s) => !out.has(svcKey(p.id, s.id)))
        .map((s) => ({
          ...s,
          label: labels[svcKey(p.id, s.id)] ?? s.label,
          // uma acção só de servidores que saíram também sai
          actions: Object.fromEntries(Object.entries(s.actions).filter(([, a]) => !a.envs?.length || a.envs.some((e) => ids.has(e))).map(([k, a]) => [k, { ...a, envs: envsOf(a.envs) }])),
        })),
    }))
    .filter((p) => p.services.length);
  const variables = (m.variables ?? [])
    .filter((v) => !out.has(`var:${v.id}`))
    .map((v) => ({ ...v, files: Object.fromEntries(Object.entries(v.files).filter(([e]) => ids.has(e))) }))
    .filter((v) => Object.keys(v.files).length);
  return {
    ...m,
    environments: envs,
    promotion: m.promotion.filter((p) => ids.has(p.from) && ids.has(p.to)),
    products,
    operations: m.operations
      .filter((o) => !out.has(`op:${o.id}`) && (!o.action.envs?.length || o.action.envs.some((e) => ids.has(e))))
      .map((o) => ({ ...o, label: labels[`op:${o.id}`] ?? o.label, action: { ...o.action, envs: envsOf(o.action.envs) } })),
    variables,
  };
}

/** Só o que o ficheiro actual ainda não tem (por id). */
function onlyNew(found: Manifest, cur: Manifest): Manifest {
  const envs = new Set(cur.environments.map((e) => e.id));
  const svcs = new Set(cur.products.flatMap((p) => p.services.map((s) => svcKey(p.id, s.id))));
  const ops = new Set(cur.operations.map((o) => o.id));
  const vars = new Set((cur.variables ?? []).map((v) => v.id));
  return {
    ...found,
    environments: found.environments.filter((e) => !envs.has(e.id)),
    promotion: [],
    products: found.products.map((p) => ({ ...p, services: p.services.filter((s) => !svcs.has(svcKey(p.id, s.id))) })).filter((p) => p.services.length),
    operations: found.operations.filter((o) => !ops.has(o.id)),
    variables: (found.variables ?? []).filter((v) => !vars.has(v.id)),
  };
}

/** Junta o que é novo ao ficheiro actual, sem tocar no que lá está. */
function merge(cur: Manifest, add: Manifest): Manifest {
  const products = cur.products.map((p) => {
    const more = add.products.find((x) => x.id === p.id);
    return more ? { ...p, services: [...p.services, ...more.services] } : p;
  });
  for (const p of add.products) if (!cur.products.some((x) => x.id === p.id)) products.push(p);
  return {
    ...cur,
    environments: [...cur.environments, ...add.environments],
    products,
    operations: [...cur.operations, ...add.operations],
    variables: [...(cur.variables ?? []), ...(add.variables ?? [])],
  };
}

/**
 * Detectar: a app lê o Makefile, os playbooks e os roles e propõe servidores,
 * produtos, serviços, operações e variáveis — cada um com a evidência de onde
 * veio. Desmarca-se o que não interessa, muda-se um nome, e grava-se.
 *
 * - boas-vindas (`autoTemplate`): o projecto já abriu com isto; gravar é opcional;
 * - `first`: sem ficheiro válido;
 * - `current`: de novo, nas Definições — só mostra o que é novo e junta-o.
 */
export function Wizard({ root, name, toast, onClose, onApplied, autoTemplate, current }: {
  root: string;
  name: string;
  toast: (t: string, bad?: boolean) => void;
  onClose: () => void;
  onApplied: () => void;
  /** sem ficheiro válido (é o caso quando não vem `autoTemplate` nem `current`) */
  first?: boolean;
  autoTemplate?: string;
  current?: Manifest;
}) {
  const welcome = !!autoTemplate;
  const again = !!current && !welcome;
  const [template, setTemplate] = useState("auto");
  const [report, setReport] = useState<TemplateReport | null | undefined>(undefined);
  const [out, setOut] = useState<Set<Key>>(new Set());
  const [labels, setLabels] = useState<Record<Key, string>>({});
  const [replace, setReplace] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    setReport(undefined);
    api.templateReport(root, template, lang()).then(setReport).catch(() => setReport(null));
  }, [template]);

  // o que se mostra: tudo, ou (de novo) só o que falta no ficheiro
  const shown = useMemo(() => (report ? (again && !replace ? onlyNew(report.manifest, current!) : report.manifest) : null), [report, again, replace]);
  const ev = report?.evidence ?? {};
  const toggle = (k: Key, on: boolean) => setOut((s) => { const n = new Set(s); if (on) n.delete(k); else n.add(k); return n; });
  const nothingNew = again && !replace && shown && !shown.environments.length && !shown.products.length && !shown.operations.length && !(shown.variables ?? []).length;

  async function save(keepGoing: boolean) {
    if (!shown) return;
    const picked = keep(shown, out, labels);
    const final = again && !replace ? merge(current!, picked) : picked;
    try {
      await api.manifestSave(root, final);
      toast(again && !replace ? t("Added to ansible-mario.json") : t("ansible-mario.json saved"));
      if (keepGoing) onApplied();
    } catch (e) {
      toast(errorText(e), true);
    }
  }

  const row = (k: Key, title: string, sub: ReactNode, icon?: ReactNode, editable = false) => (
    <label key={k} className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-hover">
      <input type="checkbox" className="mt-1.5 size-4 shrink-0 accent-[var(--w-accent)]" checked={!out.has(k)} onChange={(e) => toggle(k, e.target.checked)} />
      {icon}
      <span className="min-w-0 flex-1">
        {editable ? (
          <input
            className="w-full rounded-md bg-transparent px-1 -mx-1 font-medium outline-none focus:ring-1 focus:ring-accent"
            value={labels[k] ?? title}
            onChange={(e) => setLabels((l) => ({ ...l, [k]: e.target.value }))}
            onClick={(e) => e.preventDefault()}
          />
        ) : (
          <span className="block font-medium">{title}</span>
        )}
        <span className="block truncate text-[11.5px] text-fg-3" title={(ev[k] ?? []).join("\n")}>{sub}</span>
      </span>
    </label>
  );
  const evidence = (k: Key, fallback = "") => (ev[k]?.length ? ev[k].join(" · ") : fallback);
  const section = (key: string, title: string, n: number, children: ReactNode) =>
    n > 0 && (
      <div key={key}>
        <p className="sec-h mb-1 mt-4 flex items-center gap-2">{title}<span className="text-fg-3">{n}</span></p>
        {children}
      </div>
    );

  const services = shown ? shown.products.reduce((a, p) => a + p.services.length, 0) : 0;
  const sources = (report?.sources ?? []).join(", ");

  return (
    <Modal onClose={onClose} width={720}>
      <div className="flex max-h-[86vh] flex-col">
        <div className="px-7 pt-7">
          <span className="grid size-10 place-items-center rounded-xl text-accent" style={{ background: "color-mix(in srgb, var(--w-accent) 15%, transparent)" }}><Wand2 size={20} /></span>
          <h2 className="mt-4 text-[20px] font-semibold tracking-tight">
            {welcome ? t("We read {name}", { name }) : again ? t("Detect again") : t("{name} has no settings yet", { name })}
          </h2>
          <p className="mt-1 text-fg-2">
            {welcome
              ? t("This is what the app found in your project. Untick what you don't want and rename anything — nothing is written until you save, and everything can be changed later in Settings.")
              : again
                ? replace ? t("Everything the app finds, replacing the current ansible-mario.json.") : t("What the app finds that isn't in ansible-mario.json yet. Your current settings stay as they are.")
                : <>{t("This is what the app found in your project.")} {t("Without settings, Files mode is still available.")}</>}
          </p>
          {report && (
            <p className="mt-2 text-[12px] text-fg-3">
              {sources ? t("Read from {sources}.", { sources }) : null}{" "}
              {shown && t("{a} servers · {b} services · {c} operations", { a: shown.environments.length, b: services, c: shown.operations.length })}
            </p>
          )}
        </div>

        <div className="scroll mt-3 min-h-[160px] flex-1 overflow-auto border-y hair px-5 pb-4">
          {report === undefined && <p className="p-6 text-center text-fg-3">{t("Reading the project…")}</p>}
          {report === null && <p className="p-6 text-center text-danger">{t("Could not read the project.")}</p>}
          {nothingNew && <p className="p-6 text-center text-fg-3">{t("Nothing new — ansible-mario.json already has everything the app found.")}</p>}
          {shown && (
            <>
              {section("servers", t("Servers"), shown.environments.length, shown.environments.map((e) => row(`env:${e.id}`, e.label, evidence(`env:${e.id}`, e.inventory), <span className="mt-1.5 shrink-0"><EnvDot env={e} size={8} /></span>, true)))}
              {shown.products.map((p) => section(`p:${p.id}`, p.label, p.services.length,
                p.services.map((s) => row(svcKey(p.id, s.id), s.label, <>{s.releaseKey && <span className="mr-1.5 font-mono text-fg-2">{s.releaseKey}</span>}{evidence(svcKey(p.id, s.id))}</>, <TechIcon kind={s.kind} size="sm" />, true)),
              ))}
              {section("ops", t("Operations"), shown.operations.length, shown.operations.map((o) => row(`op:${o.id}`, o.label, <>{opGroupLabel(o.group)}{o.destructive && <Tint color="var(--danger)" className="mx-1.5 !h-4 !px-1.5 text-[10.5px]">{t("destructive")}</Tint>} · {evidence(`op:${o.id}`, o.action.make ?? o.action.playbook ?? "")}</>, undefined, true)))}
              {section("vars", t("Variables"), (shown.variables ?? []).length, (shown.variables ?? []).map((v) => row(`var:${v.id}`, v.label, <><span className="font-mono">{v.key}</span> · {evidence(`var:${v.id}`)}</>)))}
              {report && report.warnings.map((w) => <p key={w} className="mt-3 text-[12px] text-warn">{w}</p>)}
            </>
          )}
        </div>

        <div className="px-7 pb-6 pt-4">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button className="b b-ghost mr-auto !px-2 text-[12px]" onClick={() => setAdvanced((x) => !x)}>{t("Advanced…")}</button>
            {welcome ? (
              <>
                <button className="b" onClick={onClose}>{t("Start without saving")}</button>
                <button className="b b-pri" disabled={!shown} onClick={() => save(true)}><Save size={15} />{t("Accept and save")}</button>
              </>
            ) : again ? (
              <>
                <button className="b" onClick={onClose}>{t("Cancel")}</button>
                <button className="b b-pri" disabled={!shown || !!nothingNew} onClick={() => save(true)}>{replace ? <Save size={15} /> : <Plus size={15} />}{replace ? t("Replace ansible-mario.json") : t("Add to ansible-mario.json")}</button>
              </>
            ) : (
              <>
                <button className="b" onClick={onClose}>{t("Not now")}</button>
                <button className="b b-pri" disabled={!shown || !report?.compatible} onClick={() => save(true)}><Plus size={15} />{t("Create ansible-mario.json")}</button>
              </>
            )}
          </div>
          {advanced && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-raise-2 p-3 text-[12.5px]">
              <span className="text-fg-2">{t("Read as")}</span>
              <div className="seg">
                {[["auto", t("Automatic")], ["makefile-convention", t("Makefile convention")], ["playbooks", t("One button per playbook")]].map(([id, label]) => (
                  <button key={id} className={template === id ? "on" : ""} onClick={() => { setTemplate(id); setOut(new Set()); }}>{label}</button>
                ))}
              </div>
              {again && (
                <label className="flex items-center gap-2 text-fg-2">
                  <input type="checkbox" className="accent-[var(--w-accent)]" checked={replace} onChange={(e) => { setReplace(e.target.checked); setOut(new Set()); }} />
                  {t("Replace everything")}
                </label>
              )}
            </div>
          )}
          {welcome && <p className="mt-3 text-[12px] text-fg-3">{t("Saving puts ansible-mario.json in the project folder (not committed), so the team sees the same.")}</p>}
          {again && replace && <p className="mt-3 flex items-center gap-1.5 text-[12px] text-warn"><Trash2 size={12} />{t("Your manual changes to the current file are lost.")}</p>}
        </div>
      </div>
    </Modal>
  );
}
