//! Arranque dos comandos externos (ansible-*, make).
//!
//! Uma app lançada do Finder não herda o PATH do zsh: o `ansible` em
//! `~/.local/bin` e o que está em `/opt/homebrew/bin` simplesmente não
//! existem para ela. Por isso o PATH lê-se UMA vez da shell de login do
//! utilizador e passa-se a todos os comandos.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

static LOGIN_PATH: OnceLock<String> = OnceLock::new();

fn fallback_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    [
        format!("{home}/.local/bin"),
        "/opt/homebrew/bin".into(),
        "/opt/homebrew/sbin".into(),
        "/usr/local/bin".into(),
        "/usr/bin".into(),
        "/bin".into(),
        "/usr/sbin".into(),
        "/sbin".into(),
    ]
    .join(":")
}

pub fn login_path() -> &'static str {
    LOGIN_PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        // -i -l: carrega .zprofile E .zshrc, que é onde o PATH costuma ser
        // composto. O marcador separa o PATH do que a shell imprima ao abrir.
        // Com prazo: um .zshrc que pergunte alguma coisa não pode pendurar a app.
        let found = Command::new(&shell)
            .args(["-ilc", "printf '__PATH__%s__PATH__' \"$PATH\""])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()
            .and_then(|mut child| {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) => break,
                        Ok(None) if std::time::Instant::now() < deadline => {
                            std::thread::sleep(std::time::Duration::from_millis(30))
                        }
                        _ => {
                            let _ = child.kill();
                            return None;
                        }
                    }
                }
                child.wait_with_output().ok()
            })
            .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).to_string();
            let start = s.find("__PATH__")? + 8;
            let end = s[start..].find("__PATH__")? + start;
            Some(s[start..end].to_string())
        });
        match found {
            Some(p) if !p.is_empty() => format!("{p}:{}", fallback_path()),
            _ => fallback_path(),
        }
    })
}

/// Um comando pronto a correr na raiz do projecto, com o PATH certo e sem
/// stdin: nada do que se corre aqui pode ficar à espera de uma resposta que
/// ninguém vai dar.
pub fn command(program: &str, cwd: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.current_dir(cwd)
        .env("PATH", login_path())
        .env("ANSIBLE_NOCOLOR", "1")
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null());
    cmd
}

pub struct Output {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

pub fn run(program: &str, args: &[&str], cwd: &Path) -> Result<Output, String> {
    let out = command(program, cwd)
        .args(args)
        .output()
        .map_err(|e| format!("não foi possível correr `{program}`: {e}"))?;
    Ok(Output {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Onde está cada ferramenta, para o ecrã de diagnóstico.
pub fn which(program: &str) -> Option<String> {
    std::env::split_paths(login_path())
        .map(|d| d.join(program))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    /// Corre com `env -i` (ver README): é o ambiente de uma app aberta no Finder.
    #[test]
    fn finds_tools_from_login_shell() {
        println!("PATH herdado: {:?}", std::env::var("PATH").ok());
        for t in ["ansible-playbook", "ansible-vault", "make"] {
            let found = super::which(t);
            println!("{t}: {found:?}");
            assert!(found.is_some(), "{t} não encontrado com o PATH da shell de login");
        }
    }
}
