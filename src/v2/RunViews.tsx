import { useEffect, useMemo, useRef, useState } from "react";
import { AnsiUp } from "ansi_up";
import { CircleCheck, CircleDashed, CircleX, LoaderCircle, ScrollText, Square, X } from "lucide-react";
import { api, errorText } from "../api";
import type { Run } from "./store";
import { useWs } from "./context";
import { duration } from "./lib";

const ansi = new AnsiUp();
ansi.use_classes = true;

function elapsed(from: string) {
  const s = Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function statusOf(r: Run) {
  if (r.running) return { label: "a correr", color: "var(--w-accent)" };
  if (r.entry.cancelled) return { label: "cancelada", color: "var(--warn)" };
  if (r.entry.exitCode === 0) return { label: "ok", color: "var(--ok)" };
  return { label: `falhou${r.entry.exitCode != null ? ` (${r.entry.exitCode})` : ""}`, color: "var(--danger)" };
}

/** O cartão flutuante: a corrida em foco, com o passo actual e o progresso. */
export function RunCard({ run, onLog, onClose }: { run: Run; onLog: () => void; onClose: () => void }) {
  const ws = useWs();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!run.running) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [run.running]);
  const st = statusOf(run);
  const cur = run.steps[run.steps.length - 1];
  const done = run.steps.filter((s) => s.state === "ok").length;
  const title = run.entry.meta?.title ?? run.entry.label;
  const env = ws.manifest.environments.find((e) => e.id === run.entry.meta?.env);

  async function cancel() {
    try {
      ws.toast(`${await api.runCancel(run.entry.id)} enviado`);
    } catch (e) {
      ws.toast(errorText(e), true);
    }
  }

  return (
    <div className="panel am-in absolute bottom-4 right-4 z-30 w-[440px] overflow-hidden" style={{ background: "var(--w-raise)" }}>
      <div className="flex items-center gap-3 p-4">
        <span className="relative grid size-10 shrink-0 place-items-center">
          {run.running ? (
            <>
              <svg className="absolute inset-0 animate-spin" viewBox="0 0 40 40" style={{ animationDuration: "1.6s" }}>
                <circle cx="20" cy="20" r="17" fill="none" stroke="var(--w-line-2)" strokeWidth="3" />
                <circle cx="20" cy="20" r="17" fill="none" stroke="var(--w-accent)" strokeWidth="3" strokeLinecap="round" strokeDasharray="107" strokeDashoffset="75" />
              </svg>
              <span className="text-[11px] font-semibold tabular-nums">{done}</span>
            </>
          ) : run.entry.exitCode === 0 ? (
            <CircleCheck size={26} className="text-ok" />
          ) : (
            <CircleX size={26} style={{ color: st.color }} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">
            {title} {env && <span className="font-normal text-fg-3">· {env.label}</span>}
          </p>
          <p className="flex items-center gap-1.5 truncate text-[12.5px] text-fg-2">
            {run.running ? (
              <>
                <LoaderCircle size={13} className="animate-spin text-accent" />
                {cur ? cur.name : "a arrancar…"} · {elapsed(run.entry.startedAt)}
              </>
            ) : (
              <span style={{ color: st.color }}>{st.label} · {duration(run.entry)} · {run.steps.length} passos</span>
            )}
          </p>
        </div>
        <button className="b b-sm" onClick={onLog}><ScrollText size={14} />Log</button>
        {run.running ? (
          <button className="ib !size-8" title="Cancelar (SIGINT, depois SIGTERM)" onClick={cancel}><Square size={14} /></button>
        ) : (
          <button className="ib !size-8" onClick={onClose}><X size={15} /></button>
        )}
      </div>
      {run.running && (
        <div className="h-1 overflow-hidden bg-line">
          <div className="h-full w-1/3 animate-[am-bar_1.4s_ease-in-out_infinite]" style={{ background: "linear-gradient(90deg,var(--w-accent-2),var(--w-accent))" }} />
        </div>
      )}
    </div>
  );
}

/** O log completo de uma corrida, com os passos à esquerda. */
export function LogPanel({ run, onClose }: { run: Run; onClose: () => void }) {
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const html = useMemo(() => run.lines.map((l) => ansi.ansi_to_html(l)).join("\n"), [run.lines]);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [html, follow]);
  const st = statusOf(run);
  return (
    <div className="am-in absolute inset-x-3 bottom-3 top-3 z-30 flex flex-col overflow-hidden rounded-[14px] ring-1 ring-line-2" style={{ background: "var(--w-raise)", boxShadow: "0 30px 80px -20px rgba(0,0,0,.7)" }}>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b hair px-4">
        <span className="pill" style={{ color: st.color, background: `color-mix(in srgb, ${st.color} 14%, transparent)` }}>{st.label}</span>
        <span className="font-semibold">{run.entry.meta?.title ?? run.entry.label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-3 selectable">{run.entry.argv.join(" ")}</span>
        <label className="flex items-center gap-1.5 text-[12px] text-fg-2"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />seguir</label>
        <button className="ib" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="flex min-h-0 flex-1">
        <ol className="scroll w-[300px] shrink-0 space-y-0.5 overflow-auto border-r hair p-3 text-[12.5px]">
          {run.steps.length === 0 && <li className="px-2 py-1 text-fg-3">Sem passos do Ansible (ainda).</li>}
          {run.steps.map((s, i) => (
            <li key={i} className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 ${s.state === "running" ? "bg-raise-2 font-medium" : ""}`}>
              {s.state === "ok" ? <CircleCheck size={15} className="shrink-0 text-ok" /> : s.state === "failed" ? <CircleX size={15} className="shrink-0 text-danger" /> : run.running ? <LoaderCircle size={15} className="shrink-0 animate-spin text-accent" /> : <CircleDashed size={15} className="shrink-0 text-fg-3" />}
              <span className="min-w-0 flex-1 truncate" title={s.name}>{s.name}</span>
              {s.endedAt && <span className="shrink-0 text-[11px] text-fg-3 tabular-nums">{((s.endedAt - s.startedAt) / 1000).toFixed(1)} s</span>}
            </li>
          ))}
        </ol>
        <pre
          ref={ref}
          className="scroll selectable m-0 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-console p-4 font-mono text-[12px] leading-[1.55] text-[#c8c8cc]"
          onScroll={(e) => {
            const el = e.currentTarget;
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            if (bottom !== follow) setFollow(bottom);
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
