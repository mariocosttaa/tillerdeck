import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Info, KeyRound, MessageSquare } from "lucide-react";
import { api, errorText, type EnvDef, type Variable } from "../../api";
import { useWs } from "../context";
import { EnvDot, Toggle } from "../ui";
import { t } from "../i18n";
import { SecretDialog } from "./Settings";

interface Dest {
  key: string;
  title: string;
  sub?: string;
  server: EnvDef;
  vars: Variable[];
}

/**
 * As notificações de cada servidor (e de cada produto que vive noutra
 * máquina): ligar/desligar e o webhook. Escreve nos ficheiros do Ansible
 * (o webhook, cifrado no vault) — vale a partir do próximo deploy.
 */
export function Notifications() {
  const ws = useWs();
  const m = ws.manifest;
  const all = (m.variables ?? []).filter((v) => v.category === "notifications");
  const [secret, setSecret] = useState<{ v: Variable; server: string } | null>(null);

  const dests: Dest[] = [];
  for (const e of m.environments) {
    const vars = all.filter((v) => !v.target && v.files[e.id]);
    if (vars.length) dests.push({ key: e.id, title: e.label, server: e, vars });
  }
  for (const p of m.products) {
    for (const [server, pl] of Object.entries(p.placements ?? {})) {
      const e = m.environments.find((x) => x.id === server);
      const vars = all.filter((v) => v.target === pl.token && v.files[server]);
      if (e && vars.length) dests.push({ key: `${p.id}@${server}`, title: p.label, sub: t("on {env}", { env: e.label }), server: e, vars });
    }
  }

  if (!dests.length) {
    return (
      <div className="max-w-xl p-10 text-fg-2">
        <p className="text-[15px] font-semibold text-fg">{t("No notifications configured")}</p>
        <p className="mt-2">{t("Variables marked as notifications show here — the template finds them in host_vars/<host>/notify.yml. You can also mark a variable in Settings → JSON with \"category\": \"notifications\".")}</p>
      </div>
    );
  }

  return (
    <section className="scroll min-w-0 flex-1 overflow-auto px-6 pb-10 pt-5">
      <div className="raise flex items-start gap-3 p-4 text-[12.5px] text-fg-2">
        <Info size={16} className="mt-0.5 shrink-0 text-fg-3" />
        <span>{t("Each switch writes its line in your Ansible files; the webhook is written encrypted into the vault and never shown. It takes effect on the next deploy — nothing is sent from here.")}</span>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {dests.map((d) => (
          <div key={d.key} className="raise p-5">
            <div className="flex items-center gap-2.5">
              <EnvDot env={d.server} size={8} />
              <p className="text-[15px] font-semibold">{d.title}</p>
              {d.sub && <span className="text-[12.5px] text-fg-3">{d.sub}</span>}
            </div>
            <div className="mt-4 space-y-1">
              {d.vars.map((v) => <Row key={v.id} v={v} server={d.server.id} onSecret={() => setSecret({ v, server: d.server.id })} />)}
            </div>
          </div>
        ))}
      </div>
      {secret && <SecretDialog v={secret.v} server={secret.server} onClose={() => { setSecret(null); ws.refresh(); }} />}
    </section>
  );
}

function Row({ v, server, onSecret }: { v: Variable; server: string; onSecret: () => void }) {
  const ws = useWs();
  const file = v.files[server];
  const val = ws.state.values[file]?.[v.key];
  const [has, setHas] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (v.kind === "secret") api.vaultKeyHas(ws.project.root, file, v.key).then(setHas).catch(() => setHas(null));
  }, [file, v.key, ws.refreshedAt]);

  async function write(value: string) {
    setBusy(true);
    try {
      await api.varSet(ws.project.root, file, v.key, value);
      await ws.refresh();
      ws.toast(t("{key} = {val} in {file}. It applies on the next deploy.", { key: v.key, val: value, file }));
    } catch (e) {
      ws.toast(errorText(e), true);
    } finally {
      setBusy(false);
    }
  }

  const label = v.label.replace(/\s*\([^)]*\)$/, "");
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-hover" title={`${file} · ${v.key}`}>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-raise-2 text-fg-2">{v.kind === "secret" ? <KeyRound size={15} /> : <MessageSquare size={15} />}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        <span className="block truncate font-mono text-[11px] text-fg-3">{v.key}</span>
      </span>
      {v.kind === "bool" && (
        <span className="flex items-center gap-2 text-[12.5px] text-fg-2">
          {val === "true" ? t("On") : val === "false" ? t("Off") : "—"}
          <Toggle on={val === "true"} disabled={busy} onChange={(x) => write(String(x))} />
        </span>
      )}
      {v.kind === "text" && (
        <input className="field !h-8 !w-56 font-mono !text-[12px]" defaultValue={val ?? ""} onBlur={(e) => e.target.value !== (val ?? "") && write(JSON.stringify(e.target.value))} />
      )}
      {v.kind === "secret" && (
        <>
          {has === true && <span className="flex items-center gap-1.5 text-[12.5px] text-ok"><CircleCheck size={14} />{t("configured")}</span>}
          {has === false && <span className="flex items-center gap-1.5 text-[12.5px] text-warn"><CircleAlert size={14} />{t("missing")}</span>}
          <button className="b b-sm" onClick={onSecret}>{has ? t("Change…") : t("Set…")}</button>
        </>
      )}
    </div>
  );
}
