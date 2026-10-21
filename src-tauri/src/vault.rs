//! Ficheiros cifrados com `ansible-vault`.
//!
//! O texto decifrado vive só em memória: lê-se com `ansible-vault view` e
//! volta a cifrar-se a partir do stdin. Nunca há um ficheiro em claro no
//! disco, nem temporário. A password é a do `vault_password_file` do
//! `ansible.cfg` do projecto — a app não a pede nem a guarda.

use crate::project::{is_vault_text, resolve};
use crate::shell;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;

pub fn view(root: &Path, file: &str) -> Result<String, String> {
    let abs = resolve(root, file)?;
    let head = fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    if !is_vault_text(&head) {
        return Err(format!("`{file}` não está cifrado"));
    }
    let out = shell::run("ansible-vault", &["view", file], root)?;
    if !out.ok {
        return Err(out.stderr.trim().to_string());
    }
    Ok(out.stdout)
}

/// `$ANSIBLE_VAULT;1.2;AES256;<label>` — o label do vault-id, se o houver,
/// tem de se manter ao voltar a cifrar.
fn vault_id_label(header: &str) -> Option<String> {
    let first = header.lines().next()?;
    let parts: Vec<&str> = first.split(';').collect();
    (parts.len() >= 4 && !parts[3].trim().is_empty()).then(|| parts[3].trim().to_string())
}

pub fn save(root: &Path, file: &str, plaintext: &str) -> Result<(), String> {
    let abs = resolve(root, file)?;
    let current = fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    if !is_vault_text(&current) {
        return Err(format!("`{file}` não está cifrado — grava-se pelo editor normal"));
    }
    // Cifra-se para um ficheiro ao lado e só depois se troca: se o
    // ansible-vault falhar a meio, o original fica intacto. O temporário
    // já sai cifrado.
    let tmp = abs.with_file_name(format!(
        ".{}.tillerdeck.tmp",
        abs.file_name().unwrap().to_string_lossy()
    ));
    let tmp_rel = tmp.strip_prefix(root.canonicalize().map_err(|e| e.to_string())?).unwrap().to_string_lossy().into_owned();
    let label = vault_id_label(&current);

    let mut args: Vec<String> = vec!["encrypt".into(), "--output".into(), tmp_rel.clone()];
    if let Some(l) = &label {
        args.push("--encrypt-vault-id".into());
        args.push(l.clone());
    }
    args.push("-".into());

    let mut child = shell::command("ansible-vault", root)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("não foi possível correr `ansible-vault`: {e}"))?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(plaintext.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let _ = fs::remove_file(&tmp);
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let written = fs::read_to_string(&tmp).unwrap_or_default();
    if !is_vault_text(&written) {
        let _ = fs::remove_file(&tmp);
        return Err("o ansible-vault não produziu um ficheiro cifrado — nada foi gravado".into());
    }
    fs::rename(&tmp, &abs).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn view_real_vault_in_memory() {
        let Ok(roots) = std::env::var("TILLERDECK_FIXTURES") else { return };
        for root in roots.split(':') {
            let root = std::path::Path::new(root);
            let text = super::view(root, "inventories/group_vars/all/vault.yml");
            // Nunca se imprime o conteúdo — só que decifrou.
            println!("{}: vault decifrado = {}", root.display(), text.as_ref().map(|t| !t.is_empty()).unwrap_or(false));
            if let Err(e) = text { println!("  erro: {e}"); }
        }
    }

    #[test]
    fn save_roundtrip_keeps_file_encrypted() {
        let dir = std::env::temp_dir().join(format!("tillerdeck-vault-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ansible.cfg"), "[defaults]\nvault_password_file = .vault_pass\n").unwrap();
        std::fs::write(dir.join(".vault_pass"), "teste\n").unwrap();
        std::fs::write(dir.join("v.yml"), "# comentário\nsegredo: 1\n").unwrap();
        let enc = crate::shell::run("ansible-vault", &["encrypt", "v.yml"], &dir).unwrap();
        assert!(enc.ok, "{}", enc.stderr);

        assert_eq!(super::view(&dir, "v.yml").unwrap(), "# comentário\nsegredo: 1\n");
        super::save(&dir, "v.yml", "# comentário\nsegredo: 2\n").unwrap();
        let raw = std::fs::read_to_string(dir.join("v.yml")).unwrap();
        assert!(raw.starts_with("$ANSIBLE_VAULT;"));
        assert!(!raw.contains("segredo"));
        assert_eq!(super::view(&dir, "v.yml").unwrap(), "# comentário\nsegredo: 2\n");
        // Sem restos do temporário.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 3);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
