import { useMemo, useState } from "react";
import { api, errorText, type FileEntry, type InventoryGroup, type Project } from "../../api";

type Section = "projeto" | "ficheiros";

interface Props {
  project: Project;
  activePath: string | null;
  dirty: Set<string>;
  onOpen: (f: FileEntry) => void;
}

const KIND_LABEL: Record<string, string> = {
  playbook: "Playbooks",
  inventory: "Inventários",
  release: "Releases",
  vault: "Vault",
};

export default function Sidebar({ project, activePath, dirty, onOpen }: Props) {
  const [section, setSection] = useState<Section>("projeto");
  const [filter, setFilter] = useState("");

  return (
    <aside className="sidebar">
      <div className="seg">
        <button className={section === "projeto" ? "on" : ""} onClick={() => setSection("projeto")}>
          Projecto
        </button>
        <button className={section === "ficheiros" ? "on" : ""} onClick={() => setSection("ficheiros")}>
          Ficheiros
        </button>
      </div>
      <input
        className="filter"
        placeholder="Filtrar…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        spellCheck={false}
      />
      <div className="side-scroll">
        {section === "projeto" ? (
          <Grouped project={project} filter={filter} activePath={activePath} dirty={dirty} onOpen={onOpen} />
        ) : (
          <Tree project={project} filter={filter} activePath={activePath} dirty={dirty} onOpen={onOpen} />
        )}
        {project.truncated && <p className="muted small pad">A árvore foi cortada aos 5000 ficheiros.</p>}
      </div>
    </aside>
  );
}

/** Sem a primeira pasta (`playbooks/`, `inventories/`…): o grupo já a diz. */
function short(path: string): string {
  const i = path.indexOf("/");
  return i > 0 ? path.slice(i + 1) : path;
}

function FileRow({
  f,
  label,
  depth = 0,
  active,
  dirty,
  onOpen,
}: {
  f: FileEntry;
  label: string;
  depth?: number;
  active: boolean;
  dirty: boolean;
  onOpen: (f: FileEntry) => void;
}) {
  return (
    <button
      className={`row ${active ? "active" : ""}`}
      style={{ paddingLeft: 10 + depth * 12 }}
      onClick={() => onOpen(f)}
      title={f.path}
    >
      <span className={`dot k-${f.kind}`} />
      <span className="row-label">{label}</span>
      {f.vault && <span className="badge lock" title="Cifrado com ansible-vault">vault</span>}
      {dirty && <span className="dirty-dot" title="Alterações por gravar" />}
    </button>
  );
}

