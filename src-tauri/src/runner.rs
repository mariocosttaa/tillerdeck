//! Corridas: `ansible-playbook` e alvos do `make`, com o output em directo.
//!
//! Um deploy pode levar uma hora. O processo arranca num grupo próprio, o
//! output sobe linha a linha como evento, e o cancelamento manda o sinal ao
//! grupo inteiro — o ansible e os ssh que ele abriu. Cada corrida fica num
//! ficheiro de log e numa entrada do histórico.

use crate::project::resolve;
use crate::shell;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const HISTORY_MAX: usize = 300;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RunSpec {
    #[serde(rename = "playbook")]
    Playbook {
        playbook: String,
        inventory: String,
        #[serde(default)]
        extra_var_files: Vec<String>,
        #[serde(default)]
        limit: String,
        #[serde(default)]
        tags: String,
        #[serde(default)]
        skip_tags: String,
        #[serde(default)]
        check: bool,
        #[serde(default)]
        diff: bool,
        #[serde(default)]
        verbosity: u8,
        #[serde(default)]
        extra_args: String,
    },
    #[serde(rename = "make")]
    Make {
        target: String,
        #[serde(default)]
        vars: Vec<(String, String)>,
    },
}

/// O que a interface v2 sabe de uma corrida: o que é, sobre quê, onde.
/// Fica no histórico para as Execuções e para "último deploy".
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunMeta {
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    /// `produto.serviço`, quando a corrida é sobre um serviço
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    /// deploy · migrate · seed · promote · operação…
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    /// a versão que se quis instalar
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub root: String,
    pub label: String,
    pub argv: Vec<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub exit_code: Option<i32>,
    pub cancelled: bool,
    pub log_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<RunMeta>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OutputEvent<'a> {
    id: &'a str,
    stream: &'a str,
    line: String,
}

struct Running {
    pgid: i32,
    signals_sent: u8,
    root: String,
    env: Option<String>,
}

#[derive(Default)]
pub struct Runs {
    running: Mutex<HashMap<String, Running>>,
    history_lock: Mutex<()>,
}

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(d.join("logs")).map_err(|e| e.to_string())?;
    Ok(d)
}

fn history_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("history.json"))
}

pub fn history<R: Runtime>(app: &AppHandle<R>) -> Vec<HistoryEntry> {
    history_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn upsert_history<R: Runtime>(app: &AppHandle<R>, runs: &Runs, entry: &HistoryEntry) {
    let _g = runs.history_lock.lock().unwrap();
    let mut all = history(app);
    all.retain(|e| e.id != entry.id);
    all.insert(0, entry.clone());
    all.truncate(HISTORY_MAX);
    if let Ok(p) = history_path(app) {
        let _ = fs::write(p, serde_json::to_string_pretty(&all).unwrap_or_default());
    }
}

fn build_argv(root: &Path, spec: &RunSpec) -> Result<(String, Vec<String>, String), String> {
    match spec {
        RunSpec::Playbook {
            playbook,
            inventory,
            extra_var_files,
            limit,
            tags,
            skip_tags,
            check,
            diff,
            verbosity,
            extra_args,
        } => {
            // Sem inventário não se corre: escolher o ambiente é sempre um acto
            // explícito, nunca uma omissão.
            if inventory.trim().is_empty() {
                return Err("escolhe um inventário".into());
            }
            resolve(root, playbook)?;
            resolve(root, inventory)?;
            let mut a: Vec<String> = vec![playbook.clone(), "-i".into(), inventory.clone()];
            for f in extra_var_files {
                resolve(root, f)?;
                a.push("-e".into());
                a.push(format!("@{f}"));
            }
            for (flag, v) in [("--limit", limit), ("--tags", tags), ("--skip-tags", skip_tags)] {
                if !v.trim().is_empty() {
                    a.push(flag.into());
                    a.push(v.trim().into());
                }
            }
            if *check {
                a.push("--check".into());
            }
            if *diff {
                a.push("--diff".into());
            }
            if *verbosity > 0 {
                a.push(format!("-{}", "v".repeat((*verbosity).min(4) as usize)));
            }
            a.extend(shell_words::split(extra_args).map_err(|e| format!("argumentos extra: {e}"))?);
            let label = format!("{playbook} · {inventory}");
            Ok(("ansible-playbook".into(), a, label))
        }
        RunSpec::Make { target, vars } => {
            if target.is_empty() || target.starts_with('-') {
                return Err("alvo inválido".into());
            }
            let mut a = vec![target.clone()];
            for (k, v) in vars {
                if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    return Err(format!("variável inválida: `{k}`"));
                }
                a.push(format!("{k}={v}"));
            }
            Ok(("make".into(), a, format!("make {target}")))
        }
    }
}

