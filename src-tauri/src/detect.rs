//! Deteção: ler o projecto e propor o `ansible-mario.json` sem template.
//!
//! Junta duas leituras:
//!
//! - o **Makefile**, pela convenção `verbo-produto-tecnologia-ambiente`
//!   (`template::makefile_convention`), quando existe;
//! - os **playbooks e roles**, pelo conteúdo: `hosts`, roles, os containers
//!   (`community.docker.docker_container` e afins) com a imagem e a variável
//!   da tag, e palavras-chave nos nomes (postgres, redis, nginx, api, worker,
//!   backup, restore, provision…).
//!
//! Os botões do Makefile ganham; os playbooks que nenhum alvo corre ganham
//! botões próprios. Cada coisa proposta leva a evidência (de onde veio), para a
//! pessoa rever e aceitar antes de gravar.

use crate::manifest::{self, Action, Manifest, Operation, Product, Service};
use crate::project;
use crate::template::{self, capitalize, Report};
use serde_norway::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

/// Palavra → tipo de serviço, por prioridade: `shop-api-worker` é um worker,
/// `web-proxy` é um nginx.
const KINDS: &[(&str, &[&str])] = &[
    ("worker", &["worker", "workers", "queue", "jobs", "celery", "sidekiq", "scheduler", "cron"]),
    ("postgres", &["postgres", "postgresql", "pg", "pgsql", "postgis", "pgbouncer"]),
    ("redis", &["redis", "valkey", "keydb"]),
    ("mysql", &["mysql", "mariadb"]),
    ("mongodb", &["mongo", "mongodb"]),
    ("nginx", &["nginx", "caddy", "traefik", "haproxy", "proxy", "apache", "httpd"]),
    ("vite", &["vite", "spa", "react", "vue"]),
    ("nextjs", &["nextjs", "next", "web", "frontend", "front", "app"]),
    ("nestjs", &["nestjs", "nest", "api", "backend"]),
    ("node", &["node", "nodejs", "express"]),
];

/// Palavra → grupo de operação.
const OPS: &[(&str, &[&str])] = &[
    ("backup", &["backup", "backups", "dump", "snapshot", "snapshots", "restore", "dbgate"]),
    ("maintenance", &["maintenance"]),
    ("observability", &["prometheus", "grafana", "loki", "monitoring", "monitor", "alloy", "exporter", "netdata", "kuma", "beszel", "observability", "metrics", "logging"]),
    ("verify", &["ping", "check", "checks", "verify", "health", "healthcheck", "smoke", "status", "audit"]),
    ("machine", &["provision", "bootstrap", "setup", "common", "harden", "hardening", "security", "users", "firewall", "base", "init", "system", "packages", "swap", "ssh", "docker", "upgrade", "update"]),
];

const DESTRUCTIVE: &[&str] = &["restore", "reset", "destroy", "delete", "drop", "wipe", "purge", "teardown", "uninstall", "remove"];
const MIGRATE: &[&str] = &["migrate", "migrations", "migration"];
const SEED: &[&str] = &["seed", "seeds", "seeder"];
const AGGREGATE: &[&str] = &["site", "main", "all", "everything", "playbook"];

/// As palavras de um nome: `10-shop_api.yml` → [shop, api]; `geerlingguy.postgresql` → [geerlingguy, postgresql].
fn tokens(s: &str) -> Vec<String> {
    s.to_lowercase()
        .trim_end_matches(".yml")
        .trim_end_matches(".yaml")
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty() && !t.chars().all(|c| c.is_ascii_digit()))
        .map(String::from)
        .collect()
}

fn kind_of(words: &[String]) -> Option<&'static str> {
    KINDS.iter().find(|(_, ks)| words.iter().any(|w| ks.contains(&w.as_str()))).map(|(k, _)| *k)
}

fn op_group_of(words: &[String]) -> Option<&'static str> {
    OPS.iter().find(|(_, ks)| words.iter().any(|w| ks.contains(&w.as_str()))).map(|(g, _)| *g)
}

fn has(words: &[String], set: &[&str]) -> bool {
    words.iter().any(|w| set.contains(&w.as_str()))
}

/// O que um playbook (e os roles que usa) diz de si.
#[derive(Default, Debug)]
pub(crate) struct Facts {
    pub hosts: Vec<String>,
    pub roles: Vec<String>,
    pub imports: Vec<String>,
    /// (nome do container, imagem)
    pub containers: Vec<(Option<String>, Option<String>)>,
    /// variáveis com valor de texto (vars, defaults dos roles)
    pub vars: BTreeMap<String, String>,
}

