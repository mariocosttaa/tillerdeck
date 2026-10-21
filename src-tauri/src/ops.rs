//! O que a interface v2 pergunta ao projecto além do manifesto: o estado de
//! manutenção (do inventário), o histórico de um release (do git) e o ramo.

use crate::project::resolve;
use crate::{releases, shell};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

/// As variáveis `*_maintenance_mode` de um inventário, por host.
///
/// O `ansible-inventory --list` traz TODAS as hostvars, vault decifrado
/// incluído. Daqui só sai o que acaba em `_maintenance_mode` e é booleano.
pub fn maintenance(root: &Path, inventory: &str) -> Result<BTreeMap<String, bool>, String> {
    resolve(root, inventory)?;
    let out = shell::run("ansible-inventory", &["-i", inventory, "--list"], root)?;
    if !out.ok {
        return Err(out.stderr.trim().to_string());
    }
    let v: serde_json::Value = serde_json::from_str(&out.stdout).map_err(|e| e.to_string())?;
    let mut flags = BTreeMap::new();
    if let Some(hosts) = v.pointer("/_meta/hostvars").and_then(|h| h.as_object()) {
        for vars in hosts.values() {
            for (k, val) in vars.as_object().into_iter().flatten() {
                if k.ends_with("_maintenance_mode") {
                    if let Some(b) = val.as_bool() {
                        flags.insert(k.clone(), b);
                    }
                }
            }
        }
    }
    Ok(flags)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub value: String,
    pub short: String,
    pub commit: String,
    pub date: String,
    pub subject: String,
}

/// Os valores que uma chave já teve no release, do mais recente para trás,
/// sem repetidos — é daqui que vem "Voltar à versão anterior".
pub fn history(root: &Path, release: &str, key: &str) -> Result<Vec<Revision>, String> {
    resolve(root, release)?;
    let log = shell::run("git", &["log", "-n", "40", "--format=%H%x09%ad%x09%s", "--date=short", "--", release], root)?;
    if !log.ok {
        return Err("o projecto não é um repositório git".into());
    }
    let mut out: Vec<Revision> = Vec::new();
    for line in log.stdout.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(commit), Some(date), Some(subject)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let show = shell::run("git", &["show", &format!("{commit}:{release}")], root)?;
        if !show.ok {
            continue;
        }
        let value = show.stdout.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            (k == key).then(|| v.split(" #").next().unwrap_or("").trim().trim_matches('"').to_string())
        });
        if let Some(value) = value {
            if out.last().map(|r| r.value != value).unwrap_or(true) && !out.iter().any(|r| r.value == value) {
                out.push(Revision { short: releases::short(&value), value, commit: commit[..7].to_string(), date: date.to_string(), subject: subject.to_string() });
            }
        }
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub branch: Option<String>,
    pub dirty: Vec<String>,
}

pub fn git_info(root: &Path) -> GitInfo {
    let branch = shell::run("git", &["rev-parse", "--abbrev-ref", "HEAD"], root)
        .ok()
        .filter(|o| o.ok)
        .map(|o| o.stdout.trim().to_string());
    let dirty = shell::run("git", &["status", "--porcelain"], root)
        .ok()
        .filter(|o| o.ok)
        .map(|o| o.stdout.lines().map(|l| l.get(3..).unwrap_or("").to_string()).collect())
        .unwrap_or_default();
    GitInfo { branch, dirty }
}

/// Faz commit de um ficheiro só (o release), com a mensagem dada.
pub fn commit_file(root: &Path, file: &str, message: &str) -> Result<String, String> {
    resolve(root, file)?;
    let add = shell::run("git", &["add", "--", file], root)?;
    if !add.ok {
        return Err(add.stderr);
    }
    let c = shell::run("git", &["commit", "-m", message, "--", file], root)?;
    if !c.ok {
        return Err(format!("{}{}", c.stdout, c.stderr).trim().to_string());
    }
    let head = shell::run("git", &["rev-parse", "--short", "HEAD"], root)?;
    Ok(head.stdout.trim().to_string())
}

