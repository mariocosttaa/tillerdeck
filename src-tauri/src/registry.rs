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

/// Uma ligação a um registry, com a autenticação que ele pedir (Basic ou
/// Bearer) obtida uma vez e reutilizada. Num redirect para outro host (um
/// blob servido por S3 ou CDN) o cabeçalho de autorização não segue.
struct Client {
    agent: ureq::Agent,
    host: String,
    base: String,
    creds: Option<(String, String)>,
    auth: Option<String>,
}

impl Client {
    fn new(url: &str) -> Client {
        let host = host_of(url);
        Client {
            agent: ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(15))
                .redirect_auth_headers(ureq::RedirectAuthHeaders::SameHost)
                .build(),
            base: format!("https://{host}"),
            creds: credentials(&host),
            host,
            auth: None,
        }
    }

    fn get(&mut self, url: &str, accept: Option<&str>, image: &str) -> Result<ureq::Response, String> {
        let mut tried = false;
        loop {
            let mut req = self.agent.get(url);
            if let Some(a) = accept {
                req = req.set("Accept", a);
            }
            if let Some(a) = &self.auth {
                req = req.set("Authorization", a);
            }
            match req.call() {
                Ok(resp) => return Ok(resp),
                Err(ureq::Error::Status(401, resp)) if !tried => {
                    tried = true;
                    let challenge = resp.header("WWW-Authenticate").unwrap_or("Basic").to_string();
                    self.auth = Some(if challenge.starts_with("Bearer") {
                        format!("Bearer {}", bearer_token(&challenge, self.creds.as_ref())?)
                    } else {
                        basic(self.creds.as_ref().ok_or_else(|| format!("sem credenciais para {} — faz `docker login {}`", self.host, self.host))?)
                    });
                }
                Err(ureq::Error::Status(401, _)) => return Err(format!("o registry {} recusou as credenciais do docker login", self.host)),
                Err(ureq::Error::Status(404, _)) => return Err(format!("a imagem {image} não existe em {}", self.host)),
                Err(e) => return Err(format!("{}: {e}", self.host)),
            }
        }
    }
}

fn tags_with(c: &mut Client, image: &str) -> Result<Vec<String>, String> {
    let mut next = Some(format!("{}/v2/{image}/tags/list?n=1000", c.base));
    let mut tags = Vec::new();
    while let Some(u) = next.take() {
        let resp = c.get(&u, None, image)?;
        next = next_link(&resp, &c.base);
        let v: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
        tags.extend(v.get("tags").and_then(|t| t.as_array()).into_iter().flatten().filter_map(|t| t.as_str().map(String::from)));
    }
    Ok(tags)
}

pub fn list_tags(url: &str, image: &str) -> Result<Vec<String>, String> {
    tags_with(&mut Client::new(url), image)
}

const MANIFEST_TYPES: &str = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json";

/// O que se sabe de uma imagem: o que a tag diz (pelo formato configurado)
/// e o que a própria imagem declara (data e etiquetas OCI). As etiquetas
/// mandam sobre a tag quando as duas existem.
#[derive(Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Build {
    pub tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// `{version}-{env}-{commit}-{build}` aplicado a `1.17.0-staging-4be19d2-0a41dcef`.
/// Cada `{campo}` apanha o que houver até ao separador seguinte; um formato
/// que não bate devolve `None`.
pub fn parse_tag(format: &str, tag: &str) -> Option<std::collections::BTreeMap<String, String>> {
    let mut out = std::collections::BTreeMap::new();
    let mut rest = tag;
    let mut fmt = format;
    while !fmt.is_empty() {
        if let Some(stripped) = fmt.strip_prefix('{') {
            let close = stripped.find('}')?;
            let name = &stripped[..close];
            fmt = &stripped[close + 1..];
            // o literal que vem a seguir decide onde o campo acaba
            let lit_end = fmt.find('{').unwrap_or(fmt.len());
            let lit = &fmt[..lit_end];
            let value = if lit.is_empty() {
                if fmt.is_empty() { rest } else { return None }
            } else if name == "version" {
                // a versão pode ter `-` (1.2.0-rc.1): conta os separadores que o resto do formato precisa
                let need = fmt.matches(lit).count().max(1);
                let idx: Vec<usize> = rest.match_indices(lit).map(|(i, _)| i).collect();
                if idx.len() < need { return None; }
                &rest[..idx[idx.len() - need]]
            } else {
                &rest[..rest.find(lit)?]
            };
            if value.is_empty() { return None; }
            out.insert(name.to_string(), value.to_string());
            rest = &rest[value.len()..];
        } else {
            let lit_end = fmt.find('{').unwrap_or(fmt.len());
            rest = rest.strip_prefix(&fmt[..lit_end])?;
            fmt = &fmt[lit_end..];
        }
    }
    rest.is_empty().then_some(out)
}

fn version_key(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_digit()).filter(|x| !x.is_empty()).take(4).map(|x| x.parse().unwrap_or(0)).collect()
}

