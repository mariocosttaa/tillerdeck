import { useEffect, useMemo, useState } from "react";
import { CircleCheck, CircleSlash, CircleX, Copy, LoaderCircle, RefreshCw, ScrollText } from "lucide-react";
import { useWs } from "../context";
import { duration, looksDestructive, relTime } from "../lib";
import type { HistoryEntry } from "../../api";
import { EnvDot } from "../ui";

type F = "todas" | "falhadas" | string;

export function Runs() {
  const ws = useWs();

  /** Correr outra vez passa pela mesma confirmação que o botão original. */
  function rerun(h: HistoryEntry) {
    const target = h.argv[1];
    const vars = h.argv.slice(2).map((kv) => kv.split("=") as [string, string]).filter(([k]) => k !== "CONFIRM");
    const env = ws.manifest.environments.find((e) => e.id === h.meta?.env);
    const destructive = looksDestructive(`${target} ${h.meta?.action ?? ""}`);
    ws.confirm({
      title: `Correr outra vez · ${h.meta?.title ?? target}`,
      subtitle: `${env?.label ?? "sem ambiente"} · make ${target}`,
      env,
      word: env && (env.protected || destructive) ? env.id : undefined,
      danger: destructive,
      command: ["make", target, ...vars.map(([k, v]) => `${k}=${v}`)].join(" "),
      details: ws.makeInfo.get(target)?.recipe,
      confirmLabel: "Correr outra vez",
      onConfirm: () => {
        const all = [...vars];
        if (ws.makeInfo.get(target)?.usesConfirm) all.push(["CONFIRM", "yes"]);
        ws.start({ kind: "make", target, vars: all }, h.meta ?? { title: h.label });
      },
    });
  }
  const [f, setF] = useState<F>("todas");
  const mine = useMemo(() => ws.history.filter((h) => h.root === ws.project.root), [ws.history, ws.project.root]);
  const list = mine.filter((h) => f === "todas" || (f === "falhadas" ? h.endedAt && h.exitCode !== 0 : h.meta?.env === f));
  const [selId, setSel] = useState<string | null>(null);
  const sel = list.find((h) => h.id === selId) ?? list[0];
  const run = sel ? ws.runs[sel.id] : undefined;
  useEffect(() => {
    if (sel && !run) ws.openLog(sel);
  }, [sel?.id, !!run]);

  const icon = (h: (typeof mine)[number]) =>
    !h.endedAt ? <LoaderCircle size={16} className="animate-spin text-accent" />
    : h.cancelled ? <CircleSlash size={16} className="text-warn" />
    : h.exitCode === 0 ? <CircleCheck size={16} className="text-ok" />
    : <CircleX size={16} className="text-danger" />;

  return (
    <>
      <section className="scroll min-w-0 flex-1 overflow-auto px-6 pb-10 pt-5">
        <div className="seg">
          <button className={f === "todas" ? "on" : ""} onClick={() => setF("todas")}>Todas <span className="text-fg-3">{mine.length}</span></button>
          <button className={f === "falhadas" ? "on" : ""} onClick={() => setF("falhadas")}>Falhadas</button>
          {ws.manifest.environments.map((e) => (
            <button key={e.id} className={f === e.id ? "on" : ""} onClick={() => setF(e.id)}><EnvDot env={e} size={6} />{e.label}</button>
          ))}
        </div>
        <div className="mt-4 space-y-1">
          {list.length === 0 && <p className="px-2 text-fg-3">Nada corrido a partir da app{f !== "todas" ? " com este filtro" : ""}.</p>}
          {list.map((h) => {
            const e = ws.manifest.environments.find((x) => x.id === h.meta?.env);
            return (
              <button key={h.id} className={`row grid w-full grid-cols-[20px_minmax(0,1.6fr)_130px_120px_90px] items-center gap-3 px-3 py-2.5 text-left ${sel?.id === h.id ? "sel" : ""}`} onClick={() => setSel(h.id)}>
                {icon(h)}
                <span className="min-w-0 truncate font-medium">{h.meta?.title ?? h.label}</span>
                <span className="flex items-center gap-1.5 text-[12.5px]">{e ? <><EnvDot env={e} size={6} />{e.label}</> : <span className="text-fg-3">—</span>}</span>
                <span className="text-[12.5px] text-fg-3">{relTime(h.startedAt)}</span>
                <span className="text-right text-[12.5px] tabular-nums text-fg-3">{duration(h)}</span>
              </button>
            );
          })}
        </div>
      </section>
      {sel && (
        <aside className="flex w-[420px] shrink-0 flex-col border-l hair p-5">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-raise-2">{icon(sel)}</span>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold">{sel.meta?.title ?? sel.label}</p>
              <p className="text-[12px] text-fg-3">{new Date(sel.startedAt).toLocaleString("pt-PT")} · {duration(sel) || "a correr"}</p>
            </div>
          </div>
          <p className="mt-3 truncate font-mono text-[11.5px] text-fg-3 selectable" title={sel.argv.join(" ")}>{sel.argv.join(" ")}</p>
          <ol className="scroll mt-4 max-h-[260px] space-y-0.5 overflow-auto text-[12.5px]">
            {(run?.steps ?? []).map((s, i) => (
              <li key={i} className="flex items-center gap-2.5 px-1 py-1">
                {s.state === "ok" ? <CircleCheck size={14} className="text-ok" /> : s.state === "failed" ? <CircleX size={14} className="text-danger" /> : <LoaderCircle size={14} className="animate-spin text-accent" />}
                <span className={`min-w-0 flex-1 truncate ${s.state === "failed" ? "font-medium text-danger" : ""}`}>{s.name}</span>
              </li>
            ))}
          </ol>
          <pre className="scroll selectable mt-4 min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-xl bg-console p-3 font-mono text-[11px] leading-[1.55] text-[#c8c8cc]">
            {(run?.lines ?? []).slice(-60).join("\n").replace(/\x1b\[[0-9;]*m/g, "")}
          </pre>
          <div className="mt-4 flex gap-2">
            <button className="b flex-1 justify-center" onClick={() => ws.focusRun(sel.id)}><ScrollText size={14} />Log completo</button>
            <button className="b" onClick={() => navigator.clipboard.writeText(sel.argv.join(" "))}><Copy size={14} />Copiar comando</button>
            {sel.endedAt && sel.exitCode !== 0 && sel.argv[0] === "make" && (
              <button className="b" title="Volta a correr o mesmo comando, com confirmação" onClick={() => rerun(sel)}>
                <RefreshCw size={14} />
              </button>
            )}
          </div>
        </aside>
      )}
    </>
  );
}
