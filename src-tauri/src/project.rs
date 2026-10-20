//! Ler um projecto Ansible: a árvore, o que é playbook, inventário, release
//! ou vault, os alvos do Makefile e a configuração efectiva.
//!
//! Nada aqui interpreta o `ansible.cfg` ou os inventários à mão: quem sabe o
//! que eles querem dizer é o próprio Ansible, e por isso pergunta-se-lhe.

use crate::shell;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const SKIP_DIRS: &[&str] = &[".git", "node_modules", ".venv", "venv", "__pycache__", ".tox", "collections"];
const MAX_FILES: usize = 5000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// Caminho relativo à raiz, com `/`.
    pub path: String,
    pub is_dir: bool,
    /// playbook · inventory · release · vars · role · vault · config · makefile · other
    pub kind: String,
    pub vault: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub root: String,
    pub name: String,
    pub has_config: bool,
    pub files: Vec<FileEntry>,
    pub truncated: bool,
}

/// Sobe a partir do caminho escolhido até encontrar um `ansible.cfg`. Se não
/// houver nenhum, o próprio caminho é a raiz — há projectos sem cfg.
pub fn find_root(start: &Path) -> (PathBuf, bool) {
    let start = if start.is_file() { start.parent().unwrap_or(start) } else { start };
    let mut cur = Some(start);
    while let Some(dir) = cur {
        if dir.join("ansible.cfg").is_file() {
            return (dir.to_path_buf(), true);
        }
        cur = dir.parent();
    }
    (start.to_path_buf(), false)
}

/// Garante que `rel` fica dentro de `root` — a app só lê e escreve no projecto.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| format!("raiz inválida: {e}"))?;
    let joined = root.join(rel);
    // O ficheiro pode ainda não existir (gravar um novo): valida-se a pasta.
    let parent = joined.parent().ok_or("caminho inválido")?;
    let parent = parent.canonicalize().map_err(|e| format!("{}: {e}", parent.display()))?;
    if !parent.starts_with(&root) {
        return Err(format!("`{rel}` está fora do projecto"));
    }
    Ok(parent.join(joined.file_name().ok_or("caminho inválido")?))
}

pub fn is_vault_text(head: &str) -> bool {
    head.starts_with("$ANSIBLE_VAULT;")
}

fn read_head(path: &Path, n: usize) -> String {
    use std::io::Read;
    let mut buf = vec![0u8; n];
    match fs::File::open(path).and_then(|mut f| f.read(&mut buf)) {
        Ok(read) => String::from_utf8_lossy(&buf[..read]).into_owned(),
        Err(_) => String::new(),
    }
}

/// Um playbook é uma lista no topo cujos itens têm `hosts:` ou importam
/// outro playbook. Os ficheiros de tasks também são listas — o que os
/// distingue é o `hosts`.
fn looks_like_playbook(text: &str) -> bool {
    let mut is_list = false;
    for line in text.lines() {
        let t = line.trim_end();
        if t.is_empty() || t.starts_with('#') || t == "---" {
            continue;
        }
        if !is_list {
            if !t.starts_with("- ") && t != "-" {
                return false;
            }
            is_list = true;
        }
        let k = t.trim_start().trim_start_matches("- ");
        if k.starts_with("hosts:")
            || k.starts_with("import_playbook:")
            || k.starts_with("ansible.builtin.import_playbook:")
        {
            return true;
        }
    }
    false
}

fn classify(rel: &str, abs: &Path) -> (String, bool) {
    let lower = rel.to_lowercase();
    let file = lower.rsplit('/').next().unwrap_or(&lower);
    let ext = file.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    let parts: Vec<&str> = lower.split('/').collect();
    let in_dir = |d: &str| parts[..parts.len().saturating_sub(1)].contains(&d);

    if file == "ansible.cfg" {
        return ("config".into(), false);
    }
    if file == "makefile" {
        return ("makefile".into(), false);
    }
    let yamlish = matches!(ext, "yml" | "yaml");
    let head = if yamlish || ext == "ini" || ext.is_empty() { read_head(abs, 16 * 1024) } else { String::new() };
    let vault = is_vault_text(&head);

    if in_dir("roles") {
        return ("role".into(), vault);
    }
    if in_dir("group_vars") || in_dir("host_vars") || in_dir("vars") || in_dir("defaults") {
        return (if vault { "vault" } else { "vars" }.into(), vault);
    }
    if vault {
        return ("vault".into(), true);
    }
    if in_dir("inventories") || in_dir("inventory") || file == "hosts" || file == "inventory" || file.starts_with("hosts.") {
        if ext == "ini" || ext.is_empty() || yamlish {
            return ("inventory".into(), false);
        }
    }
    if in_dir("releases") && yamlish {
        return ("release".into(), false);
    }
    if yamlish && looks_like_playbook(&head) {
        return ("playbook".into(), false);
    }
    ("other".into(), false)
}

