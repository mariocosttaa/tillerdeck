import { useEffect, useMemo, useRef, useState } from "react";
import { Check, GitCommitHorizontal, MessageSquare, Package, PenLine, RefreshCw, X } from "lucide-react";
import { api, errorText, type EnvDef, type Product, type Service } from "../api";
import { actionMeta, canRun, callbackFacts, specFor, varsFor, useWs, type Ws } from "./context";
import { makeTarget, serviceKey, shortVersion, versionOf, where } from "./lib";
import { Modal, TechIcon, Toggle } from "./ui";
import { relTime, t } from "./i18n";
import { cached, formatSize, loadChoices, loadError, sourceLabel, versionSource, type Choice } from "./versions";

export interface DeployRequest {
  p: Product;
  s: Service;
  /** deploy · migrate · seed — o botão que se carregou */
  action: string;
  /** uma versão já escolhida (da página das builds) */
  preset?: string;
}

interface Mode {
  id: string;
  label: string;
  /** as acções, por ordem */
  steps: string[];
  /** o primeiro passo instala a versão do release */
  installs: boolean;
}

/**
 * O que se pode correr a partir de um botão de deploy. Uma acção que já
 * instala a versão (`includesDeploy`) é ela própria o "deploy + migrar";
 * as outras correm depois de um deploy, em sequência.
 */
export function modesFor(ws: Ws, p: Product, s: Service, server: EnvDef): Mode[] {
  const has = (a: string) => canRun(ws, p, s, a, server);
  const out: Mode[] = [];
  if (has("deploy")) out.push({ id: "deploy", label: t("Deploy"), steps: ["deploy"], installs: true });
  for (const a of ["migrate", "seed"]) {
    if (!has(a)) continue;
    if (s.actions[a].includesDeploy) {
      out.push({ id: a, label: a === "migrate" ? t("Deploy + migrations") : t("Deploy + migrations + seed"), steps: [a], installs: true });
    } else {
      if (has("deploy")) out.push({ id: `deploy+${a}`, label: a === "migrate" ? t("Deploy, then migrate") : t("Deploy, then seed"), steps: ["deploy", a], installs: true });
      out.push({ id: a, label: a === "migrate" ? t("Migrations only") : t("Seed only"), steps: [a], installs: false });
    }
  }
  return out;
}

/**
 * Corre os passos de um modo. Se a versão muda, escreve primeiro a linha do
 * release; se o passo que a instala falhar, a linha volta ao que era e o
 * resto não corre. O release nunca diz uma versão que não está instalada.
 */
async function execute(ws: Ws, p: Product, s: Service, server: EnvDef, mode: Mode, value: string | undefined, commit: boolean, extra: [string, string][]) {
  const w = where(p, server);
  const key = serviceKey(p, s);
  const current = versionOf(ws.state.releases, w, s);
  const changes = !!(mode.installs && value && value !== current && s.releaseKey && w.release);
  let old: string | undefined;
  if (changes) {
    try {
      old = await api.releaseSet(ws.project.root, w.release!, s.releaseKey!, value!);
    } catch (e) {
      ws.toast(t("{s}: couldn't write the release — {e}", { s: s.label, e: errorText(e) }), true);
      return;
    }
  }
  const installed = mode.installs ? (changes ? value : current) : undefined;
  for (const [i, a] of mode.steps.entries()) {
    const act = s.actions[a];
    const target = makeTarget(act, w.token);
    const installs = i === 0 && mode.installs;
    const run = await ws.start(specFor(ws, w, target, act.playbook, extra), {
      title: `${actionMeta(a).verb} · ${s.label}`,
      env: server.id,
      service: key,
      action: a,
      version: installs ? installed : undefined,
    });
    const end = run ? await ws.waitExit(run.id) : null;
    if (!end || end.exitCode !== 0) {
      if (installs && changes && old !== undefined) {
        await api.releaseSet(ws.project.root, w.release!, s.releaseKey!, old).catch(() => {});
        ws.toast(t("{s} failed — the release line went back to {v}.", { s: s.label, v: shortVersion(old) }), true);
      } else if (end) {
        ws.toast(t("{step} failed on {s} — the next steps didn't run.", { step: actionMeta(a).verb, s: s.label }), true);
      }
      await ws.refresh();
      return;
    }
  }
  await ws.refresh();
  if (changes && commit) {
    const msg = `${t("Deploy")} ${s.label} ${shortVersion(value)} (${server.label})`;
    try {
      const sha = await api.releaseCommit(ws.project.root, w.release!, msg);
      ws.toast(t("Commit {sha} — {msg}", { sha, msg }));
    } catch (e) {
      ws.toast(t("The commit failed: {e}", { e: errorText(e) }), true);
    }
    await ws.refresh();
  } else {
    ws.toast(t("{s} done on {env}", { s: s.label, env: server.label }));
  }
}

