import { useEffect, useMemo, useState } from "react";
import {
  api,
  errorText,
  looksLikeProduction,
  shellQuote,
  stem,
  type CheckResult,
  type InventoryGroup,
  type Project,
  type RunSpec,
} from "../api";
import type { ConfirmRequest } from "./ConfirmRun";

interface Props {
  project: Project;
  suggestedPlaybook: string | null;
  onRun: (spec: RunSpec) => void;
  requestConfirm: (r: ConfirmRequest) => void;
}

type Form = Extract<RunSpec, { kind: "playbook" }>;

const ENV_WORDS = ["production", "staging", "testes", "test", "dev", "development", "qa", "uat", "prod", "stage"];

function envOf(path: string): string | null {
  const s = stem(path).toLowerCase();
  return ENV_WORDS.find((w) => s === w || s.endsWith("-" + w) || s.endsWith("_" + w) || s.startsWith(w + "-")) ?? null;
}

export default function RunPanel({ project, suggestedPlaybook, onRun, requestConfirm }: Props) {
  const playbooks = project.files.filter((f) => f.kind === "playbook").map((f) => f.path);
  const inventories = project.files.filter((f) => f.kind === "inventory").map((f) => f.path);
  const varFiles = project.files.filter((f) => f.kind === "release").map((f) => f.path);

  // O inventário NUNCA vem escolhido: escolher o ambiente é sempre um acto.
  const [form, setForm] = useState<Form>({
    kind: "playbook",
    playbook: suggestedPlaybook ?? "",
    inventory: "",
    extraVarFiles: [],
    limit: "",
    tags: "",
    skipTags: "",
    check: false,
    diff: false,
    verbosity: 0,
    extraArgs: "",
  });
  const [groups, setGroups] = useState<InventoryGroup[] | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (suggestedPlaybook) set("playbook", suggestedPlaybook);
  }, [suggestedPlaybook]);

  useEffect(() => {
    setGroups(null);
    if (!form.inventory) return;
    let live = true;
    api.inventory(project.root, form.inventory).then((g) => live && setGroups(g)).catch(() => live && setGroups([]));
    return () => {
      live = false;
    };
  }, [form.inventory, project.root]);

  // O release do mesmo ambiente, quando há um com o mesmo nome: é o par que
  // o Makefile destes projectos garante, e aqui é uma sugestão visível.
  useEffect(() => {
    if (!form.inventory) return;
    const env = stem(form.inventory);
    const match = varFiles.find((v) => stem(v) === env);
    setForm((f) => ({ ...f, extraVarFiles: match ? [match] : [] }));
  }, [form.inventory]);

  const hosts = useMemo(() => [...new Set((groups ?? []).flatMap((g) => g.hosts))], [groups]);
  const groupNames = (groups ?? []).map((g) => g.name).filter((n) => n !== "all" && n !== "ungrouped");

  const argv = useMemo(() => {
    const a = ["ansible-playbook", form.playbook || "<playbook>", "-i", form.inventory || "<inventário>"];
    form.extraVarFiles.forEach((f) => a.push("-e", "@" + f));
    if (form.limit.trim()) a.push("--limit", form.limit.trim());
    if (form.tags.trim()) a.push("--tags", form.tags.trim());
    if (form.skipTags.trim()) a.push("--skip-tags", form.skipTags.trim());
    if (form.check) a.push("--check");
    if (form.diff) a.push("--diff");
    if (form.verbosity) a.push("-" + "v".repeat(form.verbosity));
    return a.map(shellQuote).join(" ") + (form.extraArgs.trim() ? " " + form.extraArgs.trim() : "");
  }, [form]);

  const invEnv = form.inventory ? envOf(form.inventory) : null;
  const mismatched = form.extraVarFiles.filter((f) => {
    const e = envOf(f);
    return invEnv && e && e !== invEnv;
  });
  const prod = looksLikeProduction(form.inventory, form.limit, ...form.extraVarFiles, ...hosts, ...groupNames);

  const warnings: string[] = [];
  if (mismatched.length)
    warnings.push(`O inventário é de "${invEnv}" mas ${mismatched.join(", ")} é de outro ambiente.`);
  if (prod) warnings.push("Isto aponta para PRODUÇÃO.");
  if (form.check) warnings.push("--check: simula, mas liga-se às máquinas e corre os callbacks na mesma.");

  async function syntaxCheck() {
    setChecking(true);
    setCheck(null);
    try {
      setCheck(await api.syntaxCheck(project.root, form.playbook, form.inventory || undefined));
    } catch (e) {
      setCheck({ ok: false, output: errorText(e) });
    } finally {
      setChecking(false);
    }
  }

  function run() {
    // A palavra é o nome do inventário — a mesma que se lê no comando.
    const word = prod || mismatched.length ? stem(form.inventory) : undefined;
    requestConfirm({
      title: form.check ? "Simular playbook" : "Executar playbook",
      command: argv,
      word,
      warnings,
      details: hosts.length ? [`hosts: ${hosts.join(", ")}`] : undefined,
      onConfirm: () => onRun(form),
    });
  }

  const ready = !!form.playbook && !!form.inventory;

  return (
    <div className="panel run-panel">
      <h2>Executar playbook</h2>
      <div className="grid">
        <label>
          Playbook
          <select value={form.playbook} onChange={(e) => set("playbook", e.target.value)}>
            <option value="">— escolhe —</option>
            {playbooks.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          Inventário
          <select
            value={form.inventory}
            onChange={(e) => set("inventory", e.target.value)}
            className={!form.inventory ? "needs" : looksLikeProduction(form.inventory) ? "prod" : ""}
          >
            <option value="">— escolhe o ambiente —</option>
            {inventories.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>

        {varFiles.length > 0 && (
          <div className="full">
            <span className="lbl">Variáveis extra (-e @ficheiro)</span>
            <div className="chips">
              {varFiles.map((v) => {
                const on = form.extraVarFiles.includes(v);
                return (
                  <button
                    key={v}
                    className={`chip ${on ? "on" : ""} ${mismatched.includes(v) ? "bad" : ""}`}
                    onClick={() =>
                      set("extraVarFiles", on ? form.extraVarFiles.filter((x) => x !== v) : [...form.extraVarFiles, v])
                    }
                  >
                    {v}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <label>
          --limit
          <input list="hosts-list" value={form.limit} onChange={(e) => set("limit", e.target.value)} placeholder="todos os hosts do play" spellCheck={false} />
          <datalist id="hosts-list">
            {[...groupNames, ...hosts].map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </label>
        <label>
          --tags
          <input value={form.tags} onChange={(e) => set("tags", e.target.value)} placeholder="tag1,tag2" spellCheck={false} />
        </label>
        <label>
          --skip-tags
          <input value={form.skipTags} onChange={(e) => set("skipTags", e.target.value)} spellCheck={false} />
        </label>
        <label>
          Verbosidade
          <select value={form.verbosity} onChange={(e) => set("verbosity", Number(e.target.value))}>
            {[0, 1, 2, 3, 4].map((v) => (
              <option key={v} value={v}>{v ? "-" + "v".repeat(v) : "normal"}</option>
            ))}
          </select>
        </label>
        <div className="checks full">
          <label className="inline"><input type="checkbox" checked={form.check} onChange={(e) => set("check", e.target.checked)} /> --check (simular)</label>
          <label className="inline"><input type="checkbox" checked={form.diff} onChange={(e) => set("diff", e.target.checked)} /> --diff</label>
        </div>
        <label className="full">
          Argumentos extra
          <input value={form.extraArgs} onChange={(e) => set("extraArgs", e.target.value)} placeholder='-e app_tag=1.4.2 --start-at-task "…"' spellCheck={false} />
        </label>
      </div>

      {hosts.length > 0 && (
        <p className="muted small">
          {hosts.length} host{hosts.length > 1 ? "s" : ""} no inventário: {hosts.join(", ")}
        </p>
      )}
      {warnings.map((w) => (
        <p key={w} className="warn">⚠ {w}</p>
      ))}

      <pre className="cmd">{argv}</pre>

      <div className="actions">
        <button disabled={!form.playbook || checking} onClick={syntaxCheck}>
          {checking ? "A verificar…" : "Verificar sintaxe"}
        </button>
        <button className={prod ? "danger" : "primary"} disabled={!ready} onClick={run}>
          {form.check ? "Simular…" : "Executar…"}
        </button>
      </div>
      {check && <pre className={`check ${check.ok ? "ok" : "err"}`}>{check.ok ? "✓ sintaxe válida\n" : "✗ "}{check.output}</pre>}
    </div>
  );
}
