//! Os `releases/<env>.yml`: o registo do que está instalado em cada ambiente.
//!
//! São ficheiros com mais comentários do que valores, e os comentários
//! mencionam tags. Por isso só se lê e escreve a linha `chave: valor` que
//! começa na coluna 0 — nunca um parse+dump, nunca uma substituição solta.

use crate::project::resolve;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

fn parse_line(line: &str) -> Option<(String, String, String)> {
    let first = line.chars().next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    let (key, rest) = line.split_once(':')?;
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    // valor até um ` #` (comentário no fim da linha), sem aspas
    // o comentário leva consigo os espaços que o separam do valor
    let (value, comment) = match rest.find(" #") {
        Some(i) => {
            let start = rest[..=i].trim_end().len();
            (&rest[..start], rest[start..].to_string())
        }
        None => (rest, String::new()),
    };
    let v = value.trim().trim_matches('"').trim_matches('\'').to_string();
    Some((key.to_string(), v, comment))
}

/// As chaves de um release a partir do texto (por exemplo de outra branch).
pub fn parse(text: &str) -> BTreeMap<String, String> {
    text.lines().filter_map(parse_line).map(|(k, v, _)| (k, v)).collect()
}

pub fn read(root: &Path, rel: &str) -> Result<BTreeMap<String, String>, String> {
    let text = fs::read_to_string(resolve(root, rel)?).map_err(|e| format!("{rel}: {e}"))?;
    Ok(text.lines().filter_map(parse_line).map(|(k, v, _)| (k, v)).collect())
}

/// Troca, num texto YAML, o valor de UMA chave de topo. Devolve o texto novo
/// e o valor anterior. Falha se a chave não aparecer exactamente uma vez.
pub fn replace_in_text(text: &str, key: &str, value: &str) -> Result<(String, String), String> {
    if value.contains('\n') {
        return Err("valor inválido".into());
    }
    let mut old = None;
    let mut hits = 0;
    let mut out = String::with_capacity(text.len() + 16);
    for line in text.split_inclusive('\n') {
        let body = line.trim_end_matches(['\n', '\r']);
        match parse_line(body) {
            Some((k, v, comment)) if k == key => {
                hits += 1;
                old = Some(v);
                out.push_str(&format!("{key}: {value}{comment}"));
                out.push_str(&line[body.len()..]);
            }
            _ => out.push_str(line),
        }
    }
    if hits != 1 {
        return Err(format!("`{key}` aparece {hits} vezes — esperava uma"));
    }
    Ok((out, old.unwrap_or_default()))
}

/// Troca o valor de UMA chave e devolve o anterior. Escreve num temporário
/// e renomeia; depois relê e confirma que só essa chave mudou.
pub fn set(root: &Path, rel: &str, key: &str, value: &str) -> Result<String, String> {
    if value.trim().is_empty() {
        return Err("valor inválido".into());
    }
    let path = resolve(root, rel)?;
    let text = fs::read_to_string(&path).map_err(|e| format!("{rel}: {e}"))?;
    if text.starts_with("$ANSIBLE_VAULT;") {
        return Err(format!("{rel} está cifrado — usa o vault"));
    }
    let before = read(root, rel)?;
    let (out, old) = replace_in_text(&text, key, value).map_err(|e| format!("{rel}: {e}"))?;

    let tmp = path.with_file_name(format!(".{}.tillerdeck.tmp", path.file_name().unwrap().to_string_lossy()));
    fs::write(&tmp, &out).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;

    let after = read(root, rel)?;
    let mut expected = before.clone();
    expected.insert(key.to_string(), value.trim_matches('"').to_string());
    if after != expected {
        // Não devia acontecer; se acontecer, repõe o original.
        let _ = fs::write(&path, &text);
        return Err(format!("a escrita de {rel} mudou mais do que `{key}` — reposto o original"));
    }
    Ok(old)
}

/// Como se mostra uma versão: `1.21.0-8f3a2c1-…` → `1.21.0`; um SHA → 7 chars.
pub fn short(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 12 && v.chars().all(|c| c.is_ascii_hexdigit()) {
        return v[..7].to_string();
    }
    // as tags `dev-` (construídas fora da CI) mantêm o prefixo à vista
    if let Some(rest) = v.strip_prefix("dev-") {
        return format!("dev-{}", rest.split('-').next().unwrap_or(rest));
    }
    v.split('-').next().unwrap_or(v).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\n# api_tag: 0.0.1 num comentário — não se toca\n# --- shop ---\napi_tag: 1.20.0-124d06b-c2e5b81f\nworker_tag: \"1.3.1-2916c27-500c2fe7\"  # nota\napp_tag: 1.16.2-production-c007238-0ea6a682\n";

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("am-rel-{}-{:?}", std::process::id(), std::thread::current().id()));
        fs::create_dir_all(d.join("releases")).unwrap();
        fs::write(d.join("releases/production.yml"), SAMPLE).unwrap();
        d
    }

    #[test]
    fn reads_only_top_level_keys() {
        let d = tmp();
        let r = read(&d, "releases/production.yml").unwrap();
        assert_eq!(r.len(), 3);
        assert_eq!(r["worker_tag"], "1.3.1-2916c27-500c2fe7");
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn set_changes_one_line_and_keeps_comments() {
        let d = tmp();
        let old = set(&d, "releases/production.yml", "api_tag", "1.21.0-8f3a2c1-c2e5b81f").unwrap();
        assert_eq!(old, "1.20.0-124d06b-c2e5b81f");
        let text = fs::read_to_string(d.join("releases/production.yml")).unwrap();
        assert!(text.contains("# api_tag: 0.0.1 num comentário"), "o comentário ficou");
        assert!(text.contains("api_tag: 1.21.0-8f3a2c1-c2e5b81f\n"));
        set(&d, "releases/production.yml", "worker_tag", "1.3.2-77ab9e0-500c2fe7").unwrap();
        let text = fs::read_to_string(d.join("releases/production.yml")).unwrap();
        assert!(text.contains("worker_tag: 1.3.2-77ab9e0-500c2fe7  # nota"), "o comentário no fim da linha ficou");
        assert_eq!(text.lines().count(), SAMPLE.lines().count());
        assert!(set(&d, "releases/production.yml", "nope_tag", "x").is_err());
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn short_versions() {
        assert_eq!(short("1.21.0-8f3a2c1-c2e5b81f"), "1.21.0");
        assert_eq!(short("75c1600d1b281b7ebaa600d3744275b45f6c74db"), "75c1600");
        assert_eq!(short("dev-1.16.0-cf24f14-c2e5b81f"), "dev-1.16.0");
    }
}
