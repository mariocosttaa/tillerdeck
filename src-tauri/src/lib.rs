mod manifest;
mod ops;
mod project;
mod registry;
mod releases;
mod template;
mod runner;
mod shell;
mod vault;

use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

type Runs = Arc<runner::Runs>;

fn root_path(root: &str) -> PathBuf {
    PathBuf::from(root)
}

#[tauri::command]
fn open_project(path: String) -> project::Project {
    project::scan(&root_path(&path))
}

#[tauri::command]
fn read_file(root: String, path: String) -> Result<String, String> {
    let abs = project::resolve(&root_path(&root), &path)?;
    let bytes = fs::read(&abs).map_err(|e| e.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("ficheiro demasiado grande para o editor (> 4 MB)".into());
    }
    String::from_utf8(bytes).map_err(|_| "ficheiro binário — não abre no editor".into())
}

#[tauri::command]
fn write_file(root: String, path: String, content: String) -> Result<(), String> {
    let abs = project::resolve(&root_path(&root), &path)?;
    // Gravar texto por cima de um vault estragava-o sem aviso. Esses
    // gravam-se pelo `vault_save`, que volta a cifrar.
    if let Ok(cur) = fs::read_to_string(&abs) {
        if project::is_vault_text(&cur) {
            return Err("este ficheiro está cifrado — grava-se pelo vault".into());
        }
    }
    fs::write(&abs, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn config_dump(root: String) -> Result<serde_json::Value, String> {
    project::config_dump(&root_path(&root))
}

#[tauri::command]
fn make_targets(root: String) -> Vec<project::MakeTarget> {
    project::make_targets(&root_path(&root))
}

#[tauri::command]
async fn inventory(root: String, inventory: String) -> Result<Vec<project::InventoryGroup>, String> {
    tauri::async_runtime::spawn_blocking(move || project::inventory(&root_path(&root), &inventory))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn syntax_check(root: String, playbook: String, inventory: Option<String>) -> Result<project::CheckResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project::syntax_check(&root_path(&root), &playbook, inventory.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn lint(root: String, path: String) -> Result<Vec<project::LintIssue>, String> {
    tauri::async_runtime::spawn_blocking(move || project::lint(&root_path(&root), &path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn vault_view(root: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || vault::view(&root_path(&root), &path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn vault_save(root: String, path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || vault::save(&root_path(&root), &path, &content))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn run_start(app: AppHandle, runs: State<Runs>, root: String, spec: runner::RunSpec, meta: Option<runner::RunMeta>) -> Result<runner::HistoryEntry, String> {
    runner::start(app, runs.inner().clone(), &root_path(&root), spec, meta)
}

// ---------------------------------------------------------------------------
// v2: manifesto, templates, releases, registry
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectState {
    manifest: Option<manifest::Manifest>,
    /// O manifesto existe mas não se leu (JSON inválido).
    manifest_error: Option<String>,
    problems: Vec<manifest::Problem>,
    /// Os alvos que existem no Makefile — um botão sem alvo fica desligado.
    targets: Vec<String>,
    /// env → (chave → valor) de cada releases/<env>.yml
    releases: std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>,
    git: ops::GitInfo,
    callbacks: Vec<String>,
}

#[tauri::command]
async fn project_state(root: String) -> Result<ProjectState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = root_path(&root);
        let targets: std::collections::BTreeSet<String> = project::make_targets(&r).into_iter().map(|t| t.name).collect();
        let (manifest, manifest_error) = match manifest::load(&r) {
            Ok(m) => (m, None),
            Err(e) => (None, Some(e)),
        };
        let problems = manifest.as_ref().map(|m| manifest::validate(&r, m, &targets)).unwrap_or_default();
        let releases = manifest
            .as_ref()
            .map(|m| {
                m.environments
                    .iter()
                    .filter_map(|e| e.release.as_ref().map(|rel| (e.id.clone(), releases::read(&r, rel).unwrap_or_default())))
                    .collect()
            })
            .unwrap_or_default();
        let callbacks = project::config_dump(&r)
            .ok()
            .and_then(|v| v.as_array().cloned())
            .and_then(|a| a.into_iter().find(|c| c.get("name").and_then(|n| n.as_str()) == Some("CALLBACKS_ENABLED")))
            .and_then(|c| c.get("value").and_then(|v| v.as_array()).cloned())
            .map(|a| a.into_iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        Ok(ProjectState { manifest, manifest_error, problems, targets: targets.into_iter().collect(), releases, git: ops::git_info(&r), callbacks })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn template_report(root: String, template: String) -> Result<template::Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = root_path(&root);
        match template.as_str() {
            "makefile-convention" => Ok(template::makefile_convention(&r)),
            "playbooks" => Ok(template::playbooks_only(&r)),
            other => Err(format!("template desconhecido: {other}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn manifest_save(root: String, manifest: manifest::Manifest) -> Result<(), String> {
    manifest::save(&root_path(&root), &manifest)
}

#[tauri::command]
fn release_set(root: String, release: String, key: String, value: String) -> Result<String, String> {
    releases::set(&root_path(&root), &release, &key, &value)
}

#[tauri::command]
async fn release_history(root: String, release: String, key: String) -> Result<Vec<ops::Revision>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::history(&root_path(&root), &release, &key))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn release_commit(root: String, release: String, message: String) -> Result<String, String> {
    ops::commit_file(&root_path(&root), &release, &message)
}

#[tauri::command]
async fn maintenance_state(root: String, inventory: String) -> Result<std::collections::BTreeMap<String, bool>, String> {
    tauri::async_runtime::spawn_blocking(move || ops::maintenance(&root_path(&root), &inventory))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn registry_match(url: String, image: String, from_tag: String, from: String, to: String) -> Result<Option<registry::Match>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tags = registry::list_tags(&url, &image)?;
        Ok(registry::match_env_tag(&tags, &from_tag, &from, &to))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn run_cancel(runs: State<Runs>, id: String) -> Result<String, String> {
    runner::cancel(&runs, &id)
}

#[tauri::command]
fn run_history(app: AppHandle) -> Vec<runner::HistoryEntry> {
    runner::history(&app)
}

#[tauri::command]
fn run_log(app: AppHandle, id: String) -> Result<String, String> {
    runner::read_log(&app, &id)
}

/// O projecto passado na linha de comandos: `ansible-mario ~/infra` ou
/// `open -a "Ansible Mario" --args ~/infra`.
#[tauri::command]
fn initial_project() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .map(PathBuf::from)
        .and_then(|p| p.canonicalize().ok())
        .filter(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Tool {
    name: &'static str,
    path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Environment {
    path: String,
    tools: Vec<Tool>,
    ansible_version: Option<String>,
}

#[tauri::command]
async fn environment() -> Environment {
    tauri::async_runtime::spawn_blocking(|| {
        let tools = ["ansible", "ansible-playbook", "ansible-inventory", "ansible-vault", "ansible-config", "ansible-lint", "make"]
            .into_iter()
            .map(|name| Tool { name, path: shell::which(name) })
            .collect();
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        let ansible_version = shell::run("ansible", &["--version"], std::path::Path::new(&home))
            .ok()
            .filter(|o| o.ok)
            .and_then(|o| o.stdout.lines().next().map(String::from));
        Environment { path: shell::login_path().to_string(), tools, ansible_version }
    })
    .await
    .unwrap()
}

/// O que impede fechar a app sem perguntar: separadores por gravar (diz a
/// interface) e corridas activas (sabe o backend).
#[derive(Default)]
struct Guard {
    dirty: AtomicBool,
    quitting: AtomicBool,
}

#[tauri::command]
fn set_dirty(guard: State<Arc<Guard>>, dirty: bool) {
    guard.dirty.store(dirty, Ordering::Relaxed);
}

#[tauri::command]
fn force_quit(app: AppHandle, guard: State<Arc<Guard>>, runs: State<Runs>) {
    guard.quitting.store(true, Ordering::Relaxed);
    runner::terminate_all(&runs);
    app.exit(0);
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct QuitBlocked {
    running: usize,
    dirty: bool,
}

/// Sair a meio de um deploy fecha os pipes do ansible-playbook e ele morre
/// com SIGPIPE a meio de uma task, com a máquina em qualquer estado. Por isso
/// fechar a janela ou ⌘Q com trabalho em curso passa por uma confirmação.
fn should_block(app: &AppHandle) -> bool {
    let guard = app.state::<Arc<Guard>>();
    if guard.quitting.load(Ordering::Relaxed) {
        return false;
    }
    let running = runner::active_count(&app.state::<Runs>());
    let dirty = guard.dirty.load(Ordering::Relaxed);
    if running == 0 && !dirty {
        return false;
    }
    let _ = app.emit("quit-blocked", QuitBlocked { running, dirty });
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Runs::default())
        .manage(Arc::new(Guard::default()))
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if should_block(window.app_handle()) {
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_project,
            read_file,
            write_file,
            config_dump,
            make_targets,
            inventory,
            syntax_check,
            lint,
            vault_view,
            vault_save,
            run_start,
            run_cancel,
            run_history,
            run_log,
            environment,
            initial_project,
            set_dirty,
            force_quit,
            project_state,
            template_report,
            manifest_save,
            release_set,
            release_history,
            release_commit,
            maintenance_state,
            registry_match,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, .. } = event {
                if should_block(app) {
                    api.prevent_exit();
                }
            }
        });
}
