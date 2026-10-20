import { useEffect, useState } from "react";
import { api, errorText, type ConfigSetting, type Environment, type HistoryEntry, type Project } from "../api";
import { statusOf } from "./Console";

interface Props {
  project: Project;
  history: HistoryEntry[];
  runningIds: Set<string>;
  onShowRun: (e: HistoryEntry) => void;
}

function fmt(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (v === null || v === undefined) return "";
  return String(v);
}

function duration(e: HistoryEntry): string {
  if (!e.endedAt) return "";
  const s = Math.round((new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime()) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export default function Overview({ project, history, runningIds, onShowRun }: Props) {
  const [config, setConfig] = useState<ConfigSetting[] | null>(null);
  const [configErr, setConfigErr] = useState<string | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);

  useEffect(() => {
    setConfig(null);
    setConfigErr(null);
    api.configDump(project.root).then(setConfig).catch((e) => setConfigErr(errorText(e)));
  }, [project.root]);
  useEffect(() => {
    api.environment().then(setEnv);
  }, []);

  const count = (k: string) => project.files.filter((f) => f.kind === k).length;
  const callbacks = config?.find((c) => c.name === "CALLBACKS_ENABLED");
  const mine = history.filter((h) => h.root === project.root);
  const missing = env?.tools.filter((t) => !t.path && t.name !== "ansible-lint") ?? [];

  return (
    <div className="panel overview">
      <h2>{project.name}</h2>
      <p className="muted small mono">{project.root}</p>
      {!project.hasConfig && <p className="warn">⚠ Sem ansible.cfg — o Ansible usa a configuração global.</p>}
      {missing.length > 0 && (
        <p className="warn">⚠ Não encontrei: {missing.map((t) => t.name).join(", ")}. PATH usado: <code>{env?.path}</code></p>
      )}

      <div className="stats">
        {[
          ["playbook", "playbooks"],
          ["inventory", "inventários"],
          ["release", "releases"],
          ["vault", "vaults"],
          ["vars", "ficheiros de vars"],
        ].map(([k, l]) => (
          <div key={k} className="stat">
            <b>{count(k)}</b>
            <span>{l}</span>
          </div>
        ))}
      </div>

      {callbacks && fmt(callbacks.value) && (
        <p className="note">
          Callbacks activos: <code>{fmt(callbacks.value)}</code>. Correm em todas as execuções feitas aqui, como no terminal.
        </p>
      )}

      <h3>Últimas execuções</h3>
      {mine.length === 0 ? (
        <p className="muted">Ainda nada corrido a partir da app.</p>
      ) : (
        <table className="history">
          <tbody>
            {mine.slice(0, 50).map((h) => {
              const st = statusOf(h, runningIds.has(h.id));
              return (
                <tr key={h.id} onClick={() => onShowRun(h)}>
                  <td><span className={`status ${st.cls}`}>{st.text}</span></td>
                  <td className="mono">{h.label}</td>
                  <td className="muted small">{new Date(h.startedAt).toLocaleString("pt-PT")}</td>
                  <td className="muted small">{duration(h)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h3>ansible.cfg efectivo</h3>
      {configErr && <pre className="err">{configErr}</pre>}
      {!config && !configErr && <p className="muted">a ler…</p>}
      {config && (
        <table className="cfg">
          <tbody>
            {config
              .filter((c) => c.name !== "CONFIG_FILE")
              .map((c) => (
                <tr key={c.name}>
                  <td className="mono">{c.name}</td>
                  <td className="mono">{fmt(c.value)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}

      {env && (
        <>
          <h3>Ferramentas</h3>
          <p className="muted small">{env.ansibleVersion}</p>
          <table className="cfg">
            <tbody>
              {env.tools.map((t) => (
                <tr key={t.name}>
                  <td className="mono">{t.name}</td>
                  <td className={`mono ${t.path ? "" : "err"}`}>{t.path ?? "não encontrado"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
