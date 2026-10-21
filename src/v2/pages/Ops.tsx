import type { ReactNode } from "react";
import {
  Activity, ArchiveRestore, Boxes, ChartColumn, Construction, DatabaseBackup, DoorOpen, Gauge, HardDrive, HeartPulse, History, ListChecks, Play, Radio, RefreshCw,
  ScrollText, ShieldCheck, Table2, Upload,
} from "lucide-react";
import type { Operation } from "../../api";
import { canRun, opAvailable, runOperation, runServiceAction, useWs, type Ws } from "../context";
import { maintenanceKey, maintenanceState, opGroupLabel, opsIn, productOn, serviceKey, where } from "../lib";
import { TechIcon, Tint } from "../ui";
import { relTime, t, tn } from "../i18n";

function iconFor(o: Operation): ReactNode {
  const id = o.id;
  if (/restore-upload/.test(id)) return <Upload size={16} />;
  if (/restore/.test(id)) return <ArchiveRestore size={16} />;
  if (/snapshot/.test(id)) return <ListChecks size={16} />;
  if (/dbgate/.test(id)) return <Table2 size={16} />;
  if (/backup/.test(id)) return <DatabaseBackup size={16} />;
  if (/netdata/.test(id)) return <Gauge size={16} />;
  if (/kuma/.test(id)) return <HeartPulse size={16} />;
  if (/beszel/.test(id)) return <ChartColumn size={16} />;
  if (/^ping/.test(id)) return <Radio size={16} />;
  if (/^status/.test(id)) return <Boxes size={16} />;
  if (/^logs/.test(id)) return <ScrollText size={16} />;
  if (/history/.test(id)) return <History size={16} />;
  if (/audit/.test(id)) return <ShieldCheck size={16} />;
  if (/reset/.test(id)) return <RefreshCw size={16} />;
  return <HardDrive size={16} />;
}

function lastOf(ws: Ws, o: Operation) {
  return ws.history.find((h) => h.root === ws.project.root && h.meta?.env === ws.env.id && h.meta?.action === o.id && h.endedAt);
}

