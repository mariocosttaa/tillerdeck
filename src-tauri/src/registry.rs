//! Perguntar a um registry Docker que tags existem para uma imagem.
//!
//! Serve a promoção das apps cuja tag traz o ambiente (`-staging-`): a tag
//! de produção do MESMO commit não se deduz, procura-se. As credenciais são
//! as do `docker login` — do `~/.docker/config.json` ou, no macOS, do
//! Keychain através do `docker-credential-osxkeychain`. Nunca se escrevem
//! em log nem saem desta função.

use crate::shell;
use base64::Engine;
use serde::Serialize;
use std::io::Write;
use std::process::Stdio;

fn host_of(url: &str) -> String {
    url.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/').to_string()
}

fn docker_config() -> Option<serde_json::Value> {
    let home = std::env::var("HOME").ok()?;
    let text = std::fs::read_to_string(format!("{home}/.docker/config.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// (utilizador, segredo) para este registry, se o docker login o souber.
fn credentials(host: &str) -> Option<(String, String)> {
    let cfg = docker_config()?;
    let keys = [host.to_string(), format!("https://{host}")];

    // 1. auth em claro (base64) no próprio config.json
    for k in &keys {
        if let Some(auth) = cfg.pointer(&format!("/auths/{}", k.replace('/', "~1"))).and_then(|a| a.get("auth")).and_then(|a| a.as_str()) {
            if let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(auth) {
                if let Some((u, p)) = String::from_utf8_lossy(&raw).split_once(':') {
                    return Some((u.to_string(), p.to_string()));
                }
            }
        }
    }
    // 2. um ajudante: credHelpers[host] ou credsStore
    let helper = keys
        .iter()
        .find_map(|k| cfg.pointer(&format!("/credHelpers/{}", k.replace('/', "~1"))).and_then(|v| v.as_str()))
        .or_else(|| cfg.get("credsStore").and_then(|v| v.as_str()))?
        .to_string();
    for k in &keys {
        let mut child = shell::command(&format!("docker-credential-{helper}"), std::path::Path::new("/"))
            .arg("get")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        child.stdin.take()?.write_all(k.as_bytes()).ok()?;
        let out = child.wait_with_output().ok()?;
        if out.status.success() {
            let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
            let u = v.get("Username")?.as_str()?.to_string();
            let s = v.get("Secret")?.as_str()?.to_string();
            return Some((u, s));
        }
    }
    None
}

fn basic(creds: &(String, String)) -> String {
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", creds.0, creds.1)))
}

/// `Bearer realm="…",service="…",scope="…"` → o token, pedido com as credenciais.
fn bearer_token(challenge: &str, creds: Option<&(String, String)>) -> Result<String, String> {
    let params: std::collections::HashMap<String, String> = challenge
        .trim_start_matches("Bearer ")
        .split(',')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().trim_matches('"').to_string()))
        .collect();
    let realm = params.get("realm").ok_or("o registry pediu um token sem realm")?;
    let mut req = ureq::get(realm);
    for k in ["service", "scope"] {
        if let Some(v) = params.get(k) {
            req = req.query(k, v);
        }
    }
    if let Some(c) = creds {
        req = req.set("Authorization", &basic(c));
    }
    let v: serde_json::Value = req.call().map_err(|e| format!("token do registry: {e}"))?.into_json().map_err(|e| e.to_string())?;
    v.get("token").or_else(|| v.get("access_token")).and_then(|t| t.as_str()).map(String::from).ok_or_else(|| "o registry não devolveu token".into())
}

fn next_link(resp: &ureq::Response, base: &str) -> Option<String> {
    let link = resp.header("Link")?;
    let start = link.find('<')? + 1;
    let end = link.find('>')?;
    let path = &link[start..end];
    Some(if path.starts_with("http") { path.to_string() } else { format!("{}{}", base.trim_end_matches('/'), path) })
}

pub fn list_tags(url: &str, image: &str) -> Result<Vec<String>, String> {
    let host = host_of(url);
    let base = format!("https://{host}");
    let creds = credentials(&host);
    let mut auth: Option<String> = None;
    let mut next = Some(format!("{base}/v2/{image}/tags/list?n=1000"));
    let mut tags = Vec::new();
    let mut tried_auth = false;

    while let Some(u) = next.take() {
        let mut req = ureq::get(&u).timeout(std::time::Duration::from_secs(15));
        if let Some(a) = &auth {
            req = req.set("Authorization", a);
        }
        match req.call() {
            Ok(resp) => {
                next = next_link(&resp, &base);
                let v: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
                tags.extend(v.get("tags").and_then(|t| t.as_array()).into_iter().flatten().filter_map(|t| t.as_str().map(String::from)));
            }
            Err(ureq::Error::Status(401, resp)) if !tried_auth => {
                tried_auth = true;
                let challenge = resp.header("WWW-Authenticate").unwrap_or("Basic").to_string();
                auth = Some(if challenge.starts_with("Bearer") {
                    format!("Bearer {}", bearer_token(&challenge, creds.as_ref())?)
                } else {
                    basic(creds.as_ref().ok_or_else(|| format!("sem credenciais para {host} — faz `docker login {host}`"))?)
                });
                next = Some(u);
            }
            Err(ureq::Error::Status(401, _)) => return Err(format!("o registry {host} recusou as credenciais do docker login")),
            Err(ureq::Error::Status(404, _)) => return Err(format!("a imagem {image} não existe em {host}")),
            Err(e) => return Err(format!("{host}: {e}")),
        }
    }
    Ok(tags)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    /// O prefixo procurado: `1.17.0-production-4be19d2-`
    pub prefix: String,
    pub candidates: Vec<String>,
}

/// A tag de `to` com a mesma versão e o mesmo commit que `from_tag`.
/// `1.17.0-staging-4be19d2-0a41dcef` → procura `1.17.0-production-4be19d2-*`.
pub fn match_env_tag(tags: &[String], from_tag: &str, from_env: &str, to_env: &str) -> Option<Match> {
    let needle = format!("-{from_env}-");
    let i = from_tag.find(&needle)?;
    let version = &from_tag[..i];
    let after = &from_tag[i + needle.len()..];
    let commit = after.split('-').next()?;
    let prefix = format!("{version}-{to_env}-{commit}-");
    let mut candidates: Vec<String> = tags.iter().filter(|t| t.starts_with(&prefix)).cloned().collect();
    candidates.sort();
    Some(Match { prefix, candidates })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_production_tag_of_the_same_commit() {
        let tags: Vec<String> = [
            "1.17.0-staging-4be19d2-0a41dcef",
            "1.17.0-production-4be19d2-91c04e2b",
            "1.17.0-production-0000000-aaaaaaaa",
            "1.16.2-production-c007238-0ea6a682",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let m = match_env_tag(&tags, "1.17.0-staging-4be19d2-0a41dcef", "staging", "production").unwrap();
        assert_eq!(m.prefix, "1.17.0-production-4be19d2-");
        assert_eq!(m.candidates, vec!["1.17.0-production-4be19d2-91c04e2b"]);
        assert!(match_env_tag(&tags, "1.21.0-8f3a2c1-c2e5b81f", "staging", "production").is_none(), "tag sem ambiente");
    }

    #[test]
    fn host_parsing() {
        assert_eq!(host_of("https://docker-registry.solo-test.site/"), "docker-registry.solo-test.site");
    }
}