fn as_str(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn get<'a>(m: &'a serde_norway::Mapping, k: &str) -> Option<&'a Value> {
    m.get(Value::String(k.into()))
}

fn walk(v: &Value, f: &mut Facts, depth: usize) {
    if depth > 40 {
        return;
    }
    match v {
        Value::Sequence(seq) => seq.iter().for_each(|x| walk(x, f, depth + 1)),
        Value::Tagged(t) => walk(&t.value, f, depth + 1),
        Value::Mapping(m) => {
            for (k, val) in m {
                let Some(key) = k.as_str() else { continue };
                let short = key.rsplit('.').next().unwrap_or(key);
                match short {
                    "hosts" if depth <= 2 => {
                        if let Some(h) = as_str(val) {
                            f.hosts.extend(h.split([',', ':']).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()));
                        }
                    }
                    "roles" => {
                        if let Value::Sequence(rs) = val {
                            for r in rs {
                                let name = match r {
                                    Value::Mapping(rm) => get(rm, "role").or_else(|| get(rm, "name")).and_then(as_str),
                                    other => as_str(other),
                                };
                                f.roles.extend(name);
                            }
                        }
                    }
                    "include_role" | "import_role" => {
                        if let Value::Mapping(rm) = val {
                            f.roles.extend(get(rm, "name").and_then(as_str));
                        }
                    }
                    "import_playbook" | "include_playbook" => f.imports.extend(as_str(val)),
                    "docker_container" | "podman_container" | "docker_swarm_service" | "docker_compose" | "docker_compose_v2" => {
                        if let Value::Mapping(cm) = val {
                            let name = get(cm, "name").or_else(|| get(cm, "project_name")).and_then(as_str);
                            let image = get(cm, "image").and_then(as_str);
                            f.containers.push((name, image));
                        }
                    }
                    "vars" | "defaults" => {
                        if let Value::Mapping(vm) = val {
                            for (vk, vv) in vm {
                                if let (Some(vk), Some(vv)) = (vk.as_str(), as_str(vv)) {
                                    f.vars.entry(vk.to_string()).or_insert(vv);
                                }
                            }
                        }
                    }
                    _ => {}
                }
                walk(val, f, depth + 1);
            }
        }
        _ => {}
    }
}

fn read_yaml(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    if project::is_vault_text(&text) {
        return None;
    }
    // vários documentos num ficheiro: junta-os numa lista
    let docs: Vec<Value> = serde_norway::Deserializer::from_str(&text)
        .filter_map(|d| serde::Deserialize::deserialize(d).ok())
        .collect();
    if docs.is_empty() { None } else { Some(Value::Sequence(docs)) }
}

/// Os factos de um playbook e dos roles locais que ele usa (tasks, defaults, vars).
pub(crate) fn facts(root: &Path, playbook: &str) -> Facts {
    let mut f = Facts::default();
    if let Some(v) = read_yaml(&root.join(playbook)) {
        walk(&v, &mut f, 0);
    }
    let base = Path::new(playbook).parent().unwrap_or(Path::new(""));
    let mut seen = BTreeSet::new();
    let mut i = 0;
    while i < f.roles.len() && i < 50 {
        let role = f.roles[i].clone();
        i += 1;
        if !seen.insert(role.clone()) {
            continue;
        }
        let Some(dir) = [root.join("roles").join(&role), root.join(base).join("roles").join(&role)].into_iter().find(|d| d.is_dir()) else { continue };
        for sub in ["tasks/main.yml", "tasks/main.yaml", "defaults/main.yml", "defaults/main.yaml", "vars/main.yml", "vars/main.yaml", "meta/main.yml"] {
            let Some(v) = read_yaml(&dir.join(sub)) else { continue };
            if sub.starts_with("defaults") || sub.starts_with("vars") {
                if let Value::Sequence(docs) = &v {
                    for d in docs {
                        if let Value::Mapping(m) = d {
                            for (k, val) in m {
                                if let (Some(k), Some(val)) = (k.as_str(), as_str(val)) {
                                    f.vars.entry(k.to_string()).or_insert(val);
                                }
                            }
                        }
                    }
                }
            } else if sub.starts_with("meta") {
                // dependências de roles também são roles usados
                let mut deps = Facts::default();
                if let Value::Sequence(docs) = &v {
                    for d in docs {
                        if let Value::Mapping(m) = d {
                            if let Some(Value::Sequence(ds)) = get(m, "dependencies") {
                                for x in ds {
                                    let n = match x {
                                        Value::Mapping(rm) => get(rm, "role").or_else(|| get(rm, "name")).and_then(as_str),
                                        other => as_str(other),
                                    };
                                    deps.roles.extend(n);
                                }
                            }
                        }
                    }
                }
                f.roles.extend(deps.roles);
            } else {
                walk(&v, &mut f, 0);
            }
        }
    }
    f
}

