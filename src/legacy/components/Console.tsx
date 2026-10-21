import { useEffect, useMemo, useRef, useState } from "react";
import { AnsiUp } from "ansi_up";
import type { HistoryEntry } from "../../api";

export interface RunView {
  entry: HistoryEntry;
  lines: string[];
  running: boolean;
}

interface Props {
  run: RunView | null;
  onCancel: (id: string) => void;
  onClose: () => void;
  height: number;
  onResize: (h: number) => void;
}

const ansi = new AnsiUp();
ansi.use_classes = true;

export function statusOf(e: HistoryEntry, running: boolean): { text: string; cls: string } {
  if (running) return { text: "a correr", cls: "running" };
  if (e.cancelled) return { text: "cancelada", cls: "cancelled" };
  if (e.exitCode === 0) return { text: "ok", cls: "ok" };
  if (e.exitCode === null) return { text: "interrompida", cls: "cancelled" };
  return { text: `falhou (${e.exitCode})`, cls: "failed" };
}

export default function Console({ run, onCancel, onClose, height, onResize }: Props) {
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const [find, setFind] = useState("");

  const html = useMemo(() => {
    if (!run) return "";
    const lines = find ? run.lines.filter((l) => l.toLowerCase().includes(find.toLowerCase())) : run.lines;
    return lines.map((l) => ansi.ansi_to_html(l)).join("\n");
  }, [run?.lines, find]);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [html, follow]);

  function startDrag(e: React.MouseEvent) {
    const y0 = e.clientY;
    const h0 = height;
    const move = (ev: MouseEvent) => onResize(Math.max(120, Math.min(window.innerHeight - 160, h0 + y0 - ev.clientY)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  if (!run) return null;
  const st = statusOf(run.entry, run.running);

  return (
    <section className="console" style={{ height }}>
      <div className="drag" onMouseDown={startDrag} />
      <header>
        <span className={`status ${st.cls}`}>{st.text}</span>
        <code className="console-cmd" title={run.entry.argv.join(" ")}>{run.entry.argv.join(" ")}</code>
        <input className="find" placeholder="Filtrar linhas" value={find} onChange={(e) => setFind(e.target.value)} spellCheck={false} />
        <label className="inline small">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> seguir
        </label>
        {run.running && (
          <button className="danger" onClick={() => onCancel(run.entry.id)} title="1.º SIGINT · 2.º SIGTERM · 3.º SIGKILL">
            Cancelar
          </button>
        )}
        <button onClick={onClose} title="Fechar a consola">✕</button>
      </header>
      <pre
        ref={ref}
        className="output"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (atBottom !== follow) setFollow(atBottom);
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </section>
  );
}