pub fn scan(root: &Path) -> Project {
    let (root, has_config) = find_root(root);
    let mut files = Vec::new();
    let mut truncated = false;
    let walker = WalkDir::new(&root).sort_by_file_name().into_iter().filter_entry(|e| {
        let n = e.file_name().to_string_lossy();
        !(e.depth() > 0 && (SKIP_DIRS.contains(&n.as_ref()) || n == ".DS_Store"))
    });
    for entry in walker.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        if files.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        let rel = entry
            .path()
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let is_dir = entry.file_type().is_dir();
        let (kind, vault) = if is_dir { ("dir".into(), false) } else { classify(&rel, entry.path()) };
        files.push(FileEntry { path: rel, is_dir, kind, vault });
    }
    Project {
        name: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        root: root.to_string_lossy().into_owned(),
        has_config,
        files,
        truncated,
    }
}

// ---------------------------------------------------------------------------
// Makefile
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MakeTarget {
    pub name: String,
    pub description: String,
    pub section: String,
    /// As linhas da receita, tal como estão escritas — para mostrar antes de
    /// correr. Não se usa `make -n`: num Makefile com `$(shell …)` até o
    /// dry-run executa coisas.
    pub recipe: Vec<String>,
    /// O Makefile lê `CONFIRM` (a trava interactiva com `read`). Sem terminal
    /// o `read` falha; a app confirma ela própria e passa `CONFIRM=yes`.
    pub uses_confirm: bool,
}