fn pump<RT: Runtime, R: std::io::Read + Send + 'static>(
    app: AppHandle<RT>,
    id: String,
    stream: &'static str,
    reader: R,
    log: Arc<Mutex<File>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut r = BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match r.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).trim_end_matches(['\n', '\r']).to_string();
                    if let Ok(mut f) = log.lock() {
                        let _ = writeln!(f, "{line}");
                    }
                    let _ = app.emit("run-output", OutputEvent { id: &id, stream, line });
                }
            }
        }
    })
}

pub fn start<R: Runtime>(app: AppHandle<R>, runs: Arc<Runs>, root: &Path, spec: RunSpec, meta: Option<RunMeta>) -> Result<HistoryEntry, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    // Um serviço de cada vez por ambiente: duas corridas na mesma máquina
    // pisam-se (o Makefile do saco-infra diz o mesmo).
    if let Some(env) = meta.as_ref().and_then(|m| m.env.as_ref()) {
        let root_s = root.to_string_lossy();
        if runs.running.lock().unwrap().values().any(|r| r.root == root_s && r.env.as_ref() == Some(env)) {
            return Err(format!("já há uma corrida em {env} — espera que acabe ou cancela-a"));
        }
    }
    let (program, args, label) = build_argv(&root, &spec)?;
    let id = format!("{}-{:04x}", chrono::Local::now().format("%Y%m%d-%H%M%S"), rand_suffix());
    let log_path = data_dir(&app)?.join("logs").join(format!("{id}.log"));
    let log = Arc::new(Mutex::new(
        OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e| e.to_string())?,
    ));

    let mut argv = vec![program.clone()];
    argv.extend(args.iter().cloned());
    {
        let mut f = log.lock().unwrap();
        let _ = writeln!(f, "$ cd {}", root.display());
        let _ = writeln!(f, "$ {}", shell_words::join(&argv));
    }

    let mut cmd = shell::command(&program, &root);
    cmd.args(&args)
        .env_remove("ANSIBLE_NOCOLOR")
        .env("ANSIBLE_FORCE_COLOR", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = cmd.spawn().map_err(|e| format!("não foi possível correr `{program}`: {e}"))?;
    let pgid = child.id() as i32;

    let mut entry = HistoryEntry {
        id: id.clone(),
        root: root.to_string_lossy().into_owned(),
        label,
        argv,
        started_at: chrono::Local::now().to_rfc3339(),
        ended_at: None,
        exit_code: None,
        cancelled: false,
        log_path: log_path.to_string_lossy().into_owned(),
        meta: meta.clone(),
    };
    upsert_history(&app, &runs, &entry);
    runs.running.lock().unwrap().insert(id.clone(), Running {
        pgid,
        signals_sent: 0,
        root: root.to_string_lossy().into_owned(),
        env: meta.and_then(|m| m.env),
    });

    let out_t = pump(app.clone(), id.clone(), "stdout", child.stdout.take().unwrap(), log.clone());
    let err_t = pump(app.clone(), id.clone(), "stderr", child.stderr.take().unwrap(), log.clone());

    let started = entry.clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        let _ = out_t.join();
        let _ = err_t.join();
        let cancelled = runs
            .running
            .lock()
            .unwrap()
            .remove(&entry.id)
            .map(|r| r.signals_sent > 0)
            .unwrap_or(false);
        entry.ended_at = Some(chrono::Local::now().to_rfc3339());
        entry.exit_code = status.ok().and_then(|s| s.code());
        entry.cancelled = cancelled;
        if let Ok(mut f) = log.lock() {
            let _ = writeln!(f, "\n[fim · código {:?}{}]", entry.exit_code, if cancelled { " · cancelada" } else { "" });
        }
        upsert_history(&app2, &runs, &entry);
        let _ = app2.emit("run-exit", entry);
    });

    Ok(started)
}

/// Primeiro SIGINT (o Ctrl-C, que deixa o Ansible terminar com elegância),
/// depois SIGTERM, depois SIGKILL — ao grupo inteiro.
pub fn cancel(runs: &Runs, id: &str) -> Result<String, String> {
    let mut running = runs.running.lock().unwrap();
    let r = running.get_mut(id).ok_or("esta corrida já terminou")?;
    let (sig, name) = match r.signals_sent {
        0 => (libc::SIGINT, "SIGINT"),
        1 => (libc::SIGTERM, "SIGTERM"),
        _ => (libc::SIGKILL, "SIGKILL"),
    };
    r.signals_sent += 1;
    let rc = unsafe { libc::killpg(r.pgid, sig) };
    if rc != 0 {
        return Err(format!("não foi possível enviar {name}"));
    }
    Ok(name.into())
}

pub fn active_count(runs: &Runs) -> usize {
    runs.running.lock().unwrap().len()
}

/// Ao sair à força: SIGTERM a todos os grupos. É o mesmo que fechar o
/// terminal a meio — por isso só acontece depois de confirmado.
pub fn terminate_all(runs: &Runs) {
    for r in runs.running.lock().unwrap().values() {
        unsafe { libc::killpg(r.pgid, libc::SIGTERM) };
    }
}

