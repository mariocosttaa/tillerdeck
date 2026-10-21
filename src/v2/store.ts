import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorText, type HistoryEntry, type Project, type ProjectState, type RunMeta, type RunSpec } from "../api";
import { parseSteps, type Step } from "./lib";

const MAX_LINES = 50_000;

export interface Run {
  entry: HistoryEntry;
  lines: string[];
  steps: Step[];
  running: boolean;
}

/**
 * As corridas: o output chega como evento linha a linha e junta-se de 100 em
 * 100 ms. Linhas de uma corrida que ainda não foi registada esperam — um
 * `make` imprime a primeira em milissegundos, antes de o `run_start` voltar.
 */
export function useRuns() {
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const pending = useRef<Record<string, string[]>>({});
  const known = useRef(new Set<string>());
  const exited = useRef<Record<string, HistoryEntry>>({});
  const waiters = useRef<Record<string, ((e: HistoryEntry) => void)[]>>({});

  const flush = useCallback(() => {
    const batch = pending.current;
    const ready = Object.keys(batch).filter((id) => known.current.has(id));
    if (!ready.length) return;
    const take: Record<string, string[]> = {};
    for (const id of ready) {
      take[id] = batch[id];
      delete batch[id];
    }
    setRuns((r) => {
      const next = { ...r };
      for (const [id, lines] of Object.entries(take)) {
        if (!next[id]) continue;
        const all = next[id].lines.concat(lines);
        next[id] = {
          ...next[id],
          lines: all.length > MAX_LINES ? all.slice(-MAX_LINES) : all,
          steps: parseSteps(lines, next[id].steps),
        };
      }
      return next;
    });
  }, []);

  const finish = useCallback((e: HistoryEntry) => {
    setRuns((r) => {
      const cur = r[e.id];
      if (!cur) return r;
      const steps = cur.steps.map((s, i) =>
        i === cur.steps.length - 1 && s.state === "running" ? { ...s, state: e.exitCode === 0 ? ("ok" as const) : ("failed" as const), endedAt: Date.now() } : s,
      );
      return { ...r, [e.id]: { ...cur, entry: e, running: false, steps } };
    });
    (waiters.current[e.id] ?? []).forEach((f) => f(e));
    delete waiters.current[e.id];
  }, []);

  useEffect(() => {
    const unOut = listen<{ id: string; line: string }>("run-output", (e) => {
      (pending.current[e.payload.id] ??= []).push(e.payload.line);
    });
    const unExit = listen<HistoryEntry>("run-exit", (e) => {
      flush();
      if (!known.current.has(e.payload.id)) exited.current[e.payload.id] = e.payload;
      else finish(e.payload);
      api.runHistory().then(setHistory);
    });
    const t = window.setInterval(flush, 100);
    api.runHistory().then(setHistory);
    return () => {
      unOut.then((f) => f());
      unExit.then((f) => f());
      window.clearInterval(t);
    };
  }, [flush, finish]);

  const start = useCallback(async (root: string, spec: RunSpec, meta?: RunMeta) => {
    const started = await api.runStart(root, spec, meta);
    setRuns((r) => ({ ...r, [started.id]: { entry: started, lines: [], steps: [], running: true } }));
    known.current.add(started.id);
    setHistory((h) => [started, ...h.filter((x) => x.id !== started.id)]);
    const early = exited.current[started.id];
    if (early) {
      delete exited.current[started.id];
      window.setTimeout(() => {
        flush();
        finish(early);
      }, 150);
    }
    return started;
  }, [flush, finish]);

  /** Espera pelo fim de uma corrida — para a promoção, que corre em sequência. */
  const waitExit = useCallback((id: string) => new Promise<HistoryEntry>((resolve) => {
    (waiters.current[id] ??= []).push(resolve);
  }), []);

  const openLog = useCallback(async (h: HistoryEntry) => {
    if (runs[h.id]) return;
    const log = await api.runLog(h.id).catch(() => "");
    const lines = log.split("\n");
    known.current.add(h.id);
    setRuns((r) => ({ ...r, [h.id]: { entry: h, lines, steps: parseSteps(lines), running: false } }));
  }, [runs]);

  const runningList = useMemo(() => Object.values(runs).filter((r) => r.running), [runs]);
  return { runs, history, start, waitExit, openLog, runningList, setHistory };
}

/** O projecto aberto: a árvore (v1) e o estado v2 (manifesto, releases, git). */
export function useProject() {
  const [project, setProject] = useState<Project | null>(null);
  const [state, setState] = useState<ProjectState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const p = await api.openProject(path);
      const s = await api.projectState(p.root);
      setProject(p);
      setState(s);
      return p;
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!project) return;
    const [p, s] = await Promise.all([api.openProject(project.root), api.projectState(project.root)]);
    setProject(p);
    setState(s);
  }, [project]);

  return { project, state, error, loading, load, refresh, setProject };
}
