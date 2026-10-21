import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, CornerDownLeft, Play, Search } from "lucide-react";
import { ACTION_META, canRun, opAvailable, runOperation, runServiceAction, useWs, type Page } from "./context";
import { EnvDot, TechIcon } from "./ui";

interface Cmd {
  id: string;
  title: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

/** ⌘K: ir para um ecrã, mudar de ambiente, ou correr qualquer acção. */
export function Palette({ onClose }: { onClose: () => void }) {
  const ws = useWs();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const cmds = useMemo<Cmd[]>(() => {
    const out: Cmd[] = [];
    const pages: [Page, string][] = [["servicos", "Serviços"], ["promover", "Promover"], ["backups", "Backups"], ["maquina", "Máquina"], ["execucoes", "Execuções"], ["definicoes", "Definições"], ["ficheiros", "Ficheiros"]];
    for (const p of ws.manifest.products) {
      for (const s of p.services) {
        for (const a of Object.keys(s.actions)) {
          if (!canRun(ws, s, a)) continue;
          out.push({
            id: `svc:${p.id}.${s.id}:${a}`,
            title: `${ACTION_META[a]?.verb ?? a} ${s.label}`,
            hint: `${p.label} · ${ws.env.label}`,
            icon: <TechIcon kind={s.kind} size="sm" />,
            run: () => runServiceAction(ws, p, s, a),
          });
        }
      }
    }
    for (const o of ws.manifest.operations) {
      if (!opAvailable(ws, o)) continue;
      out.push({ id: `op:${o.id}`, title: o.label, hint: `${ws.env.label} · ${o.description}`, icon: <Play size={14} className="text-fg-3" />, run: () => runOperation(ws, o) });
    }
    for (const e of ws.manifest.environments) {
      if (e.id !== ws.env.id) out.push({ id: `env:${e.id}`, title: `Mudar para ${e.label}`, icon: <EnvDot env={e} size={7} />, run: () => ws.setEnv(e.id) });
    }
    for (const [p, l] of pages) out.push({ id: `go:${p}`, title: `Ir para ${l}`, icon: <ArrowRight size={14} className="text-fg-3" />, run: () => ws.go(p) });
    return out;
  }, [ws]);

  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return cmds.filter((c) => words.every((w) => `${c.title} ${c.hint ?? ""}`.toLowerCase().includes(w))).slice(0, 60);
  }, [cmds, q]);

  useEffect(() => setI(0), [q]);

  function key(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(list.length - 1, x + 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && list[i]) { onClose(); list[i].run(); }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/40 pt-[14vh]" onMouseDown={onClose}>
      <div className="panel am-in h-fit w-[620px] overflow-hidden" style={{ background: "var(--w-raise)" }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b hair px-4">
          <Search size={17} className="text-fg-3" />
          <input ref={input} className="h-13 flex-1 bg-transparent text-[15px] outline-none placeholder:text-fg-3" placeholder={`Correr em ${ws.env.label}, ir para… (ex.: deploy api)`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} />
          <span className="kbd">esc</span>
        </div>
        <div className="scroll max-h-[420px] overflow-auto p-2">
          {list.length === 0 && <p className="px-3 py-6 text-center text-fg-3">Nada encontrado.</p>}
          {list.map((c, j) => (
            <button key={c.id} className="flex w-full items-center gap-3 rounded-[9px] px-3 py-2 text-left" style={j === i ? { background: "color-mix(in srgb, var(--w-accent) 16%, transparent)" } : {}} onMouseEnter={() => setI(j)} onClick={() => { onClose(); c.run(); }}>
              <span className="grid w-6 place-items-center">{c.icon}</span>
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              {c.hint && <span className="max-w-[45%] truncate text-[12px] text-fg-3">{c.hint}</span>}
              {j === i && <CornerDownLeft size={14} className="text-fg-3" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