pub fn read_log<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<String, String> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("id inválido".into());
    }
    fs::read_to_string(data_dir(app)?.join("logs").join(format!("{id}.log"))).map_err(|e| e.to_string())
}

fn rand_suffix() -> u16 {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (n ^ std::process::id()) as u16
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Listener;

    /// Um projecto só com `localhost` e ligação local: nenhuma máquina é tocada.
    fn local_project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ansible-mario-run-{name}-{}", std::process::id()));
        fs::create_dir_all(dir.join("inventories")).unwrap();
        fs::write(dir.join("ansible.cfg"), "[defaults]\nretry_files_enabled = false\n").unwrap();
        fs::write(dir.join("inventories/local.ini"), "[local]\nlocalhost ansible_connection=local ansible_python_interpreter=auto_silent\n").unwrap();
        fs::write(
            dir.join("pb.yml"),
            "- hosts: local\n  gather_facts: false\n  tasks:\n    - ansible.builtin.debug: { msg: ola-mario }\n    - ansible.builtin.pause: { seconds: \"{{ wait | default(0) }}\" }\n",
        )
        .unwrap();
        dir
    }

    fn spec(wait: u32) -> RunSpec {
        RunSpec::Playbook {
            playbook: "pb.yml".into(),
            inventory: "inventories/local.ini".into(),
            extra_var_files: vec![],
            limit: String::new(),
            tags: String::new(),
            skip_tags: String::new(),
            check: false,
            diff: false,
            verbosity: 0,
            extra_args: format!("-e wait={wait}"),
        }
    }

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap()
    }

    #[test]
    fn streams_output_and_records_exit() {
        let app = app();
        let h = app.handle().clone();
        let (tx, rx) = mpsc::channel::<String>();
        let tx2 = tx.clone();
        h.listen_any("run-output", move |e| { let _ = tx.send(format!("out:{}", e.payload())); });
        h.listen_any("run-exit", move |e| { let _ = tx2.send(format!("exit:{}", e.payload())); });

        let root = local_project("ok");
        let runs = Arc::new(Runs::default());
        let entry = start(h.clone(), runs.clone(), &root, spec(0), None).expect("arranca");
        let mut saw_msg = false;
        let exit = loop {
            let m = rx.recv_timeout(Duration::from_secs(60)).expect("acaba em 60s");
            if m.contains("ola-mario") { saw_msg = true; }
            if let Some(x) = m.strip_prefix("exit:") { break x.to_string(); }
        };
        assert!(saw_msg, "o output do debug chegou como evento");
        let v: serde_json::Value = serde_json::from_str(&exit).unwrap();
        assert_eq!(v["exitCode"], 0, "{exit}");
        let log = read_log(&h, &entry.id).unwrap();
        assert!(log.contains("ola-mario") && log.contains("$ ansible-playbook pb.yml -i inventories/local.ini"));
        assert!(history(&h).iter().any(|e| e.id == entry.id && e.exit_code == Some(0)));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn cancel_interrupts_the_whole_group() {
        let app = app();
        let h = app.handle().clone();
        let (tx, rx) = mpsc::channel::<String>();
        let tx2 = tx.clone();
        h.listen_any("run-output", move |e| { let _ = tx.send(format!("out:{}", e.payload())); });
        h.listen_any("run-exit", move |e| { let _ = tx2.send(format!("exit:{}", e.payload())); });

        let root = local_project("cancel");
        let runs = Arc::new(Runs::default());
        let entry = start(h.clone(), runs.clone(), &root, spec(120), None).unwrap();
        // Espera pela pausa e cancela.
        loop {
            let m = rx.recv_timeout(Duration::from_secs(60)).unwrap();
            if m.contains("ola-mario") { break; }
        }
        std::thread::sleep(Duration::from_millis(800));
        let t0 = std::time::Instant::now();
        let mut sent = vec![cancel(&runs, &entry.id).unwrap()];
        let exit = loop {
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(m) => if let Some(x) = m.strip_prefix("exit:") { break x.to_string(); },
                Err(_) => sent.push(cancel(&runs, &entry.id).unwrap()),
            }
        };
        println!("sinais: {sent:?} · terminou em {:?}", t0.elapsed());
        let v: serde_json::Value = serde_json::from_str(&exit).unwrap();
        assert_eq!(v["cancelled"], true);
        assert!(t0.elapsed() < Duration::from_secs(20));
        assert!(cancel(&runs, &entry.id).is_err(), "já não está a correr");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn refuses_without_inventory() {
        let root = local_project("noinv");
        let mut s = spec(0);
        if let RunSpec::Playbook { inventory, .. } = &mut s { inventory.clear(); }
        assert!(build_argv(&root, &s).is_err());
        let mut bad = spec(0);
        if let RunSpec::Playbook { playbook, .. } = &mut bad { *playbook = "../../etc/passwd".into(); }
        assert!(build_argv(&root, &bad).is_err(), "fora do projecto");
        fs::remove_dir_all(root).ok();
    }
}
