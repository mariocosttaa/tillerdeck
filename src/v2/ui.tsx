import { useEffect, useRef, useState, type ReactNode } from "react";
import { siMongodb, siMysql, siNestjs, siNextdotjs, siNginx, siNodedotjs, siPostgresql, siRedis, siVite } from "simple-icons";
import { Boxes, Check, ChevronDown, Cog, Search, X } from "lucide-react";
import { t } from "./i18n";
import type { EnvDef } from "../api";
import { envColor } from "./lib";

type Icon = { path: string; hex: string };
const TECH: Record<string, { icon?: Icon; color: string; label: string; badge?: boolean }> = {
  nestjs: { icon: siNestjs, color: "#e0234e", label: "API NestJS" },
  worker: { icon: siNestjs, color: "#f0617f", label: "Worker", badge: true },
  nextjs: { icon: siNextdotjs, color: "var(--w-fg)", label: "App Next.js" },
  vite: { icon: siVite, color: "#9a6bff", label: "App Vite" },
  nginx: { icon: siNginx, color: "#1fb35b", label: "nginx" },
  postgres: { icon: siPostgresql, color: "#5b8def", label: "Postgres" },
  redis: { icon: siRedis, color: "#ff5a48", label: "Redis" },
  mysql: { icon: siMysql, color: "#4f8fd0", label: "MySQL" },
  mongodb: { icon: siMongodb, color: "#47a248", label: "MongoDB" },
  node: { icon: siNodedotjs, color: "#5fa04e", label: "Node.js" },
  service: { color: "var(--w-fg-2)", label: "Service" },
};
export const techLabel = (kind: string) => t((TECH[kind] ?? TECH.service).label);
export const KINDS = Object.keys(TECH);

export function TechIcon({ kind, size = "md" }: { kind: string; size?: "sm" | "md" | "lg" }) {
  const t = TECH[kind] ?? TECH.service;
  const box = size === "lg" ? "size-12 rounded-[13px]" : size === "sm" ? "size-6 rounded-[7px]" : "size-[34px] rounded-[10px]";
  const glyph = size === "lg" ? 24 : size === "sm" ? 13 : 17;
  return (
    <span className={`relative grid shrink-0 place-items-center ${box}`} style={{ color: t.color, background: `color-mix(in srgb, ${t.color} 14%, transparent)` }}>
      {t.icon ? (
        <svg viewBox="0 0 24 24" width={glyph} height={glyph} fill="currentColor" aria-hidden><path d={t.icon.path} /></svg>
      ) : (
        <Boxes size={glyph} />
      )}
      {t.badge && (
        <span className="absolute -bottom-1 -right-1 grid size-[15px] place-items-center rounded-full text-white" style={{ background: t.color, boxShadow: "0 0 0 2px var(--w-panel)" }}>
          <Cog size={10} strokeWidth={2.5} />
        </span>
      )}
    </span>
  );
}

export function EnvDot({ env, size = 8 }: { env?: EnvDef; size?: number }) {
  const c = envColor(env);
  return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: c, boxShadow: `0 0 0 3px color-mix(in srgb, ${c} 22%, transparent)` }} />;
}