/// Commit de vários ficheiros (os releases alterados) numa só vez.
pub fn commit_files(root: &Path, files: &[String], message: &str) -> Result<String, String> {
    if files.is_empty() {
        return Err("nada para commit".into());
    }
    for f in files {
        resolve(root, f)?;
    }
    let mut add = vec!["add", "--"];
    add.extend(files.iter().map(String::as_str));
    let a = shell::run("git", &add, root)?;
    if !a.ok {
        return Err(a.stderr);
    }
    let mut c = vec!["commit", "-m", message, "--"];
    c.extend(files.iter().map(String::as_str));
    let out = shell::run("git", &c, root)?;
    if !out.ok {
        return Err(format!("{}{}", out.stdout, out.stderr).trim().to_string());
    }
    let head = shell::run("git", &["rev-parse", "--short", "HEAD"], root)?;
    Ok(head.stdout.trim().to_string())
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub branch: Option<String>,
    pub branches: Vec<String>,
    /// o remote da branch actual (ou `origin`)
    pub remote: Option<String>,
    /// o URL sem credenciais
    pub url: Option<String>,
    pub upstream: Option<String>,
    /// commits locais por enviar / do remote por trazer (pelo último fetch — não se faz fetch aqui)
    pub ahead: u32,
    pub behind: u32,
}

fn git_line(root: &Path, args: &[&str]) -> Option<String> {
    shell::run("git", args, root).ok().filter(|o| o.ok).map(|o| o.stdout.trim().to_string()).filter(|s| !s.is_empty())
}

/// `https://user:token@host/x` → `https://host/x`: nunca mostrar credenciais.
fn strip_credentials(url: &str) -> String {
    match (url.find("://"), url.find('@')) {
        (Some(i), Some(j)) if j > i => format!("{}{}", &url[..i + 3], &url[j + 1..]),
        _ => url.to_string(),
    }
}

/// O estado do repositório em relação ao remote. Só lê.
pub fn remote(root: &Path) -> Remote {
    let branch = git_line(root, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| b != "HEAD");
    let branches = git_line(root, &["branch", "--format=%(refname:short)"]).map(|s| s.lines().map(String::from).collect()).unwrap_or_default();
    let remote = branch
        .as_ref()
        .and_then(|b| git_line(root, &["config", &format!("branch.{b}.remote")]))
        .or_else(|| git_line(root, &["remote"]).and_then(|r| r.lines().find(|l| *l == "origin").or(r.lines().next()).map(String::from)));
    let url = remote.as_ref().and_then(|r| git_line(root, &["remote", "get-url", r])).map(|u| strip_credentials(&u));
    let upstream = git_line(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    let (mut ahead, mut behind) = (0, 0);
    if upstream.is_some() {
        if let Some(c) = git_line(root, &["rev-list", "--left-right", "--count", "HEAD...@{u}"]) {
            let mut it = c.split_whitespace().map(|x| x.parse().unwrap_or(0));
            ahead = it.next().unwrap_or(0);
            behind = it.next().unwrap_or(0);
        }
    }
    Remote { branch, branches, remote, url, upstream, ahead, behind }
}

/// `git push` da branch actual para o remote dela. Recusa se a branch actual
/// não for a escolhida; nunca força. Sem terminal: sem pedir password — vale
/// o ssh-agent ou o credential helper que a máquina já tem.
pub fn push(root: &Path, branch: &str) -> Result<String, String> {
    let r = remote(root);
    let current = r.branch.ok_or("não estás em nenhuma branch")?;
    if current != branch {
        return Err(format!("estás em `{current}`, não em `{branch}` — o push não foi feito"));
    }
    let name = r.remote.ok_or("o repositório não tem remote")?;
    let mut cmd = shell::command("git", root);
    cmd.args(["push", "--porcelain", &name, &format!("HEAD:refs/heads/{branch}")]).env("GIT_TERMINAL_PROMPT", "0");
    if r.upstream.is_none() {
        cmd.arg("--set-upstream");
    }
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    let out = cmd.output().map_err(|e| format!("não foi possível correr `git`: {e}"))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        return Err(strip_credentials(text.trim()));
    }
    Ok(format!("{name}/{branch}"))
}

