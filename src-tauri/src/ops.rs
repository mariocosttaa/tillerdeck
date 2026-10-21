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

#[cfg(test)]
mod tests {
    #[test]
    fn maintenance_flags_only() {
        let Ok(roots) = std::env::var("ANSIBLE_MARIO_FIXTURES") else { return };
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