/// Lê data, tamanho e etiquetas de uma tag: manifesto (ou índice, de onde
/// se escolhe linux/amd64) e depois o blob de configuração.
fn inspect(c: &mut Client, image: &str, tag: &str) -> Result<Build, String> {
    let resp = c.get(&format!("{}/v2/{image}/manifests/{tag}", c.base), Some(MANIFEST_TYPES), image)?;
    let digest = resp.header("Docker-Content-Digest").map(String::from);
    let mut m: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    if let Some(list) = m.get("manifests").and_then(|x| x.as_array()).cloned() {
        let pick = list
            .iter()
            .find(|e| e.pointer("/platform/os").and_then(|x| x.as_str()) == Some("linux") && e.pointer("/platform/architecture").and_then(|x| x.as_str()) == Some("amd64"))
            .or_else(|| list.iter().find(|e| e.pointer("/platform/os").and_then(|x| x.as_str()) != Some("unknown")))
            .ok_or("índice sem manifestos")?;
        let d = pick.get("digest").and_then(|x| x.as_str()).ok_or("índice sem digest")?;
        m = c.get(&format!("{}/v2/{image}/manifests/{d}", c.base), Some(MANIFEST_TYPES), image)?.into_json().map_err(|e| e.to_string())?;
    }
    let size = m.get("layers").and_then(|l| l.as_array()).map(|l| l.iter().filter_map(|x| x.get("size").and_then(|s| s.as_u64())).sum());
    let mut b = Build { tag: tag.to_string(), digest, size, ..Default::default() };
    if let Some(cfg) = m.pointer("/config/digest").and_then(|x| x.as_str()) {
        let v: serde_json::Value = c.get(&format!("{}/v2/{image}/blobs/{cfg}", c.base), None, image)?.into_json().map_err(|e| e.to_string())?;
        b.created = v.get("created").and_then(|x| x.as_str()).map(String::from);
        let labels = v.pointer("/config/Labels");
        let label = |k: &str| labels.and_then(|l| l.get(k)).and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(String::from);
        b.version = label("org.opencontainers.image.version");
        b.commit = label("org.opencontainers.image.revision");
    }
    Ok(b)
}

/// As builds mais recentes de uma imagem. Os metadados de cada tag guardam-se
/// em `cache` (uma tag não muda), por isso só as tags novas custam pedidos.
pub fn builds(url: &str, image: &str, format: Option<&str>, env: Option<&str>, limit: usize, cache: &std::path::Path) -> Result<Vec<Build>, String> {
    let mut c = Client::new(url);
    let tags = tags_with(&mut c, image)?;
    let mut known: std::collections::BTreeMap<String, Build> =
        std::fs::read_to_string(cache).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let prefix = format!("{}/{image}:", c.host);

    // filtrar pelo formato (e pelo ambiente, quando a tag o traz) e ordenar pela versão
    let mut cands: Vec<(String, std::collections::BTreeMap<String, String>)> = tags
        .into_iter()
        .filter(|t| t != "latest")
        .filter_map(|t| {
            let parts = match format {
                Some(f) => parse_tag(f, &t)?,
                None => Default::default(),
            };
            if let (Some(e), Some(te)) = (env, parts.get("env")) {
                if e != te { return None; }
            }
            Some((t, parts))
        })
        .collect();
    cands.sort_by(|a, b| version_key(b.1.get("version").unwrap_or(&b.0)).cmp(&version_key(a.1.get("version").unwrap_or(&a.0))).then(b.0.cmp(&a.0)));
    cands.truncate(limit * 2);

    let mut out = Vec::new();
    let mut changed = false;
    for (tag, parts) in cands {
        let key = format!("{prefix}{tag}");
        let mut b = match known.get(&key) {
            Some(b) => b.clone(),
            None => match inspect(&mut c, image, &tag) {
                Ok(b) => {
                    known.insert(key, b.clone());
                    changed = true;
                    b
                }
                Err(_) => Build { tag: tag.clone(), ..Default::default() },
            },
        };
        if b.version.is_none() { b.version = parts.get("version").cloned(); }
        if b.commit.is_none() { b.commit = parts.get("commit").cloned(); }
        b.env = parts.get("env").cloned();
        out.push(b);
    }
    if changed {
        if let Some(d) = cache.parent() { let _ = std::fs::create_dir_all(d); }
        let _ = std::fs::write(cache, serde_json::to_string(&known).unwrap_or_default());
    }
    out.sort_by(|a, b| b.created.cmp(&a.created));
    out.truncate(limit);
    Ok(out)
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
    fn parses_tags_by_format() {
        let p = parse_tag("{version}-{env}-{commit}-{build}", "1.17.0-staging-4be19d2-0a41dcef").unwrap();
        assert_eq!((p["version"].as_str(), p["env"].as_str(), p["commit"].as_str(), p["build"].as_str()), ("1.17.0", "staging", "4be19d2", "0a41dcef"));
        let p = parse_tag("{version}-{commit}-{build}", "1.20.0-rc.1-124d06b-c2e5b81f").unwrap();
        assert_eq!((p["version"].as_str(), p["commit"].as_str()), ("1.20.0-rc.1", "124d06b"));
        let p = parse_tag("v{version}", "v2.3.4").unwrap();
        assert_eq!(p["version"], "2.3.4");
        assert!(parse_tag("{version}-{commit}-{build}", "latest").is_none());
        assert!(parse_tag("v{version}", "2.3.4").is_none());
        assert_eq!(parse_tag("{commit}", "abc1234").unwrap()["commit"], "abc1234");
    }

    #[test]
    fn host_parsing() {
        assert_eq!(host_of("https://docker-registry.solo-test.site/"), "docker-registry.solo-test.site");
    }
}