/// Uma variável Jinja simples: `{{ api_tag }}` ou `{{ api_tag | default('x') }}` → `api_tag`.
fn jinja_var(s: &str) -> Option<String> {
    let inner = s.trim().strip_prefix("{{")?.strip_suffix("}}")?;
    let name = inner.split('|').next()?.trim();
    name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.').then(|| name.to_string())
}

fn resolve(s: &str, vars: &BTreeMap<String, String>) -> String {
    let mut out = s.to_string();
    for _ in 0..3 {
        let Some(a) = out.find("{{") else { break };
        let Some(b) = out[a..].find("}}") else { break };
        let var = jinja_var(&out[a..a + b + 2]);
        match var.and_then(|v| vars.get(&v).cloned()) {
            Some(val) => out.replace_range(a..a + b + 2, &val),
            None => break,
        }
    }
    out
}

/// `{{ registry }}/shop-api:{{ api_tag }}` → (`shop-api`, `api_tag`).
pub(crate) fn image_parts(image: &str, vars: &BTreeMap<String, String>) -> (Option<String>, Option<String>) {
    // a tag: depois do último `:` que não está dentro de `{{ }}` e vem depois do último `/`
    let (name_part, tag_part) = match image.rfind(":{{") {
        Some(i) => (&image[..i], Some(&image[i + 1..])),
        None => {
            let slash = image.rfind('/').map(|i| i + 1).unwrap_or(0);
            match image[slash..].rfind(':') {
                Some(j) if !image[slash..].contains("{{") => (&image[..slash + j], Some(&image[slash + j + 1..])),
                _ => (image, None),
            }
        }
    };
    let tag_var = tag_part.and_then(jinja_var);
    let resolved = resolve(name_part, vars);
    let name = resolved.rsplit('/').next().map(|n| n.split(':').next().unwrap_or(n).to_string()).filter(|n| !n.is_empty() && !n.contains("{{"));
    (name, tag_var)
}

/// `(nome, ansible_host)` do primeiro host de um inventário YAML.
pub(crate) fn yaml_inventory_host(text: &str) -> Option<(String, String)> {
    fn first(v: &Value) -> Option<(String, String)> {
        let Value::Mapping(m) = v else { return None };
        if let Some(Value::Mapping(hosts)) = get(m, "hosts") {
            if let Some((k, hv)) = hosts.iter().next() {
                let name = as_str(k)?;
                let addr = match hv {
                    Value::Mapping(hm) => get(hm, "ansible_host").and_then(as_str),
                    _ => None,
                };
                return Some((name.clone(), addr.unwrap_or(name)));
            }
        }
        if let Some(Value::Mapping(children)) = get(m, "children") {
            return children.values().find_map(first);
        }
        None
    }
    let v: Value = serde_norway::from_str(text).ok()?;
    let Value::Mapping(top) = &v else { return None };
    top.values().find_map(first)
}

/// Um serviço proposto, antes de ir para um produto.
struct Svc {
    /// `playbooks/<pasta>/x.yml` → a pasta
    folder: String,
    product: String,
    svc: Service,
    evidence: Vec<String>,
    /// Os nomes que o playbook usa (`api_commit`…): uma chave do release que aparece aqui é deste serviço.
    mentions: BTreeSet<String>,
}