/// git com variáveis de ambiente e, opcionalmente, um stdin.
fn git_with(root: &Path, args: &[&str], envs: &[(&str, &str)], stdin: Option<&str>) -> Result<shell::Output, String> {
    use std::io::Write;
    let mut cmd = shell::command("git", root);
    cmd.args(args).env("GIT_TERMINAL_PROMPT", "0");
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    if stdin.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    }
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("não foi possível correr `git`: {e}"))?;
    if let Some(text) = stdin {
        child.stdin.take().ok_or("sem stdin")?.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(shell::Output { ok: out.status.success(), stdout: String::from_utf8_lossy(&out.stdout).into_owned(), stderr: String::from_utf8_lossy(&out.stderr).into_owned() })
}

fn must(o: shell::Output) -> Result<String, String> {
    if o.ok { Ok(o.stdout.trim().to_string()) } else { Err(strip_credentials(format!("{}{}", o.stdout, o.stderr).trim())) }
}

/// Um commit em `branch` (como está agora no remote) com as chaves de release que mudaram.
fn commit_on(root: &Path, name: &str, files: &[String], message: &str, branch: &str) -> Result<String, String> {
    must(git_with(root, &["fetch", "--quiet", &name, &format!("refs/heads/{branch}")], &[], None)?)
        .map_err(|e| format!("não consegui ler `{name}/{branch}`: {e}"))?;
    let base = must(git_with(root, &["rev-parse", "FETCH_HEAD"], &[], None)?)?;
    let prefix = must(git_with(root, &["rev-parse", "--show-prefix"], &[], None)?).unwrap_or_default();

    let index = std::env::temp_dir().join(format!("am-index-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    let index_s = index.to_string_lossy().to_string();
    let env = [("GIT_INDEX_FILE", index_s.as_str())];
    let result = (|| -> Result<String, String> {
        must(git_with(root, &["read-tree", &base], &env, None)?)?;
        let mut changed = Vec::new();
        for f in files {
            let path = format!("{prefix}{f}");
            let head = git_with(root, &["show", &format!("HEAD:{path}")], &[], None)?;
            let before = if head.ok { crate::releases::parse(&head.stdout) } else { Default::default() };
            let now = crate::releases::parse(&std::fs::read_to_string(root.join(f)).map_err(|e| format!("{f}: {e}"))?);
            let keys: Vec<(&String, &String)> = now.iter().filter(|(k, v)| before.get(*k) != Some(*v)).collect();
            if keys.is_empty() {
                continue;
            }
            let mut text = must(git_with(root, &["show", &format!("{base}:{path}")], &[], None)?)
                .map_err(|_| format!("`{f}` não existe em `{branch}`"))?;
            text.push('\n');
            for (k, v) in &keys {
                text = crate::releases::replace_in_text(&text, k, v).map_err(|e| format!("{f} em `{branch}`: {e}"))?.0;
                changed.push(format!("{k}={v}"));
            }
            let blob = must(git_with(root, &["hash-object", "-w", "--stdin"], &[], Some(&text))?)?;
            must(git_with(root, &["update-index", "--add", "--cacheinfo", &format!("100644,{blob},{path}")], &env, None)?)?;
        }
        if changed.is_empty() {
            return Err(format!("nada mudou em relação a `{branch}`"));
        }
        let tree = must(git_with(root, &["write-tree"], &env, None)?)?;
        must(git_with(root, &["commit-tree", &tree, "-p", &base, "-m", message], &[], None)?)
    })();
    let _ = std::fs::remove_file(&index);
    result
}

/// O essencial de um push recusado: sem cores e sem o ruído dos hooks.
fn push_error(text: &str) -> String {
    let mut clean = String::new();
    let mut esc = false;
    for c in text.chars() {
        if esc {
            if c.is_ascii_alphabetic() { esc = false; }
            continue;
        }
        if c == '\u{1b}' { esc = true; continue; }
        clean.push(c);
    }
    let clean = strip_credentials(&clean);
    let key: Vec<&str> = clean
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('!') || l.starts_with("error:") || l.starts_with("fatal:") || l.starts_with("remote: error") || l.contains("rejected"))
        .collect();
    if key.is_empty() {
        clean.lines().rev().filter(|l| !l.trim().is_empty()).take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
    } else {
        key.join("\n")
    }
}

/// Guarda os releases alterados na branch escolhida e envia-a.
///
/// Na própria branch: commit e push normais. Noutra branch: o commit faz-se
/// SEM checkout — parte da branch no remote, aplica só as chaves que mudaram
/// (não o ficheiro inteiro da tua branch) num índice temporário e envia.
/// A tua branch, o índice e os ficheiros por gravar ficam como estavam.
pub fn publish(root: &Path, files: &[String], message: &str, branch: &str) -> Result<String, String> {
    let r = remote(root);
    let current = r.branch.clone().unwrap_or_default();
    if branch.is_empty() || branch == current {
        let sha = commit_files(root, files, message)?;
        let to = push(root, &current)?;
        return Ok(format!("{sha} → {to}"));
    }
    let name = r.remote.ok_or("o repositório não tem remote")?;
    for f in files {
        resolve(root, f)?;
    }
    // Se a branch mudar no remote entretanto (outro push durante o hook
    // pre-push, por exemplo), volta-se a ler e a fazer o commit por cima.
    let mut attempt = 0;
    let commit = loop {
        attempt += 1;
        let commit = commit_on(root, &name, files, message, branch)?;
        let out = git_with(root, &["push", "--porcelain", &name, &format!("{commit}:refs/heads/{branch}")], &[], None)?;
        if out.ok {
            break commit;
        }
        let text = format!("{}{}", out.stdout, out.stderr);
        let moved = ["cannot lock ref", "fetch first", "non-fast-forward", "stale info", "incorrect old value"].iter().any(|k| text.contains(k));
        if !moved || attempt >= 3 {
            return Err(format!("o push para `{branch}` foi recusado: {}", push_error(&text)));
        }
    };
    // a branch local acompanha, se não estiver aberta noutra worktree e for só avançar
    let local = format!("refs/heads/{branch}");
    let checked_out = git_line(root, &["worktree", "list", "--porcelain"]).is_some_and(|w| w.lines().any(|l| l == format!("branch {local}")));
    let fast_forward = !git_with(root, &["rev-parse", "--verify", "--quiet", &local], &[], None)?.ok
        || git_with(root, &["merge-base", "--is-ancestor", &local, &commit], &[], None)?.ok;
    if !checked_out && fast_forward {
        let _ = git_with(root, &["update-ref", &local, &commit], &[], None);
    }
    Ok(format!("{} → {name}/{branch}", &commit[..7.min(commit.len())]))
}

#[cfg(test)]
mod tests {
    #[test]
    fn push_and_remote_on_a_local_bare_repo() {
        // um remote "bare" num directório temporário — nada sai da máquina
        let dir = std::env::temp_dir().join(format!("am-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (bare, work) = (dir.join("remote.git"), dir.join("work"));
        std::fs::create_dir_all(&work).unwrap();
        let git = |cwd: &std::path::Path, args: &[&str]| assert!(crate::shell::run("git", args, cwd).unwrap().ok, "git {args:?}");
        git(&dir, &["init", "-q", "--bare", bare.to_str().unwrap()]);
        git(&work, &["init", "-q", "-b", "main"]);
        git(&work, &["config", "user.email", "t@example.com"]);
        git(&work, &["config", "user.name", "T"]);
        git(&work, &["remote", "add", "origin", bare.to_str().unwrap()]);
        std::fs::create_dir_all(work.join("releases")).unwrap();
        std::fs::write(work.join("releases/staging.yml"), "api_tag: 1.0.0\n").unwrap();
        std::fs::write(work.join("other.txt"), "x").unwrap();
        let sha = super::commit_files(&work, &["releases/staging.yml".into()], "chore(release): api 1.0.0 on staging").unwrap();
        assert!(!sha.is_empty());
        // só o release entrou no commit
        assert!(crate::shell::run("git", &["status", "--porcelain"], &work).unwrap().stdout.contains("other.txt"));
        assert!(super::push(&work, "feature").is_err(), "branch errada não faz push");
        assert_eq!(super::push(&work, "main").unwrap(), "origin/main");
        let r = super::remote(&work);
        assert_eq!((r.branch.as_deref(), r.upstream.as_deref(), r.ahead, r.behind), (Some("main"), Some("origin/main"), 0, 0));
        assert_eq!(super::strip_credentials("https://u:tok@github.com/a/b.git"), "https://github.com/a/b.git");

        // Noutra branch: trabalho a meio no "VS Code", e o release vai para a main sem checkout.
        git(&work, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(work.join("releases/staging.yml"), "api_tag: 1.0.0\nfeature_only: yes\n").unwrap();
        git(&work, &["commit", "-qam", "feature work"]);
        std::fs::write(work.join("wip.txt"), "por gravar").unwrap();
        std::fs::write(work.join("releases/staging.yml"), "api_tag: 2.0.0\nfeature_only: yes\n").unwrap();
        let out = super::publish(&work, &["releases/staging.yml".into()], "chore(release): api 2.0.0 on staging", "main").unwrap();
        assert!(out.ends_with("origin/main"), "{out}");
        let show = |r: &str| crate::shell::run("git", &["show", r], &work).unwrap().stdout;
        // na main: só a chave que mudou, sem o que é da feature
        assert_eq!(show("origin/main:releases/staging.yml"), "api_tag: 2.0.0\n");
        assert_eq!(show("main:releases/staging.yml"), "api_tag: 2.0.0\n", "a main local acompanha");
        // a branch e os ficheiros de trabalho não mexeram
        assert_eq!(super::remote(&work).branch.as_deref(), Some("feature"));
        assert!(work.join("wip.txt").exists());
        assert_eq!(std::fs::read_to_string(work.join("releases/staging.yml")).unwrap(), "api_tag: 2.0.0\nfeature_only: yes\n");
        assert!(super::publish(&work, &["releases/staging.yml".into()], "x", "nao-existe").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn maintenance_flags_only() {
        let Ok(roots) = std::env::var("TILLERDECK_FIXTURES") else { return };
        let root = std::path::Path::new(roots.split(':').next().unwrap());
        for inv in ["inventories/staging.ini", "inventories/production.ini"] {
            let m = super::maintenance(root, inv).unwrap();
            println!("{inv}: {m:?}");
            assert!(m.keys().all(|k| k.ends_with("_maintenance_mode")));
        }
        let h = super::history(root, "releases/production.yml", "api_tag").unwrap();
        println!("api_tag em produção, {} versões: {:?}", h.len(), h.iter().take(4).map(|r| (&r.short, &r.date)).collect::<Vec<_>>());
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub short: String,
    pub date: String,
    pub subject: String,
    pub author: String,
}

/// Os últimos commits de um repositório local (o da aplicação, ao lado do
/// projecto). Só lê — nem `fetch` faz.
pub fn commits(root: &Path, repo: &str, branch: Option<&str>, limit: usize) -> Result<Vec<Commit>, String> {
    let dir = root.join(repo);
    if !dir.is_dir() {
        return Err(format!("`{repo}` não existe"));
    }
    let n = limit.to_string();
    let mut args = vec!["log", "-n", &n, "--format=%H%x1f%h%x1f%cI%x1f%an%x1f%s"];
    if let Some(b) = branch.filter(|b| !b.is_empty()) {
        args.push(b);
    }
    let out = shell::run("git", &args, &dir)?;
    if !out.ok {
        return Err(format!("`{repo}` não é um repositório git"));
    }
    Ok(out
        .stdout
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\x1f').collect();
            (f.len() == 5).then(|| Commit { sha: f[0].into(), short: f[1].into(), date: f[2].into(), author: f[3].into(), subject: f[4].into() })
        })
        .collect())
}
