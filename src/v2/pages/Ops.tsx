import { useEffect, useState, type ReactNode } from "react";
import {
  Activity, ArchiveRestore, Boxes, ChartColumn, Construction, DatabaseBackup, Gauge, HardDrive, HeartPulse, History, ListChecks, Play, Radio, RefreshCw,
  ScrollText, ShieldCheck, Table2, Upload,
} from "lucide-react";
import { api, type Operation } from "../../api";
import { opAvailable, runOperation, runServiceAction, useWs, type Ws } from "../context";
import { OP_GROUPS, maintenanceKey, opsIn, relTime, serviceKey } from "../lib";
import { TechIcon, Tint } from "../ui";

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
        <p className="truncate font-medium">{label ?? o.label}{o.destructive && <span className="ml-2"><Tint color="var(--danger)">apaga dados</Tint></span>}</p>
        <p className="truncate text-[12px] text-fg-3" title={o.description}>{o.description || o.id}</p>
      </div>
      <span className="shrink-0 text-[12px] text-fg-3">{last ? `${last.exitCode === 0 ? "" : "falhou "}${relTime(last.endedAt)}` : ""}</span>
      <button className={`b b-sm ${o.destructive ? "" : ""}`} disabled={!ok} title={ok ? "" : `não existe em ${ws.env.label}`} onClick={() => runOperation(ws, o)}>
        <Play size={13} />Correr
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

const nice = (o: Operation) => {
  const t = o.label.replace(/^Provisionar /, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function Backups() {
  const ws = useWs();
  const ops = opsIn(ws.manifest, "backup");
  const install = ops.filter((o) => !/restore|snapshot/.test(o.id));
  const restores = ops.filter((o) => /restore/.test(o.id));
  const snaps = ops.filter((o) => /snapshot/.test(o.id));
  return (
    <section className="scroll min-w-0 flex-1 overflow-auto px-6 pb-10 pt-5">
      <div className="grid grid-cols-2 gap-4">
        <Card title="Serviço de backup" hint={`${ws.env.label}`}>
          {install.map((o) => <OpRow key={o.id} o={o} label={nice(o)} />)}
          {snaps.map((o) => <OpRow key={o.id} o={o} label="Listar os snapshots" />)}
          {!snaps.length && <p className="px-2 pt-2 text-[12px] text-fg-3">Este projecto não tem um alvo que liste os snapshots — os restauros usam o <span className="font-mono">latest</span>.</p>}
        </Card>
        <Card title="Restaurar" hint={<span className="text-warn">ensaia na staging antes da produção</span>}>
          {restores.map((o) => <OpRow key={o.id} o={o} />)}
          {!restores.length && <p className="px-2 text-fg-3">Sem alvos de restauro.</p>}
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
  const [maint, setMaint] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let live = true;
    api.maintenanceState(ws.project.root, ws.env.inventory).then((x) => live && setMaint(x)).catch(() => {});
    return () => {
      live = false;
    };
  }, [ws.env.id]);

  const toggles = m.products.flatMap((p) => p.services.filter((s) => s.actions.maintenanceOn || s.actions.maintenanceOff).map((s) => ({ p, s })));

  async function sequence() {
    // Máquina nova: os quatro por ordem, a parar no primeiro que falhe.
    const avail = provision.filter((o) => opAvailable(ws, o));
    ws.confirm({
      title: `Provisionar ${ws.env.label} de raiz`,
      subtitle: avail.map((o) => o.id).join(" → "),
      env: ws.env,
      word: ws.env.protected ? ws.env.id : undefined,
      facts: [{ icon: <Play size={16} />, text: "Corre os passos por ordem e pára no primeiro que falhar." }],
      confirmLabel: `Correr ${avail.length}`,
      onConfirm: async () => {
        for (const o of avail) {
          const target = o.action.make!.replace("{env}", ws.env.id);
          const vars: [string, string][] = ws.makeInfo.get(target)?.usesConfirm ? [["CONFIRM", "yes"]] : [];
          const run = await ws.start({ kind: "make", target, vars }, { title: o.label, env: ws.env.id, action: o.id });
          if (!run) return;
          const end = await ws.waitExit(run.id);
          if (end.exitCode !== 0) {
            ws.toast(`${o.label} falhou — os seguintes não correram.`, true);
            return;
          }
        }
        ws.toast(`${ws.env.label} provisionada`);
      },
    });
  }

  return (
    <section className="scroll min-w-0 flex-1 overflow-auto px-6 pb-10 pt-5">
      <div className="grid grid-cols-2 gap-4">
        <Card title={OP_GROUPS.machine} hint="numa máquina nova, por esta ordem">
          {provision.map((o, i) => <OpRow key={o.id} o={o} index={i + 1} label={nice(o)} />)}
          {provision.length > 1 && (
            <button className="b mt-3 w-full justify-center" onClick={sequence}><Play size={14} />Máquina nova: correr os {provision.length} por ordem</button>
          )}
          {otherMachine.map((o) => <OpRow key={o.id} o={o} />)}
          {!machine.length && <p className="px-2 text-fg-3">Sem alvos de provisionamento.</p>}
        </Card>

        <Card title="Aberto aos utilizadores" hint="modo de manutenção">
          {toggles.length === 0 && <p className="px-2 text-fg-3">Nenhum serviço tem modo de manutenção.</p>}
          {toggles.map(({ p, s }) => {
            const mk = maintenanceKey(s);
            const closed = mk ? maint[mk] : undefined;
            const action = closed ? "maintenanceOff" : "maintenanceOn";
            return (
              <div key={serviceKey(p, s)} className="row flex items-center gap-3 px-2 py-2">
                <TechIcon kind={s.kind} size="sm" />
                <span className="flex-1 font-medium">{s.label}</span>
                <span className="text-[12px]" style={{ color: closed ? "var(--warn)" : closed === false ? "var(--ok)" : "var(--w-fg-3)" }}>
                  {closed ? "fechado" : closed === false ? "aberto" : "?"}
                </span>
                <button className="b b-sm" onClick={() => runServiceAction(ws, p, s, action)} disabled={!s.actions[action]}>
                  <Construction size={13} />{closed ? "Reabrir" : "Fechar"}
                </button>
              </div>
            );
          })}
          {toggles.length > 0 && <p className="px-2 pt-2 text-[12px] text-fg-3">O estado vem do inventário ({ws.env.inventory}): é o que um deploy volta a aplicar.</p>}
        </Card>

        <Card title={OP_GROUPS.observability}>
          {opsIn(m, "observability").map((o) => <OpRow key={o.id} o={o} />)}
          {!opsIn(m, "observability").length && <p className="px-2 text-fg-3">Nada configurado.</p>}
        </Card>

        <Card title={OP_GROUPS.verify} hint={<span className="flex items-center gap-1 text-ok"><Activity size={13} />só lêem</span>}>
          {opsIn(m, "verify").map((o) => <OpRow key={o.id} o={o} />)}
        </Card>

        {opsIn(m, "other").length > 0 && (
          <Card title={OP_GROUPS.other}>
            {opsIn(m, "other").map((o) => <OpRow key={o.id} o={o} />)}
          </Card>
        )}
      </div>
    </section>
  );
}