/// O que se propõe para um playbook.
enum Found {
    Service(Svc),
    Operation { op: Operation, evidence: Vec<String> },
    /// migrar/semear: liga-se a um serviço do mesmo produto.
    Extra { action: &'static str, product: Option<String>, words: Vec<String>, playbook: String, evidence: Vec<String> },
}

fn op_title(words: &[String], lang: &str) -> String {
    let pt = lang == "pt";
    if words.iter().all(|w| AGGREGATE.contains(&w.as_str())) {
        return if pt { "Instalar tudo".into() } else { "Deploy everything".into() };
    }
    capitalize(&words.join(" "))
}

fn classify(root: &Path, path: &str, lang: &str) -> Found {
    let f = facts(root, path);
    let file = path.rsplit('/').next().unwrap_or(path);
    let stem_words = tokens(file);
    // `playbooks/shop/api.yml` → produto `shop`
    let parts: Vec<&str> = path.split('/').collect();
    let product = (parts.len() >= 3 && !matches!(parts[parts.len() - 2], "playbooks" | "plays" | "ansible"))
        .then(|| parts[parts.len() - 2].to_string());

    let role_words: Vec<String> = f.roles.iter().flat_map(|r| tokens(r)).collect();
    let image_names: Vec<(Option<String>, Option<String>, Option<String>)> = f
        .containers
        .iter()
        .map(|(n, img)| {
            let (iname, tag) = img.as_deref().map(|i| image_parts(i, &f.vars)).unwrap_or((None, None));
            (n.as_deref().map(|x| resolve(x, &f.vars)).filter(|x| !x.contains("{{")), iname, tag)
        })
        .collect();
    let container_words: Vec<String> = image_names.iter().flat_map(|(n, i, _)| n.iter().chain(i.iter()).flat_map(|x| tokens(x))).collect();

    let mut evidence = vec![format!("playbook {path}")];
    if !f.roles.is_empty() {
        evidence.push(format!("roles {}", f.roles.join(", ")));
    }
    for (n, i, t) in &image_names {
        let mut e = String::from("container");
        if let Some(n) = n { e += &format!(" {n}"); }
        if let Some(i) = i { e += &format!(" · image {i}"); }
        if let Some(t) = t { e += &format!(" · tag {{{{ {t} }}}}"); }
        evidence.push(e);
    }
    if !f.hosts.is_empty() {
        evidence.push(format!("hosts {}", f.hosts.join(", ")));
    }

    let destructive = has(&stem_words, DESTRUCTIVE);
    // um playbook que só importa outros: "instalar tudo"
    if !f.imports.is_empty() && f.containers.is_empty() && f.roles.is_empty() || (stem_words.iter().all(|w| AGGREGATE.contains(&w.as_str())) && !stem_words.is_empty()) {
        if !f.imports.is_empty() {
            evidence.push(format!("imports {}", f.imports.join(", ")));
        }
        return Found::Operation {
            op: Operation { id: stem_words.join("-"), label: op_title(&stem_words, lang), group: "other".into(), description: String::new(), action: pb(path), destructive },
            evidence,
        };
    }
    if has(&stem_words, MIGRATE) || has(&stem_words, SEED) {
        let action = if has(&stem_words, MIGRATE) { "migrate" } else { "seed" };
        let words = stem_words.iter().filter(|w| !MIGRATE.contains(&w.as_str()) && !SEED.contains(&w.as_str()) && !["run", "db", "database"].contains(&w.as_str())).cloned().collect();
        return Found::Extra { action, product, words, playbook: path.into(), evidence };
    }
    // operação pelo nome do ficheiro (backup-postgres é uma operação, não o postgres)
    if let Some(g) = op_group_of(&stem_words) {
        return Found::Operation {
            op: Operation { id: stem_words.join("-"), label: op_title(&stem_words, lang), group: g.into(), description: String::new(), action: pb(path), destructive: destructive || has(&stem_words, &["restore"]) },
            evidence,
        };
    }
    // repor, apagar: uma operação perigosa, nunca um serviço
    if destructive {
        return Found::Operation {
            op: Operation { id: stem_words.join("-"), label: op_title(&stem_words, lang), group: "other".into(), description: String::new(), action: pb(path), destructive },
            evidence,
        };
    }
    // um serviço: pelo container, pelos roles, pelo nome
    let kind = kind_of(&container_words).or_else(|| kind_of(&stem_words)).or_else(|| kind_of(&role_words));
    if kind.is_none() {
        // `playbooks/kuma/push-agent.yml`: a pasta diz o que é
        let folder_words = product.as_deref().map(tokens).unwrap_or_default();
        let by = if f.containers.is_empty() { op_group_of(&role_words) } else { None }.or_else(|| op_group_of(&folder_words));
        if let Some(g) = by {
            return Found::Operation {
                op: Operation { id: stem_words.join("-"), label: op_title(&stem_words, lang), group: g.into(), description: String::new(), action: pb(path), destructive },
                evidence,
            };
        }
    }
    let kind = kind.unwrap_or("service");
    let single = (image_names.len() == 1).then(|| image_names[0].clone());
    let container = single.as_ref().and_then(|(n, _, _)| n.clone());
    let image = single.as_ref().and_then(|(_, i, _)| i.clone()).filter(|_| !matches!(kind, "postgres" | "redis" | "mysql" | "mongodb" | "nginx"));
    let tag_var = single.as_ref().and_then(|(_, _, t)| t.clone());
    let label = container.clone().or_else(|| image.clone()).unwrap_or_else(|| stem_words.join("-"));
    let mut actions = BTreeMap::new();
    actions.insert("deploy".to_string(), pb(path));
    let svc = Service {
        id: label.clone(),
        label,
        kind: kind.into(),
        // a variável da tag, se o release a tiver, é a chave da versão (verifica-se depois)
        release_key: tag_var,
        image,
        per_env_image: false,
        container,
        description: None,
        versions: None,
        actions,
    };
    let text = fs::read_to_string(root.join(path)).unwrap_or_default();
    let mentions = text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).filter(|w| w.contains('_')).map(String::from).collect();
    Found::Service(Svc { folder: product.unwrap_or_default(), product: String::new(), svc, evidence, mentions })
}