export function DeployDialog({ req, onClose }: { req: DeployRequest; onClose: () => void }) {
  const ws = useWs();
  const { p, s } = req;
  const server = ws.env;
  const w = where(p, server);
  const modes = useMemo(() => modesFor(ws, p, s, server), [ws, p, s, server]);
  const [modeId, setModeId] = useState(() => (modes.find((m) => m.id === req.action) ?? modes[0])?.id);
  const mode = modes.find((m) => m.id === modeId) ?? modes[0];
  const current = versionOf(ws.state.releases, w, s);
  const src = versionSource(ws, s);
  const pickable = !!(mode?.installs && s.releaseKey && w.release);

  const [pick, setPick] = useState<string | undefined>(req.preset ?? current);
  const [manual, setManual] = useState("");
  const [manualOn, setManualOn] = useState(false);
  const [list, setList] = useState<Choice[] | null>(() => cached(ws, p, s, server)?.list ?? null);
  const [at, setAt] = useState<number | undefined>(() => cached(ws, p, s, server)?.at);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commit, setCommit] = useState(false);
  const [typed, setTyped] = useState("");
  const fields = useMemo(() => [...new Map((mode?.steps ?? []).flatMap((a) => {
    const tg = makeTarget(s.actions[a], w.token);
    return tg ? varsFor(ws, tg.split(/\s+/)[0]) : [];
  }).map((f) => [f.name, f])).values()], [mode, s, w.token, ws]);
  const [values, setValues] = useState<Record<string, string>>({});
  const wordRef = useRef<HTMLInputElement>(null);

  const load = (force = false) => {
    if (!src || !pickable) return;
    setLoading(true);
    setError(null);
    loadChoices(ws, p, s, server, force)
      .then((r) => { setList(r.list); setAt(r.at); })
      .catch((e) => setError(loadError(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => load(), [pickable]);

  if (!mode) return null;
  const value = manualOn ? manual.trim() || undefined : pick;
  const changes = pickable && !!value && value !== current;
  const word = server.protected ? w.token : undefined;
  const ok = (!word || typed.trim() === word) && (!manualOn || !!manual.trim());
  const commands = mode.steps.map((a) => {
    const tg = makeTarget(s.actions[a], w.token);
    return tg ? `make ${tg}` : `ansible-playbook ${s.actions[a].playbook} -i ${w.inventory}`;
  });
  const others = ws.manifest.environments.filter((e) => e.id !== server.id);
  const onOther = (v: string) => others.filter((e) => versionOf(ws.state.releases, where(p, e), s) === v);
  const facts = callbackFacts(ws);

  function go() {
    if (!ok) return;
    onClose();
    const extra = Object.entries(values).filter(([, v]) => v.trim()) as [string, string][];
    execute(ws, p, s, server, mode, pickable ? value : undefined, commit, extra);
  }

  const row = (c: Choice) => {
    const on = !manualOn && pick === c.value;
    const isCurrent = c.value === current;
    return (
      <button key={c.value} className={`flex w-full items-center gap-3 rounded-[9px] px-3 py-2 text-left ${on ? "" : "hover:bg-raise-2"}`} style={on ? { background: "color-mix(in srgb, var(--w-accent) 15%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--w-accent) 45%, transparent)" } : {}} onClick={() => { setManualOn(false); setPick(c.value); }}>
        <span className={`grid size-4 shrink-0 place-items-center rounded-full ring-1 ${on ? "bg-accent ring-accent" : "ring-line-2"}`}>{on && <Check size={10} className="text-white" />}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-medium">{c.version ?? (c.title ? c.commit : shortVersion(c.value))}</span>
            {c.commit && c.version && <span className="pill !h-5 bg-raise-2 font-mono text-[11px] text-fg-2"><GitCommitHorizontal size={11} />{c.commit}</span>}
            {isCurrent && <span className="pill !h-5 text-[11px]" style={{ color: "var(--ok)", background: "color-mix(in srgb, var(--ok) 14%, transparent)" }}>{t("installed")}</span>}
            {onOther(c.value).map((e) => <span key={e.id} className="pill !h-5 bg-raise-2 text-[11px] text-fg-2">{t("on {env}", { env: e.label })}</span>)}
          </span>
          <span className="block truncate text-[11.5px] text-fg-3">{c.title ?? c.value}</span>
        </span>
        <span className="shrink-0 text-right text-[11.5px] text-fg-3" title={c.date ? new Date(c.date).toLocaleString() : ""}>
          {c.date ? relTime(c.date) : ""}
          {c.size ? <span className="block">{formatSize(c.size)}</span> : c.author ? <span className="block">{c.author}</span> : null}
        </span>
      </button>
    );
  };

  return (
    <Modal onClose={onClose} width={640}>
      <div className={`${server.protected ? "glow-production" : `glow-${server.color}`} px-6 pb-4 pt-6`} style={{ borderRadius: "14px 14px 0 0" }}>
        <div className="flex items-center gap-3">
          <TechIcon kind={s.kind} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="text-[16px] font-semibold">{mode.label} · {s.label}</p>
            <p className="truncate text-[12.5px] text-fg-2">{server.label}{w.token !== server.id ? ` · ${w.token}` : ""}{w.release ? ` · ${w.release}` : ""}</p>
          </div>
          <button className="ib" onClick={onClose}><X size={16} /></button>
        </div>
        {modes.length > 1 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {modes.map((m) => (
              <button key={m.id} className={`chip-mode ${m.id === mode.id ? "on" : ""}`} onClick={() => setModeId(m.id)}>
                {actionMeta(m.steps[m.steps.length - 1]).icon}{m.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {pickable && (
        <div className="px-6 pt-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="label !mb-0">{t("Version")}</span>
            {src && <span className="min-w-0 truncate text-[11.5px] text-fg-3"><Package size={11} className="mr-1 inline" />{sourceLabel(ws, src, s)}</span>}
            <span className="ml-auto" />
            {at && <span className="text-[11.5px] text-fg-3">{relTime(new Date(at).toISOString())}</span>}
            {src && <button className="ib !size-7" title={t("Refresh")} onClick={() => load(true)}><RefreshCw size={14} className={loading ? "animate-spin" : ""} /></button>}
          </div>
          <div className="scroll max-h-[min(260px,34vh)] space-y-0.5 overflow-auto rounded-xl bg-panel p-1.5 ring-1 ring-line">
            {/* a instalada fica sempre em cima: é o "não mudar nada" */}
            {current && row((list ?? []).find((c) => c.value === current) ?? { value: current, title: t("the version in the release") })}
            {req.preset && req.preset !== current && !(list ?? []).some((c) => c.value === req.preset) && row({ value: req.preset, title: t("chosen in Builds") })}
            {(list ?? []).filter((c) => c.value !== current).map(row)}
            {loading && !list && <p className="px-3 py-4 text-center text-[12.5px] text-fg-3">{src?.source === "git" ? t("reading the commits…") : t("asking the registry…")}</p>}
            {error && <p className="px-3 py-3 text-[12.5px] text-warn selectable">{error}</p>}
            {!src && <p className="px-3 py-3 text-[12.5px] text-fg-3">{t("No version source for this service — set a registry or a git repository in Settings, or type the version.")}</p>}
            {list && !list.length && !error && <p className="px-3 py-3 text-[12.5px] text-fg-3">{t("No builds match the tag format.")}</p>}
            <div className={`flex items-center gap-3 rounded-[9px] px-3 py-1.5 ${manualOn ? "" : "hover:bg-raise-2"}`} style={manualOn ? { background: "color-mix(in srgb, var(--w-accent) 15%, transparent)" } : {}}>
              <PenLine size={14} className="text-fg-3" />
              <input className="h-8 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-fg-3" placeholder={t("another tag or commit…")} value={manual} onFocus={() => setManualOn(true)} onChange={(e) => { setManualOn(true); setManual(e.target.value); }} spellCheck={false} />
            </div>
          </div>
          {changes && (
            <div className="mt-3 flex items-center gap-3 text-[12.5px]">
              <span className="font-mono text-fg-2">{shortVersion(current) || "—"}</span><span className="text-fg-3">→</span><span className="font-mono font-medium text-ok">{shortVersion(value)}</span>
              <span className="ml-auto flex items-center gap-2 text-fg-2"><Toggle on={commit} onChange={setCommit} disabled={!ws.state.git.branch} />{t("Commit {file}", { file: w.release ?? "" })}</span>
            </div>
          )}
        </div>
      )}

      {(facts.length > 0 || (changes && pickable)) && (
        <div className="space-y-1.5 px-6 pt-4 text-[12.5px] text-fg-2">
          {changes && <p className="flex items-center gap-2.5"><Check size={15} />{t("Writes {key} in the release; if the deploy fails, the line goes back.", { key: s.releaseKey ?? "" })}</p>}
          {facts.map((f, i) => <p key={i} className="flex items-center gap-2.5"><MessageSquare size={15} />{f.text}</p>)}
        </div>
      )}

      {fields.length > 0 && (
        <div className="grid grid-cols-2 gap-3 px-6 pt-4">
          {fields.map((f) => (
            <label key={f.name}><span className="label">{f.name}</span><input className="field font-mono" placeholder={f.value || t("(empty)")} value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} spellCheck={false} /></label>
          ))}
        </div>
      )}

      <div className="px-6 pb-6 pt-4">
        {word && (
          <>
            <p className="text-[12.5px] font-medium">{t("To confirm, type")} <span className="font-mono" style={{ color: "var(--env-production)" }}>{word}</span></p>
            <input ref={wordRef} className="field mt-2 h-10 font-mono text-[14px]" style={{ boxShadow: "0 0 0 2px color-mix(in srgb, var(--env-production) 55%, transparent)" }} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
          </>
        )}
        <p className="mt-3 truncate font-mono text-[11.5px] text-fg-3 selectable" title={commands.join(" && ")}>{commands.join("  →  ")}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button className="b" onClick={onClose}>{t("Cancel")}</button>
          <button className={`b ${server.protected ? "b-prod" : "b-pri"}`} disabled={!ok} onClick={go}>
            {actionMeta(mode.steps[mode.steps.length - 1]).icon}
            {changes ? t("{mode} {v}", { mode: mode.label, v: shortVersion(value) }) : mode.label}
          </button>
        </div>
      </div>
    </Modal>
  );
}