export function Tint({ color, children, className = "" }: { color: string; children: ReactNode; className?: string }) {
  return (
    <span className={`pill ${className}`} style={{ color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}>
      {children}
    </span>
  );
}

export function Modal({ onClose, children, width = 520 }: { onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/55 backdrop-blur-[3px]" onMouseDown={onClose}>
      <div className="panel am-in max-h-[calc(100vh-80px)] overflow-auto scroll" style={{ width, background: "var(--w-raise)" }} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export interface ConfirmSpec {
  title: string;
  subtitle?: string;
  env?: EnvDef;
  icon?: ReactNode;
  /** palavra a escrever; sem ela basta um clique */
  word?: string;
  from?: string;
  to?: string;
  facts?: { icon: ReactNode; text: string; tone?: "ok" | "muted" | "warn" }[];
  command?: string;
  details?: string[];
  confirmLabel: string;
  danger?: boolean;
  /** campos a preencher (variáveis do make) */
  fields?: { name: string; label: string; placeholder?: string; options?: string[]; value?: string }[];
  onConfirm: (values: Record<string, string>) => void;
}

export function Confirm({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries((spec.fields ?? []).map((f) => [f.name, f.value ?? ""])));
  const input = useRef<HTMLInputElement>(null);
  const ok = !spec.word || typed.trim() === spec.word;
  const glow = spec.env ? `glow-${spec.env.color}` : "glow-neutral";
  useEffect(() => {
    input.current?.focus();
  }, []);
  function go() {
    if (!ok) return;
    onClose();
    spec.onConfirm(values);
  }
  return (
    <Modal onClose={onClose}>
      <div className={`${spec.danger || spec.env?.protected ? "glow-production" : glow} px-6 pb-5 pt-6`} style={{ borderRadius: "14px 14px 0 0" }}>
        <div className="flex items-center gap-3">
          {spec.icon}
          <div className="min-w-0 flex-1">
            <p className="text-[16px] font-semibold">{spec.title}</p>
            {spec.subtitle && <p className="truncate text-[12.5px] text-fg-2">{spec.subtitle}</p>}
          </div>
          <button className="ib" onClick={onClose}><X size={16} /></button>
        </div>
        {spec.from !== undefined && spec.to !== undefined && (
          <div className="mt-5 flex items-center gap-3">
            <div className="flex-1 rounded-xl bg-panel p-3 ring-1 ring-line"><p className="text-[11.5px] text-fg-3">{t("Now")}</p><p className="font-mono text-[20px] font-medium">{spec.from || "—"}</p></div>
            <span className="grid size-8 place-items-center rounded-full bg-raise-2">→</span>
            <div className="flex-1 rounded-xl bg-panel p-3" style={{ boxShadow: "0 0 0 1px color-mix(in srgb, var(--ok) 45%, transparent)" }}><p className="text-[11.5px] text-fg-3">{t("Will be")}</p><p className="font-mono text-[20px] font-medium text-ok">{spec.to}</p></div>
          </div>
        )}
      </div>
      {spec.facts && spec.facts.length > 0 && (
        <div className="space-y-2 px-6 pt-4 text-[13px]">
          {spec.facts.map((f, i) => (
            <p key={i} className={`flex items-center gap-2.5 ${f.tone === "ok" ? "" : f.tone === "warn" ? "text-warn" : "text-fg-2"}`}>{f.icon}{f.text}</p>
          ))}
        </div>
      )}
      {spec.fields && spec.fields.length > 0 && (
        <div className="grid grid-cols-2 gap-3 px-6 pt-4">
          {spec.fields.map((f) => (
            <label key={f.name} className={f.options ? "" : "col-span-2"}>
              <span className="label">{f.label}</span>
              {f.options ? (
                <div className="seg">
                  {f.options.map((o) => (
                    <button key={o} className={values[f.name] === o ? "on" : ""} onClick={() => setValues({ ...values, [f.name]: o })}>{o}</button>
                  ))}
                </div>
              ) : (
                <input className="field font-mono" placeholder={f.placeholder} value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} spellCheck={false} />
              )}
            </label>
          ))}
        </div>
      )}
      <div className="px-6 pb-6 pt-5">
        {spec.word && (
          <>
            <p className="text-[12.5px] font-medium">{t("To confirm, type")} <span className="font-mono" style={{ color: "var(--env-production)" }}>{spec.word}</span></p>
            <input
              ref={input}
              className="field mt-2 h-10 font-mono text-[14px]"
              style={{ boxShadow: "0 0 0 2px color-mix(in srgb, var(--env-production) 55%, transparent)" }}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && go()}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </>
        )}
        {spec.command && <p className="mt-3 truncate font-mono text-[11.5px] text-fg-3 selectable">{spec.command}</p>}
        {spec.details && spec.details.length > 0 && (
          <details className="mt-2 text-[12px] text-fg-3">
            <summary>{t("Make recipe")}</summary>
            <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg bg-console p-2.5 font-mono text-[11px] text-[#c8c8cc] scroll selectable">{spec.details.join("\n")}</pre>
          </details>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button className="b" onClick={onClose}>{t("Cancel")}</button>
          <button className={`b ${spec.danger || spec.env?.protected ? "b-prod" : "b-pri"}`} disabled={!ok} onClick={go} autoFocus={!spec.word}>
            {spec.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function Toast({ text, bad, onClose }: { text: string; bad?: boolean; onClose: () => void }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const t = window.setTimeout(() => close.current(), bad ? 9000 : 3500);
    return () => window.clearTimeout(t);
  }, [text, bad]);
  return (
    <div className="panel am-in fixed bottom-5 left-1/2 z-50 max-w-[560px] -translate-x-1/2 px-4 py-2.5 text-[13px]" style={bad ? { background: "color-mix(in srgb, var(--danger) 22%, var(--w-raise))" } : { background: "var(--w-raise-2)" }}>
      <span className="whitespace-pre-wrap selectable">{text}</span>
    </div>
  );
}

export interface Opt {
  value: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
}

/** Um select da app: lista com procura, ícones e dicas — não o nativo. */
export function Select({ value, options, onChange, placeholder, className = "", mono = false, disabled = false }: { value: string; options: Opt[]; onChange: (v: string) => void; placeholder?: string; className?: string; mono?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const cur = options.find((o) => o.value === value);
  const list = options.filter((o) => !q || `${o.label} ${o.hint ?? ""} ${o.value}`.toLowerCase().includes(q.toLowerCase()));
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => {
    setI(Math.max(0, list.findIndex((o) => o.value === value)));
  }, [open, q]);
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setQ("");
  };
  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        className={`field flex items-center gap-2 text-left disabled:opacity-50 ${mono ? "font-mono !text-[12px]" : ""}`}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); }
        }}
      >
        {cur?.icon}
        <span className={`min-w-0 flex-1 truncate ${cur ? "" : "text-fg-3"}`}>{cur?.label ?? placeholder ?? "—"}</span>
        <ChevronDown size={14} className="shrink-0 text-fg-3" />
      </button>
      {open && (
        <div className="panel am-in absolute left-0 right-0 top-full z-50 mt-1 min-w-[220px] overflow-hidden" style={{ background: "var(--w-raise)" }}>
          {options.length > 7 && (
            <div className="flex items-center gap-2 border-b hair px-3">
              <Search size={13} className="text-fg-3" />
              <input
                autoFocus
                className="h-9 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-3"
                placeholder={t("Search…")}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(list.length - 1, x + 1)); }
                  if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
                  if (e.key === "Enter" && list[i]) pick(list[i].value);
                  if (e.key === "Escape") setOpen(false);
                }}
              />
            </div>
          )}
          <div className="scroll max-h-[280px] overflow-auto p-1">
            {list.length === 0 && <p className="px-3 py-2 text-[12.5px] text-fg-3">{t("Nothing found.")}</p>}
            {list.map((o, j) => (
              <button
                key={o.value}
                type="button"
                className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left text-[13px]"
                style={j === i ? { background: "color-mix(in srgb, var(--w-accent) 15%, transparent)" } : {}}
                onMouseEnter={() => setI(j)}
                onClick={() => pick(o.value)}
              >
                {o.icon}
                <span className={`min-w-0 flex-1 truncate ${mono ? "font-mono text-[12px]" : ""}`}>{o.label}</span>
                {o.hint && <span className="max-w-[45%] truncate text-[11.5px] text-fg-3">{o.hint}</span>}
                {o.value === value && <Check size={14} className="shrink-0 text-accent" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50"
      style={{ background: on ? "var(--w-accent)" : "var(--w-raise-2)", boxShadow: "inset 0 0 0 1px var(--w-line-2)" }}
    >
      <span className="absolute top-0.5 size-4 rounded-full bg-white shadow transition-all" style={{ left: on ? 18 : 2 }} />
    </button>
  );
}

export function Chips({ options, value, onChange }: { options: Opt[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-[12.5px]"
            style={on ? { background: "color-mix(in srgb, var(--w-accent) 16%, transparent)", boxShadow: "0 0 0 1px color-mix(in srgb, var(--w-accent) 50%, transparent)" } : { background: "var(--w-raise-2)", boxShadow: "0 0 0 1px var(--w-line)", color: "var(--w-fg-3)" }}
            onClick={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