fn pb(path: &str) -> Action {
    Action { make: None, playbook: Some(path.into()), envs: vec![], includes_deploy: false }
}

fn slug(s: &str) -> String {
    tokens(s).join("-")
}

fn unique(id: String, taken: &mut BTreeSet<String>) -> String {
    let base = if id.is_empty() { "item".to_string() } else { id };
    let mut out = base.clone();
    let mut n = 2;
    while !taken.insert(out.clone()) {
        out = format!("{base}-{n}");
        n += 1;
    }
    out
}

/// Os playbooks que um Makefile já corre (aparecem nas receitas).
fn playbooks_in_makefile(root: &Path) -> BTreeSet<String> {
    project::make_targets(root)
        .iter()
        .flat_map(|t| t.recipe.iter())
        .flat_map(|l| l.split(|c: char| c.is_whitespace() || matches!(c, ',' | '"' | '\'' | '(' | ')' | '=')).map(String::from).collect::<Vec<_>>())
        .filter(|w| w.ends_with(".yml") || w.ends_with(".yaml"))
        .map(|w| w.trim_start_matches("./").to_string())
        .collect()
}

/// Lê os playbooks e propõe serviços, operações e produtos. `skip` são os
/// playbooks que já têm botão (pelo Makefile).
fn role_of(kind: &str) -> &str {
    match kind {
        "nestjs" | "node" => "api",
        "nextjs" | "vite" => "app",
        other => other,
    }
}

fn from_playbooks(root: &Path, lang: &str, skip: &BTreeSet<String>, main_product: &str) -> (Vec<Svc>, Vec<(Operation, Vec<String>)>, usize) {
    let scan = project::scan(root);
    let books: Vec<String> = scan.files.iter().filter(|f| f.kind == "playbook").map(|f| f.path.clone()).collect();
    let total = books.len();
    let mut services: Vec<Svc> = Vec::new();
    let mut ops: Vec<(Operation, Vec<String>)> = Vec::new();
    let mut extras = Vec::new();
    for b in books.iter().filter(|b| !skip.iter().any(|s| s == *b || s.ends_with(&format!("/{b}")) || b.ends_with(&format!("/{s}")))) {
        match classify(root, b, lang) {
            Found::Service(x) => services.push(x),
            Found::Operation { op, evidence } => ops.push((op, evidence)),
            Found::Extra { action, product, words, playbook, evidence } => extras.push((action, product, words, playbook, evidence)),
        }
    }

    // produto pelo prefixo comum, em cada pasta: `shop-api`, `shop-web` → shop;
    // `playbooks/decidido/admin-nestjs.yml`, `admin-nextjs.yml` → decidido-admin
    let generic: BTreeSet<&str> = KINDS.iter().flat_map(|(_, ks)| ks.iter().copied()).chain(["deploy", "install", "service", "services"]).collect();
    let mut prefix_count: BTreeMap<(String, String), usize> = BTreeMap::new();
    for x in &services {
        let t = tokens(&x.svc.label);
        if let Some(first) = t.first().filter(|w| !generic.contains(w.as_str()) && t.len() > 1 && **w != x.folder) {
            *prefix_count.entry((x.folder.clone(), first.clone())).or_default() += 1;
        }
    }
    let groups: BTreeSet<(String, String)> = prefix_count.into_iter().filter(|(_, n)| *n >= 2).map(|(k, _)| k).collect();
    let top: Vec<&String> = groups.iter().filter(|(f, _)| f.is_empty()).map(|(_, g)| g).collect();
    for x in services.iter_mut() {
        let first = tokens(&x.svc.label).first().cloned().unwrap_or_default();
        x.product = if groups.contains(&(x.folder.clone(), first.clone())) {
            if x.folder.is_empty() { first } else { format!("{}-{first}", x.folder) }
        } else if !x.folder.is_empty() {
            x.folder.clone()
        } else if top.len() == 1 {
            // com um só grupo, o resto (postgres, redis) também é dele
            top[0].clone()
        } else {
            main_product.to_string()
        };
        // o id é o papel dentro do produto: `shop-api` em shop → `api`, `vite-app` → `app`
        let ptoks = tokens(&x.product);
        let rest: Vec<String> = tokens(&x.svc.label).into_iter().filter(|w| !ptoks.contains(w)).collect();
        let only_tech = rest.iter().all(|w| generic.contains(w.as_str()));
        x.svc.id = if x.svc.kind != "service" && only_tech {
            role_of(&x.svc.kind).to_string()
        } else if rest.is_empty() {
            slug(&x.svc.label)
        } else {
            rest.join("-")
        };
        if x.svc.container.is_none() && only_tech && x.svc.kind != "service" {
            x.svc.label = template::kind_label(&x.svc.kind).to_string();
        }
    }

    // migrar/semear: o serviço do mesmo produto com mais palavras em comum, ou a única app
    for (action, product, words, playbook, evidence) in extras {
        let pid = product.unwrap_or_else(|| main_product.to_string());
        let score = |s: &Service| tokens(&s.label).iter().filter(|w| words.contains(w)).count();
        let target = services
            .iter_mut()
            .filter(|x| (x.product == pid || words.contains(&x.product)) && matches!(x.svc.kind.as_str(), "nestjs" | "node" | "worker" | "service"))
            .max_by_key(|x| score(&x.svc));
        match target {
            Some(x) => {
                x.svc.actions.insert(action.into(), pb(&playbook));
                x.evidence.push(format!("{action}: {playbook}"));
            }
            None => {
                let file = playbook.rsplit('/').next().unwrap_or(&playbook);
                let w = tokens(file);
                ops.push((Operation { id: w.join("-"), label: op_title(&w, lang), group: "other".into(), description: String::new(), action: pb(&playbook), destructive: false }, evidence));
            }
        }
    }
    (services, ops, total)
}