function Grouped({ project, filter, activePath, dirty, onOpen }: Props & { filter: string }) {
  const q = filter.toLowerCase();
  const files = project.files.filter((f) => !f.isDir && (!q || f.path.toLowerCase().includes(q)));
  const cfg = files.filter((f) => f.kind === "config" || f.kind === "makefile");
  const vars = files.filter((f) => f.kind === "vars");
  const roles = useMemo(() => {
    const names = new Set<string>();
    for (const f of project.files) {
      const m = f.path.match(/(?:^|\/)roles\/(?:[^/]+\/)?([^/]+)\/tasks\/main\.ya?ml$/);
      if (m) names.add(f.path.replace(/\/tasks\/main\.ya?ml$/, ""));
    }
    return [...names].sort();
  }, [project.files]);

  return (
    <>
      {cfg.length > 0 && (
        <Group title="Configuração" count={cfg.length}>
          {cfg.map((f) => (
            <FileRow key={f.path} f={f} label={f.path} active={f.path === activePath} dirty={dirty.has(f.path)} onOpen={onOpen} />
          ))}
        </Group>
      )}
      {(["playbook", "inventory", "release", "vault"] as const).map((kind) => {
        const list = files.filter((f) => f.kind === kind);
        if (!list.length) return null;
        return (
          <Group key={kind} title={KIND_LABEL[kind]} count={list.length}>
            {list.map((f) =>
              kind === "inventory" ? (
                <InventoryRow key={f.path} root={project.root} f={f} active={f.path === activePath} dirty={dirty.has(f.path)} onOpen={onOpen} />
              ) : (
                <FileRow key={f.path} f={f} label={short(f.path)} active={f.path === activePath} dirty={dirty.has(f.path)} onOpen={onOpen} />
              ),
            )}
          </Group>
        );
      })}
      {vars.length > 0 && (
        <Group title="Variáveis" count={vars.length} closed>
          {vars.map((f) => (
            <FileRow key={f.path} f={f} label={short(f.path)} active={f.path === activePath} dirty={dirty.has(f.path)} onOpen={onOpen} />
          ))}
        </Group>
      )}
      {roles.length > 0 && (
        <Group title="Roles" count={roles.length} closed>
          {roles
            .filter((r) => !q || r.toLowerCase().includes(q))
            .map((r) => {
              const main = project.files.find((f) => f.path.startsWith(r + "/tasks/main."));
              return main ? (
                <FileRow key={r} f={main} label={r.replace(/^roles\//, "")} active={main.path === activePath} dirty={dirty.has(main.path)} onOpen={onOpen} />
              ) : null;
            })}
        </Group>
      )}
    </>
  );
}

function Group({ title, count, closed, children }: { title: string; count: number; closed?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(!closed);
  return (
    <div className="group">
      <button className="group-head" onClick={() => setOpen(!open)}>
        <span className={`chev ${open ? "open" : ""}`}>›</span>
        {title}
        <span className="count">{count}</span>
      </button>
      {open && children}
    </div>
  );
}

function InventoryRow({ root, f, active, dirty, onOpen }: { root: string; f: FileEntry; active: boolean; dirty: boolean; onOpen: (f: FileEntry) => void }) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<InventoryGroup[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !groups) {
      try {
        setGroups(await api.inventory(root, f.path));
      } catch (e) {
        setErr(errorText(e));
      }
    }
  }

  return (
    <div>
      <div className="row-with-action">
        <FileRow f={f} label={short(f.path)} active={active} dirty={dirty} onOpen={onOpen} />
        <button className="mini" onClick={toggle} title="Ver grupos e hosts (ansible-inventory)">
          {open ? "▾" : "▸"} hosts
        </button>
      </div>
      {open && (
        <div className="inv">
          {err && <pre className="err small">{err}</pre>}
          {!groups && !err && <p className="muted small">a ler o inventário…</p>}
          {groups
            ?.filter((g) => g.hosts.length || g.children.length)
            .map((g) => (
              <div key={g.name} className="inv-group">
                <span className="inv-name">{g.name}</span>
                {g.children.length > 0 && <span className="muted small"> → {g.children.join(", ")}</span>}
                {g.hosts.map((h) => (
                  <div key={h} className="inv-host">{h}</div>
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

interface Node {
  name: string;
  path: string;
  entry?: FileEntry;
  children: Map<string, Node>;
}

function Tree({ project, filter, activePath, dirty, onOpen }: Props & { filter: string }) {
  const root = useMemo(() => {
    const top: Node = { name: "", path: "", children: new Map() };
    const q = filter.toLowerCase();
    for (const f of project.files) {
      if (f.isDir) continue;
      if (q && !f.path.toLowerCase().includes(q)) continue;
      const parts = f.path.split("/");
      let cur = top;
      parts.forEach((p, i) => {
        const path = parts.slice(0, i + 1).join("/");
        if (!cur.children.has(p)) cur.children.set(p, { name: p, path, children: new Map() });
        cur = cur.children.get(p)!;
        if (i === parts.length - 1) cur.entry = f;
      });
    }
    return top;
  }, [project.files, filter]);

  return <TreeLevel node={root} depth={0} forceOpen={!!filter} activePath={activePath} dirty={dirty} onOpen={onOpen} />;
}

function TreeLevel({ node, depth, forceOpen, activePath, dirty, onOpen }: { node: Node; depth: number; forceOpen: boolean; activePath: string | null; dirty: Set<string>; onOpen: (f: FileEntry) => void }) {
  const kids = [...node.children.values()].sort((a, b) => {
    const ad = a.entry ? 1 : 0;
    const bd = b.entry ? 1 : 0;
    return ad - bd || a.name.localeCompare(b.name);
  });
  return (
    <>
      {kids.map((k) =>
        k.entry ? (
          <FileRow key={k.path} f={k.entry} label={k.name} depth={depth} active={k.path === activePath} dirty={dirty.has(k.path)} onOpen={onOpen} />
        ) : (
          <Dir key={k.path} node={k} depth={depth} forceOpen={forceOpen} activePath={activePath} dirty={dirty} onOpen={onOpen} />
        ),
      )}
    </>
  );
}

function Dir(props: { node: Node; depth: number; forceOpen: boolean; activePath: string | null; dirty: Set<string>; onOpen: (f: FileEntry) => void }) {
  const { node, depth, forceOpen, activePath } = props;
  const [open, setOpen] = useState(depth === 0 && !!activePath?.startsWith(node.path + "/"));
  const shown = open || forceOpen;
  return (
    <>
      <button className="row dir" style={{ paddingLeft: 10 + depth * 12 }} onClick={() => setOpen(!open)}>
        <span className={`chev ${shown ? "open" : ""}`}>›</span>
        <span className="row-label">{node.name}</span>
      </button>
      {shown && <TreeLevel {...props} node={node} depth={depth + 1} />}
    </>
  );
}
