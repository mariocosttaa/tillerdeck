import { useEffect, useMemo, useState } from "react";
import { api, looksLikeProduction, shellQuote, type MakeTarget, type Project, type RunSpec } from "../../api";
import type { ConfirmRequest } from "./ConfirmRun";

interface Props {
  project: Project;
  onRun: (spec: RunSpec) => void;
  requestConfirm: (r: ConfirmRequest) => void;
}

interface MakeVar {
  name: string;
  value: string;
}

/** As variáveis com omissão (`VAR ?= x`) são as que o Makefile espera receber. */
function parseVars(text: string): MakeVar[] {
  const out: MakeVar[] = [];
  for (const m of text.matchAll(/^([A-Z][A-Z0-9_]*)[ \t]*\?=[ \t]*(.*)$/gm)) {
    if (m[1] !== "CONFIRM") out.push({ name: m[1], value: m[2].trim() });
  }
  return out;
}

/** O ambiente no fim do nome do alvo: `deploy-api-staging` → `staging`. */
function envSuffix(name: string): string | null {
  const last = name.split(/[-_]/).pop() ?? "";
  return /^(production|prod|staging|stage|testes|test|dev|qa|uat|local)$/.test(last) ? last : null;
}

export default function MakePanel({ project, onRun, requestConfirm }: Props) {
  const [targets, setTargets] = useState<MakeTarget[]>([]);
  const [vars, setVars] = useState<MakeVar[]>([]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<MakeTarget | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    api.makeTargets(project.root).then(setTargets);
    api.readFile(project.root, "Makefile").then((t) => setVars(parseVars(t))).catch(() => setVars([]));
    setSelected(null);
  }, [project.root]);

  const sections = useMemo(() => {
    const q = filter.toLowerCase();
    const map = new Map<string, MakeTarget[]>();
    for (const t of targets) {
      if (q && !t.name.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q)) continue;
      const s = t.section || "Alvos";
      if (!map.has(s)) map.set(s, []);
      map.get(s)!.push(t);
    }
    return [...map.entries()];
  }, [targets, filter]);

  if (!targets.length) {
    return (
      <div className="panel">
        <h2>Makefile</h2>
        <p className="muted">Este projecto não tem um Makefile com alvos.</p>
      </div>
    );
  }

  const usedVars = selected ? vars.filter((v) => selected.recipe.some((r) => r.includes(`$(${v.name})`)) || v.name === "ARGS") : [];
  const passed = usedVars.filter((v) => (values[v.name] ?? "").trim() !== "").map((v) => [v.name, values[v.name].trim()] as [string, string]);

  function run(t: MakeTarget) {
    const env = envSuffix(t.name);
    const prod = looksLikeProduction(t.name);
    const varsToPass: [string, string][] = [...passed];
    const warnings: string[] = [];
    if (t.usesConfirm) {
      // A trava do Makefile é um `read` num terminal que aqui não existe.
      // A app pede a mesma palavra e passa-lhe CONFIRM=yes.
      varsToPass.push(["CONFIRM", "yes"]);
      warnings.push("O Makefile pede confirmação no terminal; a app confirma aqui e passa CONFIRM=yes.");
    }
    if (prod) warnings.push("Isto aponta para PRODUÇÃO.");
    // Apagar e repor não se desfazem: pedem a palavra mesmo fora da produção.
    const destructive = /apaga|reset|restore|restauro|destroy|delete|drop|wipe|purge/i.test(`${t.name} ${t.description}`);
    if (destructive) warnings.push("Este alvo apaga ou repõe dados.");
    const cmd = ["make", t.name, ...varsToPass.map(([k, v]) => `${k}=${v}`)].map(shellQuote).join(" ");
    requestConfirm({
      title: `make ${t.name}`,
      command: cmd,
      word: t.usesConfirm || prod || destructive ? env ?? t.name : undefined,
      warnings,
      details: t.recipe,
      onConfirm: () => onRun({ kind: "make", target: t.name, vars: varsToPass }),
    });
  }

  return (
    <div className="panel make-panel">
      <div className="make-list">
        <input className="filter" placeholder={`Filtrar ${targets.length} alvos…`} value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
        <div className="side-scroll">
          {sections.map(([s, list]) => (
            <div key={s} className="group">
              <div className="group-head static">{s}<span className="count">{list.length}</span></div>
              {list.map((t) => (
                <button key={t.name} className={`row target ${selected?.name === t.name ? "active" : ""}`} onClick={() => setSelected(t)} title={t.description}>
                  <span className={`env-dot ${looksLikeProduction(t.name) ? "prod" : envSuffix(t.name) ? "nonprod" : ""}`} />
                  <span className="row-label">{t.name}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="make-detail">
        {!selected ? (
          <p className="muted pad">Escolhe um alvo para ver o que ele faz antes de o correr.</p>
        ) : (
          <>
            <h2>make {selected.name}</h2>
            {selected.description && <p>{selected.description}</p>}
            <span className="lbl">Receita</span>
            <pre className="details">{selected.recipe.join("\n") || "(sem receita)"}</pre>
            {usedVars.length > 0 && (
              <div className="grid">
                {usedVars.map((v) => (
                  <label key={v.name}>
                    {v.name}
                    <input
                      value={values[v.name] ?? ""}
                      placeholder={v.value || "(vazio)"}
                      onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
                      spellCheck={false}
                    />
                  </label>
                ))}
              </div>
            )}
            <div className="actions">
              <button className={looksLikeProduction(selected.name) ? "danger" : "primary"} onClick={() => run(selected)}>
                Executar…
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