/// O manifesto proposto para um projecto, com o Makefile e os playbooks.
pub fn auto(root: &Path, lang: &str) -> Report {
    let mut make = template::makefile_convention(root, lang);
    let use_make = make.compatible && make.matched > 0;
    let project_name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let main_product = slug(project_name.trim_end_matches("-infra").trim_end_matches("-ansible"));
    let main_product = if main_product.is_empty() { "app".to_string() } else { main_product };

    let mut evidence: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut sources = Vec::new();
    let mut m: Manifest = if use_make {
        sources.push("Makefile".to_string());
        // evidência dos alvos do Makefile
        for p in &make.manifest.products {
            for s in &p.services {
                let ts: Vec<String> = s.actions.values().filter_map(|a| a.make.clone()).collect();
                evidence.insert(format!("svc:{}/{}", p.id, s.id), vec![format!("make {}", ts.join(", "))]);
            }
        }
        for o in &make.manifest.operations {
            if let Some(t) = &o.action.make {
                evidence.insert(format!("op:{}", o.id), vec![format!("make {t}")]);
            }
        }
        std::mem::take(&mut make.manifest)
    } else {
        Manifest {
            schema: Some(manifest::SCHEMA.into()),
            version: 2,
            name: capitalize(&main_product),
            template: None,
            environments: template::environments(root, lang),
            promotion: vec![],
            registry: None,
            products: vec![],
            operations: vec![],
            variables: vec![],
        }
    };
    m.template = Some("auto".into());

    let skip = if use_make { playbooks_in_makefile(root) } else { BTreeSet::new() };
    let (services, ops, books) = from_playbooks(root, lang, &skip, &main_product);
    if books > 0 {
        sources.push("playbooks".to_string());
    }
    if root.join("roles").is_dir() {
        sources.push("roles".to_string());
    }

    // as versões: a variável da tag só fica se o release a tiver
    let rel = template::release_keys(root, &m.environments);
    let keys: BTreeSet<String> = rel.values().flat_map(|x| x.keys().cloned()).collect();
    let mut found_services = 0;
    for Svc { product: pid, svc: mut s, evidence: mut ev, mentions, .. } in services {
        let infra = matches!(s.kind.as_str(), "postgres" | "redis" | "mysql" | "mongodb" | "nginx");
        let versioned = |k: &&String| template::KEY_SUFFIXES.iter().any(|sfx| k.ends_with(sfx));
        let key = s.release_key.take().filter(|k| keys.contains(k)).or_else(|| {
            if infra {
                return None;
            }
            // uma chave do release que o playbook usa; com várias, a das palavras do serviço
            let used: Vec<&String> = keys.iter().filter(versioned).filter(|k| mentions.contains(*k)).collect();
            let words: Vec<String> = tokens(&s.label).into_iter().chain(tokens(&pid)).chain([role_of(&s.kind).to_string()]).collect();
            let fits = |k: &&String| {
                let base = template::KEY_SUFFIXES.iter().find_map(|sfx| k.strip_suffix(sfx)).unwrap_or(k);
                !base.is_empty() && tokens(base).iter().all(|w| words.contains(w))
            };
            match used.len() {
                1 => Some(used[0].clone()),
                0 => keys.iter().filter(versioned).find(fits).cloned(),
                _ => used.into_iter().find(fits).cloned(),
            }
        });
        if let Some(k) = key {
            if s.image.is_none() && template::name_like(&s.label) && s.label.contains('-') && !infra {
                s.image = Some(s.label.clone());
            }
            template::fill_versions(root, &rel, &mut s, &k);
            ev.push(format!("version {k} in releases/"));
            s.release_key = Some(k);
        }
        let pi = match m.products.iter().position(|p| p.id == pid) {
            Some(i) => i,
            None => {
                m.products.push(Product { id: pid.clone(), label: capitalize(&pid.replace('-', " ")), description: String::new(), environments: vec![], placements: BTreeMap::new(), services: vec![] });
                m.products.len() - 1
            }
        };
        let mut taken: BTreeSet<String> = m.products[pi].services.iter().map(|x| x.id.clone()).collect();
        s.id = unique(s.id.clone(), &mut taken);
        evidence.insert(format!("svc:{pid}/{}", s.id), ev);
        m.products[pi].services.push(s);
        found_services += 1;
    }
    let mut op_ids: BTreeSet<String> = m.operations.iter().map(|o| o.id.clone()).collect();
    for (mut o, ev) in ops {
        o.id = unique(o.id.clone(), &mut op_ids);
        evidence.insert(format!("op:{}", o.id), ev);
        m.operations.push(o);
    }

    if !use_make {
        // as mesmas regras do Makefile: staging → produção, variantes na mesma máquina, variáveis
        if let (Some(a), Some(b)) = (m.environments.iter().find(|e| e.color == "staging"), m.environments.iter().find(|e| e.color == "production")) {
            m.promotion = vec![manifest::Promotion { from: a.id.clone(), to: b.id.clone() }];
        }
        let envs = m.environments.clone();
        let variants = template::by_machine(root, &mut m, &BTreeMap::new());
        m.variables = template::detect_variables(root, &envs, &variants);
    }
    for e in &m.environments {
        let mut ev = vec![format!("inventory {}", e.inventory)];
        if let Some(r) = &e.release {
            ev.push(format!("release {r}"));
        }
        evidence.insert(format!("env:{}", e.id), ev);
    }
    for v in &m.variables {
        evidence.insert(format!("var:{}", v.id), v.files.values().cloned().collect::<BTreeSet<_>>().into_iter().collect());
    }

    let services_total: usize = m.products.iter().map(|p| p.services.len()).sum();
    let mut warnings = if use_make { make.warnings } else { vec![] };
    if m.environments.is_empty() {
        warnings.push(if lang == "pt" { "nenhum inventário encontrado — acrescenta os servidores em Definições".into() } else { "no inventory found — add the servers in Settings".into() });
    }
    let (matched, total) = if use_make { (make.matched, make.total) } else { (found_services, books) };
    Report {
        template: "auto".into(),
        compatible: !m.environments.is_empty() && services_total + m.operations.len() > 0,
        matched,
        total,
        manifest: m,
        unmatched: if use_make { make.unmatched } else { vec![] },
        warnings,
        evidence,
        sources,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(s: &str) -> Vec<String> {
        tokens(s)
    }

    #[test]
    fn kinds_from_words() {
        assert_eq!(kind_of(&w("shop-api")), Some("nestjs"));
        assert_eq!(kind_of(&w("shop-api-worker")), Some("worker"));
        assert_eq!(kind_of(&w("geerlingguy.postgresql")), Some("postgres"));
        assert_eq!(kind_of(&w("web-proxy")), Some("nginx"));
        assert_eq!(kind_of(&w("happy")), None);
        assert_eq!(op_group_of(&w("30-backup.yml")), Some("backup"));
        assert_eq!(op_group_of(&w("provision-system")), Some("machine"));
        assert_eq!(op_group_of(&w("grafana")), Some("observability"));
    }

    #[test]
    fn image_and_tag_variable() {
        let mut vars = BTreeMap::new();
        vars.insert("shop_api_image".to_string(), "registry.example.com/shop-api".to_string());
        assert_eq!(image_parts("{{ registry }}/shop-api:{{ api_tag }}", &vars), (Some("shop-api".into()), Some("api_tag".into())));
        assert_eq!(image_parts("{{ shop_api_image }}:{{ api_tag | default('latest') }}", &vars), (Some("shop-api".into()), Some("api_tag".into())));
        assert_eq!(image_parts("postgres:16-alpine", &vars), (Some("postgres".into()), None));
        assert_eq!(image_parts("ghcr.io/acme/web", &vars), (Some("web".into()), None));
    }

    #[test]
    fn yaml_inventory() {
        let inv = "all:\n  children:\n    web:\n      hosts:\n        shop-prod:\n          ansible_host: 10.0.0.5\n";
        assert_eq!(yaml_inventory_host(inv), Some(("shop-prod".into(), "10.0.0.5".into())));
    }

    #[test]
    fn playbooks_only_example() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/playbooks-only");
        let r = auto(&root, "en");
        let m = &r.manifest;
        let envs: Vec<&str> = m.environments.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(envs, ["staging", "production"]);
        assert_eq!(m.promotion.len(), 1);
        let shop = m.products.iter().find(|p| p.id == "shop").expect("product shop");
        let kinds: BTreeMap<&str, &str> = shop.services.iter().map(|s| (s.id.as_str(), s.kind.as_str())).collect();
        assert_eq!(kinds.get("api"), Some(&"nestjs"), "{kinds:?}");
        assert_eq!(kinds.get("app"), Some(&"nextjs"), "{kinds:?}");
        let api = shop.services.iter().find(|s| s.id == "api").unwrap();
        assert_eq!(api.release_key.as_deref(), Some("api_tag"));
        assert_eq!(api.image.as_deref(), Some("shop-api"));
        assert!(api.actions.contains_key("migrate"), "{:?}", api.actions);
        assert_eq!(api.versions.as_ref().and_then(|v| v.tag_format.clone()).as_deref(), Some("{version}-{commit}-{build}"));
        let all_kinds: BTreeSet<&str> = m.products.iter().flat_map(|p| p.services.iter().map(|s| s.kind.as_str())).collect();
        for k in ["postgres", "redis", "nginx"] {
            assert!(all_kinds.contains(k), "{k} missing: {all_kinds:?}");
        }
        let ops: BTreeMap<&str, (&str, bool)> = m.operations.iter().map(|o| (o.id.as_str(), (o.group.as_str(), o.destructive))).collect();
        assert_eq!(ops.get("backup"), Some(&("backup", false)), "{ops:?}");
        assert_eq!(ops.get("restore"), Some(&("backup", true)), "{ops:?}");
        assert_eq!(ops.get("provision").map(|x| x.0), Some("machine"), "{ops:?}");
        assert!(ops.contains_key("site"), "{ops:?}");
        assert!(r.evidence.contains_key("svc:shop/api"));
        let problems = manifest::validate(&root, m, &BTreeSet::new());
        assert!(problems.is_empty(), "{problems:?}");
    }

    #[test]
    fn demo_infra_keeps_the_makefile() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/demo-infra");
        let make = template::makefile_convention(&root, "en");
        let r = auto(&root, "en");
        assert_eq!(r.sources.first().map(String::as_str), Some("Makefile"));
        let count = |m: &Manifest| m.products.iter().map(|p| p.services.len()).sum::<usize>();
        assert_eq!(count(&r.manifest), count(&make.manifest), "the Makefile already runs every playbook");
        for (a, b) in r.manifest.products.iter().zip(make.manifest.products.iter()) {
            assert_eq!(a.services.iter().map(|s| &s.id).collect::<Vec<_>>(), b.services.iter().map(|s| &s.id).collect::<Vec<_>>());
        }
    }

    /// Projectos reais, só lidos (`ANSIBLE_MARIO_FIXTURES=a:b`).
    #[test]
    fn real_projects_auto() {
        let Ok(roots) = std::env::var("ANSIBLE_MARIO_FIXTURES") else { return };
        for root in roots.split(':') {
            let r = auto(Path::new(root), "pt");
            println!("\n== {root} · {:?} · {}/{}", r.sources, r.matched, r.total);
            for p in &r.manifest.products {
                println!("  produto {}", p.label);
                for s in &p.services {
                    println!("    {:<20} {:<8} {:?} {:?}", s.id, s.kind, s.release_key, s.actions.keys().collect::<Vec<_>>());
                }
            }
            for o in &r.manifest.operations {
                println!("  op [{}] {}", o.group, o.id);
            }
        }
    }
}