/** Uma linha de operação: ícone, nome, descrição, última vez, botão. */
function OpRow({ o, index, label }: { o: Operation; index?: number; label?: string }) {
  const ws = useWs();
  const ok = opAvailable(ws, o);
  const last = lastOf(ws, o);
  return (
    <div className="row flex items-center gap-3 px-2 py-2">
      {index !== undefined ? (
        <span className="grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold" style={last?.exitCode === 0 ? { color: "var(--ok)", background: "color-mix(in srgb, var(--ok) 14%, transparent)" } : { background: "var(--w-raise-2)" }}>{index}</span>
      ) : (
        <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-raise-2 text-fg-2">{iconFor(o)}</span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{label ?? o.label}{o.destructive && <span className="ml-2"><Tint color="var(--danger)">{t("deletes data")}</Tint></span>}</p>
        <p className="truncate text-[12px] text-fg-3" title={o.description}>{o.description || o.id}</p>
      </div>
      <span className="shrink-0 text-[12px] text-fg-3">{last ? `${last.exitCode === 0 ? "" : t("failed") + " "}${relTime(last.endedAt)}` : ""}</span>
      <button className="b b-sm" disabled={!ok} title={ok ? "" : t("not available on {env}", { env: ws.env.label })} onClick={() => runOperation(ws, o)}>
        <Play size={13} />{t("Run")}
      </button>
    </div>
  );
}

function Card({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="raise p-5">
      <div className="flex items-center justify-between gap-3"><h2 className="text-[15px] font-semibold">{title}</h2>{hint && <span className="text-[12px] text-fg-3">{hint}</span>}</div>
      <div className="mt-3 space-y-0.5">{children}</div>
    </section>
  );
}

const firstWord = (o: Operation) => {
  const parts = o.label.split(" ");
  const rest = parts.slice(1).join(" ");
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : o.label;
};

export function Backups() {
  const ws = useWs();
  const ops = opsIn(ws.manifest, "backup").filter((o) => opAvailable(ws, o) || !o.action.envs?.length);
  const install = ops.filter((o) => !/restore|snapshot/.test(o.id));
  const restores = ops.filter((o) => /restore/.test(o.id));
  const snaps = ops.filter((o) => /snapshot/.test(o.id));
  return (
    <section className="scroll min-w-0 flex-1 overflow-auto px-6 pb-10 pt-5">
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={t("Backup service")} hint={ws.env.label}>
          {install.map((o) => <OpRow key={o.id} o={o} />)}
          {snaps.map((o) => <OpRow key={o.id} o={o} />)}
          {!snaps.length && <p className="px-2 pt-2 text-[12px] text-fg-3">{t("This project has no target that lists snapshots — restores use latest.")}</p>}
        </Card>
        <Card title={t("Restore")} hint={<span className="text-warn">{t("rehearse on staging before production")}</span>}>
          {restores.map((o) => <OpRow key={o.id} o={o} />)}
          {!restores.length && <p className="px-2 text-fg-3">{t("No restore targets.")}</p>}
        </Card>
      </div>
    </section>
  );
}

export function Machine() {
  const ws = useWs();
  const m = ws.manifest;
  const machine = opsIn(m, "machine");
  const provision = machine.filter((o) => /^provision-(system|security|maintenance|platform)$/.test(o.id));
  const otherMachine = machine.filter((o) => !provision.includes(o));
  const toggles = m.products
    .filter((p) => productOn(p, ws.env.id))
    .flatMap((p) => p.services.filter((s) => s.actions.maintenanceOn || s.actions.maintenanceOff).map((s) => ({ p, s })));

  async function sequence() {
    // Máquina nova: os passos por ordem, a parar no primeiro que falhe.
    const avail = provision.filter((o) => opAvailable(ws, o));
    ws.confirm({
      title: t("Provision {env} from scratch", { env: ws.env.label }),
      subtitle: avail.map((o) => o.id).join(" → "),
      env: ws.env,
      word: ws.env.protected ? ws.env.id : undefined,
      facts: [{ icon: <Play size={16} />, text: t("Runs the steps in order and stops at the first that fails.") }],
      confirmLabel: tn(avail.length, "Run {n}", "Run {n}"),
      onConfirm: async () => {
        for (const o of avail) {
          const target = o.action.make!.replace("{env}", ws.env.id);
          const vars: [string, string][] = ws.makeInfo.get(target)?.usesConfirm ? [["CONFIRM", "yes"]] : [];
          const run = await ws.start({ kind: "make", target, vars }, { title: o.label, env: ws.env.id, action: o.id });
          if (!run) return;
          const end = await ws.waitExit(run.id);
          if (end.exitCode !== 0) {
            ws.toast(t("{op} failed — the next ones didn't run.", { op: o.label }), true);
            return;
          }
        }
        ws.toast(t("{env} provisioned", { env: ws.env.label }));
      },
    });
  }

  return (
    <section className="scroll min-w-0 flex-1 overflow-auto px-6 pb-10 pt-5">
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={opGroupLabel("machine")} hint={t("on a new machine, in this order")}>
          {provision.map((o, i) => <OpRow key={o.id} o={o} index={i + 1} label={firstWord(o)} />)}
          {provision.length > 1 && (
            <button className="b mt-3 w-full justify-center" onClick={sequence}><Play size={14} />{t("New machine: run the {n} in order", { n: provision.length })}</button>
          )}
          {otherMachine.map((o) => <OpRow key={o.id} o={o} />)}
          {!machine.length && <p className="px-2 text-fg-3">{t("No provisioning targets.")}</p>}
        </Card>

        <Card title={t("Open to users")} hint={t("maintenance mode")}>
          {toggles.length === 0 && <p className="px-2 text-fg-3">{t("No service has a maintenance mode.")}</p>}
          {toggles.map(({ p, s }) => {
            const mk = maintenanceKey(s);
            const w = where(p, ws.env);
            const ms = maintenanceState(ws.history, ws.project.root, ws.env.id, serviceKey(p, s), mk ? ws.maint[w.inventory]?.[mk] : undefined);
            return (
              <div key={serviceKey(p, s)} className="row flex items-center gap-3 px-2 py-2">
                <TechIcon kind={s.kind} size="sm" />
                <span className="min-w-0 flex-1 truncate font-medium">{s.label}<span className="font-normal text-fg-3"> · {p.label}</span></span>
                <span className="text-[12px]" title={ms.source === "action" ? t("from the last action run here") : t("from the inventory")} style={{ color: ms.closed ? "var(--warn)" : ms.closed === false ? "var(--ok)" : "var(--w-fg-3)" }}>
                  {ms.closed ? t("closed") : ms.closed === false ? t("open") : "?"}
                </span>
                <button className="b b-sm" disabled={!canRun(ws, p, s, "maintenanceOn")} onClick={() => runServiceAction(ws, p, s, "maintenanceOn")}><Construction size={13} />{t("Close")}</button>
                <button className="b b-sm" disabled={!canRun(ws, p, s, "maintenanceOff")} onClick={() => runServiceAction(ws, p, s, "maintenanceOff")}><DoorOpen size={13} />{t("Reopen")}</button>
              </div>
            );
          })}
          {toggles.length > 0 && <p className="px-2 pt-2 text-[12px] text-fg-3">{t("The state comes from the last close/reopen/deploy run from here, or else from the inventory. It is not live.")}</p>}
        </Card>

        <Card title={opGroupLabel("observability")}>
          {opsIn(m, "observability").map((o) => <OpRow key={o.id} o={o} />)}
          {!opsIn(m, "observability").length && <p className="px-2 text-fg-3">{t("Nothing configured.")}</p>}
        </Card>

        <Card title={opGroupLabel("verify")} hint={<span className="flex items-center gap-1 text-ok"><Activity size={13} />{t("read-only")}</span>}>
          {opsIn(m, "verify").map((o) => <OpRow key={o.id} o={o} />)}
        </Card>

        {opsIn(m, "other").length > 0 && (
          <Card title={opGroupLabel("other")}>
            {opsIn(m, "other").map((o) => <OpRow key={o.id} o={o} />)}
          </Card>
        )}
      </div>
    </section>
  );
}