/// Lê os alvos do Makefile sem o executar. Segue a convenção `alvo: ## descrição`
/// e as secções `##@ título`; sem `##`, lista os alvos explícitos na mesma.
pub fn make_targets(root: &Path) -> Vec<MakeTarget> {
    let Ok(text) = fs::read_to_string(root.join("Makefile")) else { return vec![] };
    let mut out: Vec<MakeTarget> = Vec::new();
    let mut section = String::new();
    let mut current: Option<usize> = None;
    let mut defines: std::collections::HashMap<String, Vec<String>> = Default::default();
    let mut in_define: Option<String> = None;

    for line in text.lines() {
        if let Some(name) = &in_define {
            if line.trim() == "endef" {
                in_define = None;
            } else {
                defines.get_mut(name).unwrap().push(line.to_string());
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("define ") {
            let n = rest.trim().trim_end_matches('=').trim().to_string();
            defines.insert(n.clone(), vec![]);
            in_define = Some(n);
            current = None;
            continue;
        }
        if let Some(s) = line.strip_prefix("##@") {
            section = s.trim().to_string();
            current = None;
            continue;
        }
        if line.starts_with('\t') {
            if let Some(i) = current {
                out[i].recipe.push(line.trim_start_matches('\t').to_string());
            }
            continue;
        }
        current = None;
        if line.starts_with('.') || line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        // `alvo: deps ## descrição` — mas não `VAR := x` nem `VAR ?= x`.
        let Some(colon) = line.find(':') else { continue };
        let name = &line[..colon];
        let after = &line[colon + 1..];
        if after.starts_with('=') || name.contains('=') || name.contains('%') || name.contains('$') {
            continue;
        }
        let name = name.trim();
        if name.is_empty() || name.contains(' ') {
            continue;
        }
        let description = after.split_once("##").map(|(_, d)| d.trim().to_string()).unwrap_or_default();
        out.push(MakeTarget {
            name: name.to_string(),
            description,
            section: section.clone(),
            recipe: vec![],
            uses_confirm: false,
        });
        current = Some(out.len() - 1);
    }

    let confirm_var = text.contains("$(CONFIRM)") || text.contains("${CONFIRM}");
    for t in &mut out {
        // A trava pode estar num `define` chamado pela receita.
        let calls_define_with_read = t.recipe.iter().any(|r| {
            defines.iter().any(|(n, body)| {
                r.contains(&format!("call {n}")) && body.iter().any(|b| b.contains("read "))
            })
        });
        t.uses_confirm = confirm_var
            && (calls_define_with_read || t.recipe.iter().any(|r| r.contains("CONFIRM")));
    }
    out
}

// ---------------------------------------------------------------------------
// Ansible: configuração e inventários
// ---------------------------------------------------------------------------

pub fn config_dump(root: &Path) -> Result<serde_json::Value, String> {
    // Sem o ANSIBLE_NOCOLOR que a app põe em todos os comandos: aqui só
    // interessa o que vem do projecto.
    let out = shell::command("ansible-config", root)
        .args(["dump", "--only-changed", "--format", "json"])
        .env_remove("ANSIBLE_NOCOLOR")
        .output()
        .map_err(|e| format!("não foi possível correr `ansible-config`: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("resposta inesperada do ansible-config: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryGroup {
    pub name: String,
    pub hosts: Vec<String>,
    pub children: Vec<String>,
}

/// Grupos e hosts de um inventário, pelo `ansible-inventory`.
///
/// O `--list` traz as hostvars em `_meta` — com o vault decifrado. Essas
/// ficam aqui e nunca chegam à interface.
pub fn inventory(root: &Path, inventory: &str) -> Result<Vec<InventoryGroup>, String> {
    resolve(root, inventory)?;
    let out = shell::run("ansible-inventory", &["-i", inventory, "--list"], root)?;
    if !out.ok {
        return Err(out.stderr);
    }
    let v: serde_json::Value =
        serde_json::from_str(&out.stdout).map_err(|e| format!("resposta inesperada do ansible-inventory: {e}"))?;
    let obj = v.as_object().ok_or("resposta inesperada do ansible-inventory")?;
    let strs = |x: Option<&serde_json::Value>| -> Vec<String> {
        x.and_then(|a| a.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
            .unwrap_or_default()
    };
    let mut groups: Vec<InventoryGroup> = obj
        .iter()
        .filter(|(k, _)| k.as_str() != "_meta")
        .map(|(k, g)| InventoryGroup {
            name: k.clone(),
            hosts: strs(g.get("hosts")),
            children: strs(g.get("children")),
        })
        .collect();
    groups.sort_by(|a, b| (a.name != "all", &a.name).cmp(&(b.name != "all", &b.name)));
    Ok(groups)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub ok: bool,
    pub output: String,
}

pub fn syntax_check(root: &Path, playbook: &str, inventory: Option<&str>) -> Result<CheckResult, String> {
    resolve(root, playbook)?;
    let mut args = vec!["--syntax-check", playbook];
    if let Some(inv) = inventory {
        resolve(root, inv)?;
        args.extend(["-i", inv]);
    }
    let out = shell::run("ansible-playbook", &args, root)?;
    Ok(CheckResult { ok: out.ok, output: format!("{}{}", out.stdout, out.stderr).trim().to_string() })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintIssue {
    pub line: u32,
    pub column: u32,
    pub rule: String,
    pub message: String,
    pub severity: String,
}

/// `ansible-lint` a um ficheiro, no formato codeclimate (JSON).
pub fn lint(root: &Path, file: &str) -> Result<Vec<LintIssue>, String> {
    resolve(root, file)?;
    let out = shell::run("ansible-lint", &["--nocolor", "--offline", "-f", "codeclimate", file], root)?;
    // Sai com código ≠ 0 quando há problemas — isso não é erro nosso.
    let start = out.stdout.find('[');
    let Some(start) = start else {
        if out.ok {
            return Ok(vec![]);
        }
        return Err(out.stderr.trim().to_string());
    };
    let v: serde_json::Value = serde_json::from_str(&out.stdout[start..])
        .map_err(|e| format!("resposta inesperada do ansible-lint: {e}"))?;
    let mut issues = Vec::new();
    for item in v.as_array().into_iter().flatten() {
        let path = item.pointer("/location/path").and_then(|p| p.as_str()).unwrap_or("");
        if !path.is_empty() && path != file && !file.ends_with(path) {
            continue;
        }
        let line = item
            .pointer("/location/positions/begin/line")
            .or_else(|| item.pointer("/location/lines/begin"))
            .and_then(|l| l.as_u64())
            .unwrap_or(1) as u32;
        let column = item.pointer("/location/positions/begin/column").and_then(|l| l.as_u64()).unwrap_or(1) as u32;
        issues.push(LintIssue {
            line,
            column,
            rule: item.get("check_name").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            message: item.get("description").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            severity: item.get("severity").and_then(|s| s.as_str()).unwrap_or("minor").to_string(),
        });
    }
    Ok(issues)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Projectos reais, só lidos. `ANSIBLE_MARIO_FIXTURES` = pastas separadas por `:`.
    fn fixtures() -> Vec<PathBuf> {
        std::env::var("ANSIBLE_MARIO_FIXTURES")
            .map(|s| s.split(':').map(PathBuf::from).filter(|p| p.is_dir()).collect())
            .unwrap_or_default()
    }

    #[test]
    fn playbook_detection() {
        assert!(looks_like_playbook("---\n# x\n- name: a\n  hosts: all\n"));
        assert!(looks_like_playbook("- import_playbook: x.yml\n"));
        assert!(!looks_like_playbook("- name: task\n  ansible.builtin.debug: {}\n"));
        assert!(!looks_like_playbook("hosts: all\n"));
    }

    #[test]
    fn real_projects() {
        for root in fixtures() {
            let p = scan(&root);
            let count = |k: &str| p.files.iter().filter(|f| f.kind == k).count();
            println!(
                "{}: {} ficheiros · playbooks {} · inventários {} · releases {} · vaults {}",
                p.name, p.files.len(), count("playbook"), count("inventory"), count("release"), count("vault")
            );
            assert!(p.has_config);
            assert!(count("playbook") > 0);
            assert!(count("vault") > 0);
            let targets = make_targets(&root);
            println!("  make: {} alvos, {} com trava", targets.len(), targets.iter().filter(|t| t.uses_confirm).count());
            let inv = p.files.iter().find(|f| f.kind == "inventory" && f.path.ends_with(".ini")).unwrap();
            let groups = inventory(&root, &inv.path).expect("inventário");
            println!("  {}: {:?}", inv.path, groups.iter().map(|g| (&g.name, &g.hosts)).collect::<Vec<_>>());
            let pb = p.files.iter().find(|f| f.kind == "playbook").unwrap();
            let r = syntax_check(&root, &pb.path, Some(&inv.path)).unwrap();
            println!("  syntax-check {}: {}", pb.path, r.ok);
            assert!(r.ok, "{}", r.output);
            assert!(config_dump(&root).unwrap().is_array());
        }
    }
}

#[cfg(test)]
mod lint_tests {
    #[test]
    fn lint_real_playbook() {
        let Ok(roots) = std::env::var("ANSIBLE_MARIO_FIXTURES") else { return };
        let root = std::path::PathBuf::from(roots.split(':').next().unwrap());
        let issues = super::lint(&root, "playbooks/01-prepare-machine.yml");
        match issues {
            Ok(i) => println!("lint: {} problemas · {:?}", i.len(), i.iter().take(3).map(|x| (&x.rule, x.line)).collect::<Vec<_>>()),
            Err(e) => println!("lint erro: {e}"),
        }
    }
}

#[cfg(test)]
mod lint_parse_tests {
    #[test]
    fn reports_real_findings_with_lines() {
        let dir = std::env::temp_dir().join(format!("ansible-mario-lint-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ansible.cfg"), "[defaults]\n").unwrap();
        std::fs::write(
            dir.join("pb.yml"),
            "---\n- hosts: all\n  tasks:\n    - shell: echo ola\n    - name: com nome\n      ansible.builtin.command: ls\n",
        )
        .unwrap();
        let issues = super::lint(&dir, "pb.yml").expect("lint corre");
        println!("{:?}", issues.iter().map(|i| (&i.rule, i.line)).collect::<Vec<_>>());
        assert!(!issues.is_empty(), "uma task sem nome e com `shell` tem de dar problemas");
        assert!(issues.iter().all(|i| !i.rule.is_empty() && i.line >= 1));
        assert!(issues.iter().any(|i| i.line == 4), "o problema está na linha 4");
        std::fs::remove_dir_all(dir).ok();
    }
}
