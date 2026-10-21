//! Templates: gerar o `ansible-mario.json` a partir do que o projecto já tem.
//!
//! O template "Convenção do Makefile" lê nomes como
//! `deploy-shop-nestjs-staging` e `run-migrations-edu-nestjs-production`:
//!
//!     verbo · produto · tecnologia · ambiente
//!
//! Lê-se da direita: o ambiente é o último bocado (tem de ser um inventário),
//! o verbo é o prefixo conhecido mais comprido, a tecnologia é o sufixo
//! conhecido mais comprido do que sobra, e o produto é o meio. O que não tem
//! produto (`deploy-backup-*`, `provision-system-*`) é uma operação, não um
//! serviço. Se um projecto não segue a convenção, diz-se quanto segue — a
//! compatibilidade é um número, não um sim/não escondido.

use crate::manifest::{self, Action, Environment, Manifest, Operation, Placement, Product, Promotion, Registry, Service, Variable};
use crate::project::{self, MakeTarget};
use crate::releases;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

const VERBS: &[&str] = &[
    "run-migrations", "run-seed", "maintenance-on", "maintenance-off", "restore-upload", "restore-local",
    "audit-security", "deploy", "provision", "restore", "snapshots", "logs", "status", "ping", "history", "test", "reset",
];
const TECHS: &[&str] = &["nestjs-worker", "nestjs", "nextjs", "vite", "nginx", "postgres", "redis", "mysql", "mongodb", "node", "worker"];
const KEY_SUFFIXES: &[&str] = &["_tag", "_commit", "_version", "_image"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub template: String,
    pub compatible: bool,
    pub matched: usize,
    pub total: usize,
    pub manifest: Manifest,
    pub unmatched: Vec<String>,
    pub warnings: Vec<String>,
}

fn kind_of(tech: &str) -> &'static str {
    match tech {
        "nestjs-worker" | "worker" => "worker",
        "nestjs" => "nestjs",
        "nextjs" => "nextjs",
        "vite" => "vite",
        "nginx" => "nginx",
        "postgres" => "postgres",
        "redis" => "redis",
        "mysql" => "mysql",
        "mongodb" => "mongodb",
        _ => "service",
    }
}

/// O papel do serviço dentro do produto — é também o id e a base da chave do release.
fn role_of(tech: &str) -> &'static str {
    match tech {
        "nestjs" | "node" => "api",
        "nestjs-worker" | "worker" => "worker",
        "nextjs" | "vite" => "app",
        "nginx" => "nginx",
        "postgres" => "postgres",
        "redis" => "redis",
        "mysql" => "mysql",
        "mongodb" => "mongodb",
        _ => "service",
    }
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "nestjs" => "API NestJS",
        "worker" => "Worker",
        "nextjs" => "App Next.js",
        "vite" => "App Vite",
        "nginx" => "nginx",
        "postgres" => "Postgres",
        "redis" => "Redis",
        "mysql" => "MySQL",
        "mongodb" => "MongoDB",
        _ => "Serviço",
    }
}

fn env_meta(id: &str, lang: &str) -> (String, String, bool) {
    let l = id.to_lowercase();
    if l.contains("prod") {
        (if lang == "pt" { "Produção" } else { "Production" }.into(), "production".into(), true)
    } else if l.contains("stag") {
        ("Staging".into(), "staging".into(), false)
    } else if l.contains("test") || l.contains("qa") || l.contains("dev") {
        (capitalize(id), "testes".into(), false)
    } else {
        (capitalize(id), "neutral".into(), false)
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

fn name_like(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// O primeiro bocado da descrição (`shop-api · playbooks/…` → `shop-api`).
fn first_segment(desc: &str) -> &str {
    desc.split(" · ").next().unwrap_or("").trim()
}

/// O nome de uma operação na língua pedida: o verbo traduzido e o resto com
/// os nomes conhecidos (`provision-security` → `Provision security` / `Provisionar segurança`).
fn op_label(verb: &str, rest: &str, lang: &str) -> String {
    let pt = lang == "pt";
    let v = match verb {
        "provision" => if pt { "Provisionar" } else { "Provision" },
        "deploy" => if pt { "Instalar" } else { "Install" },
        "restore" => if pt { "Restaurar" } else { "Restore" },
        "restore-upload" => if pt { "Restaurar de ficheiros deste computador" } else { "Restore from files on this computer" },
        "restore-local" => if pt { "Restaurar de ficheiros na máquina" } else { "Restore from files on the machine" },
        "snapshots" => if pt { "Listar os snapshots" } else { "List snapshots" },
        "ping" => "Ping",
        "status" => if pt { "Estado dos containers" } else { "Container status" },
        "logs" => if pt { "Logs de um container" } else { "Container logs" },
        "history" => if pt { "Diário de deploys" } else { "Deploy log" },
        "audit-security" => if pt { "Auditoria de segurança" } else { "Security audit" },
        "test" => if pt { "Testar" } else { "Test" },
        "reset" => if pt { "Repor" } else { "Reset" },
        "run-migrations" => if pt { "Migrar" } else { "Migrate" },
        "run-seed" => if pt { "Semear" } else { "Seed" },
        "maintenance-on" => if pt { "Fechar" } else { "Close" },
        "maintenance-off" => if pt { "Reabrir" } else { "Reopen" },
        other => return capitalize(&format!("{other} {rest}").replace('-', " ").trim().to_string()),
    };
    let r = match (rest, pt) {
        ("", _) => "",
        ("system", true) => "sistema",
        ("security", true) => "segurança",
        ("maintenance", true) => "manutenção",
        ("platform", true) => "plataforma",
        ("local", true) => "deste computador",
        ("local", false) => "from this computer",
        ("dbgate", _) => "DbGate",
        ("netdata", _) => "Netdata",
        ("kuma-push", _) => "Kuma",
        ("beszel", _) => "Beszel",
        (other, _) => other,
    };
    if r.is_empty() { v.to_string() } else { format!("{v} {}", r.replace('-', " ")) }
}

fn env_rank(color: &str) -> u8 {
    match color {
        "staging" => 0,
        "production" => 1,
        "testes" => 2,
        _ => 3,
    }
}

struct Parsed<'a> {
    verb: &'a str,
    rest: String,
    env: Option<String>,
}

fn parse<'a>(name: &str, envs: &BTreeSet<String>) -> Option<Parsed<'a>> {
    let (base, env) = match name.rsplit_once('-') {
        Some((b, e)) if envs.contains(e) => (b.to_string(), Some(e.to_string())),
        _ => (name.to_string(), None),
    };
    let verb = VERBS.iter().copied().filter(|v| base == *v || base.starts_with(&format!("{v}-"))).max_by_key(|v| v.len())?;
    let rest = base[verb.len()..].trim_start_matches('-').to_string();
    Some(Parsed { verb, rest, env })
}

fn split_product_tech(rest: &str) -> Option<(String, &'static str)> {
    let tech = TECHS.iter().copied().filter(|t| rest == *t || rest.ends_with(&format!("-{t}"))).max_by_key(|t| t.len())?;
    let product = rest[..rest.len() - tech.len()].trim_end_matches('-').to_string();
    Some((product, tech))
}

fn op_group(id: &str, verb: &str, section: &str) -> &'static str {
    let s = section.to_lowercase();
    if ["backup", "restore", "snapshot", "dbgate"].iter().any(|k| id.contains(k)) {
        return "backup";
    }
    if s.contains("observ") || verb == "test" || ["netdata", "kuma", "beszel"].iter().any(|k| id.contains(k)) {
        return "observability";
    }
    if s.contains("verific") || matches!(verb, "ping" | "status" | "logs" | "history" | "audit-security") {
        return "verify";
    }
    if verb == "provision" || s.contains("provis") {
        return "machine";
    }
    if verb.starts_with("maintenance") || s.contains("manuten") {
        return "maintenance";
    }
    "other"
}

fn release_keys(root: &Path, envs: &[Environment]) -> BTreeMap<String, BTreeMap<String, String>> {
    envs.iter()
        .filter_map(|e| e.release.as_ref().map(|r| (e.id.clone(), releases::read(root, r).unwrap_or_default())))
        .collect()
}

/// Lista os ambientes a partir de `inventories/<nome>.ini|yml`.
fn environments(root: &Path, lang: &str) -> Vec<Environment> {
    let mut envs = Vec::new();
    for dir in ["inventories", "inventory"] {
        let Ok(rd) = fs::read_dir(root.join(dir)) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let file = p.file_name().unwrap().to_string_lossy().to_string();
            let Some((stem, ext)) = file.rsplit_once('.') else { continue };
            if !matches!(ext, "ini" | "yml" | "yaml") {
                continue;
            }
            let (label, color, protected) = env_meta(stem, lang);
            let release = ["yml", "yaml"].iter().map(|x| format!("releases/{stem}.{x}")).find(|r| root.join(r).is_file());
            envs.push(Environment { id: stem.to_string(), label, inventory: format!("{dir}/{file}"), release, color, protected });
        }
    }
    envs.sort_by(|a, b| (env_rank(&a.color), &a.id).cmp(&(env_rank(&b.color), &b.id)));
    envs
}

/// O formato de uma tag a partir de um exemplo do release:
/// `1.17.0-staging-4be19d2-0a41dcef` → `{version}-{env}-{commit}-{build}`.
pub fn guess_tag_format(tag: &str, env: &str) -> Option<String> {
    let hex = |x: &str| x.len() >= 6 && x.chars().all(|c| c.is_ascii_hexdigit());
    let ver = |x: &str| x.split('.').count() >= 2 && x.split('.').all(|p| !p.is_empty() && p.chars().next().is_some_and(|c| c.is_ascii_digit()));
    let parts: Vec<&str> = tag.split('-').collect();
    let n = parts.len();
    if n == 1 {
        return if hex(tag) && !ver(tag) { Some("{commit}".into()) } else if ver(tag.trim_start_matches('v')) { Some(if tag.starts_with('v') { "v{version}" } else { "{version}" }.into()) } else { None };
    }
    let head = ver(parts[0].trim_start_matches('v'));
    let v = if parts[0].starts_with('v') { "v{version}" } else { "{version}" };
    if !head { return None; }
    match &parts[1..] {
        [e, c, b] if *e == env && hex(c) && hex(b) => Some(format!("{v}-{{env}}-{{commit}}-{{build}}")),
        [e, c] if *e == env && hex(c) => Some(format!("{v}-{{env}}-{{commit}}")),
        [c, b] if hex(c) && hex(b) => Some(format!("{v}-{{commit}}-{{build}}")),
        [c] if hex(c) => Some(format!("{v}-{{commit}}")),
        _ => None,
    }
}

pub fn makefile_convention(root: &Path, lang: &str) -> Report {
    let project_name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let main_product = project_name.trim_end_matches("-infra").trim_end_matches("-ansible").to_string();
    let envs = environments(root, lang);
    let env_ids: BTreeSet<String> = envs.iter().map(|e| e.id.clone()).collect();
    let targets: Vec<MakeTarget> = project::make_targets(root);
    let mut warnings = Vec::new();

    let rel = release_keys(root, &envs);
    let all_keys: BTreeSet<String> = rel.values().flat_map(|m| m.keys().cloned()).collect();

    // product → (label, description), pela secção `##@ produto · descrição`
    let mut product_meta: BTreeMap<String, (String, String)> = BTreeMap::new();
    // toda a secção `##@ x · desc`, pela primeira palavra — serve os produtos de variantes
    let mut sections: BTreeMap<String, (String, String)> = BTreeMap::new();
    for t in &targets {
        if let Some((head, desc)) = t.section.split_once(" · ") {
            sections.entry(head.trim().to_lowercase()).or_insert((capitalize(head.trim()), desc.trim().to_string()));
        }
    }
    let mut product_order: Vec<String> = Vec::new();
    // (product, tech) → Service em construção
    let mut services: BTreeMap<(String, &'static str), Service> = BTreeMap::new();
    let mut service_order: Vec<(String, &'static str)> = Vec::new();
    let mut ops: BTreeMap<String, Operation> = BTreeMap::new();
    let mut op_order: Vec<String> = Vec::new();
    let mut unmatched = Vec::new();
    let mut matched = 0;

    for t in &targets {
        let Some(p) = parse(&t.name, &env_ids) else {
            unmatched.push(t.name.clone());
            continue;
        };
        matched += 1;
        let env_list = p.env.iter().cloned().collect::<Vec<_>>();
        let service_action = match p.verb {
            "deploy" => Some("deploy"),
            "run-migrations" => Some("migrate"),
            "run-seed" => Some("seed"),
            "maintenance-on" => Some("maintenanceOn"),
            "maintenance-off" => Some("maintenanceOff"),
            _ => None,
        };
        let pt = split_product_tech(&p.rest).map(|(prod, tech)| (if prod.is_empty() { main_product.clone() } else { prod }, tech));

        if let (Some(action), Some((product, tech))) = (service_action, pt) {
            if !product_order.contains(&product) {
                product_order.push(product.clone());
            }
            if !product_meta.contains_key(&product) {
                let sec = t.section.to_lowercase();
                if let Some((head, desc)) = t.section.split_once(" · ") {
                    if sec.starts_with(&product) {
                        product_meta.insert(product.clone(), (capitalize(head.trim()), desc.trim().to_string()));
                    }
                }
            }
            let key = (product.clone(), tech);
            if !services.contains_key(&key) {
                service_order.push(key.clone());
                let kind = kind_of(tech);
                services.insert(key.clone(), Service {
                    id: role_of(tech).to_string(),
                    label: kind_label(kind).to_string(),
                    kind: kind.to_string(),
                    release_key: None,
                    image: None,
                    per_env_image: false,
                    container: None,
                    description: None,
                    versions: None,
                    actions: BTreeMap::new(),
                });
            }
            let s = services.get_mut(&key).unwrap();
            // o nome do serviço vem da descrição do deploy: `shop-api · playbooks/…`
            let seg = first_segment(&t.description);
            if action == "deploy" && name_like(seg) && s.container.is_none() {
                s.label = seg.to_string();
                s.container = Some(seg.to_string());
            } else if action == "deploy" && !seg.is_empty() && s.description.is_none() && s.container.is_none() && !name_like(seg) {
                s.description = Some(seg.to_string());
            }
            let base = t.name.trim_end_matches(&format!("-{}", p.env.clone().unwrap_or_default())).to_string();
            let entry = s.actions.entry(action.to_string()).or_insert_with(|| Action {
                make: Some(if p.env.is_some() { format!("{base}-{{env}}") } else { base.clone() }),
                playbook: None,
                envs: vec![],
                includes_deploy: false,
            });
            entry.envs.extend(env_list);
        } else {
            let id = if p.rest.is_empty() { p.verb.to_string() } else { format!("{}-{}", p.verb, p.rest) };
            let o = ops.entry(id.clone()).or_insert_with(|| {
                op_order.push(id.clone());
                Operation {
                    id: id.clone(),
                    label: op_label(p.verb, &p.rest, lang),
                    group: op_group(&id, p.verb, &t.section).to_string(),
                    description: t.description.clone(),
                    action: Action {
                        make: Some(if p.env.is_some() { format!("{id}-{{env}}") } else { id.clone() }),
                        playbook: None,
                        envs: vec![],
                        includes_deploy: false,
                    },
                    destructive: {
                        let s = format!("{} {}", t.name, t.description).to_lowercase();
                        ["apaga", "reset", "restore", "restaura", "destroy", "delete", "drop", "wipe"].iter().any(|k| s.contains(k))
                    },
                }
            });
            o.action.envs.extend(env_list);
        }
    }

    // chaves de release, imagem e se a tag traz o ambiente
    for ((product, tech), s) in services.iter_mut() {
        if !matches!(*tech, "nestjs" | "nestjs-worker" | "worker" | "nextjs" | "vite" | "node") {
            continue;
        }
        let prefix = if *product == main_product { String::new() } else { format!("{product}_") };
        let found = KEY_SUFFIXES.iter().map(|sfx| format!("{prefix}{}{sfx}", role_of(tech))).find(|k| all_keys.contains(k));
        match found {
            Some(k) => {
                s.per_env_image = rel.iter().any(|(env, m)| m.get(&k).is_some_and(|v| v.contains(&format!("-{env}-"))));
                if name_like(&s.label) && s.label.contains('-') {
                    s.image = Some(s.label.clone());
                }
                let sample = rel.iter().find_map(|(env, m)| m.get(&k).map(|v| (env.clone(), v.clone())));
                if let (Some(_), Some((env, v))) = (&s.image, sample) {
                    s.versions = Some(crate::manifest::Versions { source: "registry".into(), tag_format: guess_tag_format(&v, &env), ..Default::default() });
                }
                s.release_key = Some(k);
            }
            None => warnings.push(format!("{} ({product}): nenhuma chave de versão nos releases — preenche à mão", s.label)),
        }
    }

    // migrar/semear que correm o MESMO playbook do deploy também instalam a versão
    let recipe = |name: &str| targets.iter().find(|t| t.name == name).map(|t| t.recipe.join("\n")).unwrap_or_default();
    let playbook_in = |text: &str| text.split(|c: char| c.is_whitespace() || c == ',').find(|w| w.ends_with(".yml") || w.ends_with(".yaml")).map(String::from);
    for s in services.values_mut() {
        let first = |a: &Action| a.make.as_ref().map(|m| m.replace("{env}", a.envs.first().map(String::as_str).unwrap_or(env_ids.first().map(String::as_str).unwrap_or(""))));
        let Some(dp) = s.actions.get("deploy").and_then(first).and_then(|n| playbook_in(&recipe(&n))) else { continue };
        for k in ["migrate", "seed"] {
            if let Some(a) = s.actions.get_mut(k) {
                if first(a).is_some_and(|n| playbook_in(&recipe(&n)).as_deref() == Some(dp.as_str())) {
                    a.includes_deploy = true;
                }
            }
        }
    }

    // ambientes vazios nas listas = só os que existem; normaliza
    for s in services.values_mut() {
        for a in s.actions.values_mut() {
            a.envs.sort();
            a.envs.dedup();
            if a.envs.len() == env_ids.len() {
                a.envs.clear();
            }
        }
    }
    for o in ops.values_mut() {
        o.action.envs.sort();
        o.action.envs.dedup();
        if o.action.envs.len() == env_ids.len() {
            o.action.envs.clear();
        }
    }

    let products: Vec<Product> = product_order
        .iter()
        .map(|pid| {
            let (label, description) = product_meta.get(pid).cloned().unwrap_or_else(|| (capitalize(pid), String::new()));
            Product {
                id: pid.clone(),
                label,
                description,
                environments: vec![],
                placements: BTreeMap::new(),
                services: {
                    let mut v: Vec<Service> = service_order.iter().filter(|(p, _)| p == pid).map(|k| services[k].clone()).collect();
                    let rank = |k: &str| ["nestjs", "worker", "nextjs", "vite", "service", "nginx", "postgres", "mysql", "mongodb", "redis"].iter().position(|x| *x == k).unwrap_or(9);
                    v.sort_by_key(|s| rank(&s.kind));
                    v
                },
            }
        })
        .collect();

    let promotion = match (envs.iter().find(|e| e.color == "staging"), envs.iter().find(|e| e.color == "production")) {
        (Some(a), Some(b)) => vec![Promotion { from: a.id.clone(), to: b.id.clone() }],
        _ => vec![],
    };

    let total = targets.len();
    let services_found = products.iter().map(|p| p.services.len()).sum::<usize>();
    let compatible = total > 0 && services_found > 0 && matched * 10 >= total * 6;
    if total == 0 {
        warnings.push("não há Makefile com alvos".into());
    }

    let mut manifest = Manifest {
        schema: Some(manifest::SCHEMA.into()),
        version: 2,
        name: capitalize(&main_product),
        template: Some("makefile-convention".into()),
        environments: envs.clone(),
        promotion,
        registry: None::<Registry>,
        products,
        operations: op_order.iter().map(|id| ops[id].clone()).collect(),
        variables: vec![],
    };
    let variants = by_machine(root, &mut manifest, &sections);
    manifest.variables = detect_variables(root, &envs, &variants);

    Report { template: "makefile-convention".into(), compatible, matched, total, manifest, unmatched, warnings }
}

/// `(nome do host, ansible_host)` do primeiro host de um inventário INI.
fn inventory_host(root: &Path, inv: &str) -> Option<(String, String)> {
    let text = fs::read_to_string(root.join(inv)).ok()?;
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') || l.starts_with(';') || l.starts_with('[') {
            continue;
        }
        let name = l.split_whitespace().next()?.to_string();
        let addr = l.split_whitespace().find_map(|kv| kv.strip_prefix("ansible_host=")).unwrap_or(&name).to_string();
        return Some((name, addr));
    }
    None
}

/// Servidores são máquinas. Um inventário que aponta para a mesma máquina
/// que a staging ou a produção (o `saco-testes` na máquina da produção) não
/// é um servidor: passa a produto(s) desse servidor, com o seu inventário e
/// release (um placement), e as operações dele ficam no servidor com o
/// alvo já resolvido. Devolve variante → servidor.
fn by_machine(root: &Path, m: &mut Manifest, sections: &BTreeMap<String, (String, String)>) -> BTreeMap<String, String> {
    let all: Vec<String> = m.environments.iter().map(|e| e.id.clone()).collect();
    let host = |id: &str| m.environments.iter().find(|e| e.id == id).and_then(|e| inventory_host(root, &e.inventory)).map(|h| h.1);
    let servers: Vec<String> = m.environments.iter().filter(|e| e.color == "staging" || e.color == "production").map(|e| e.id.clone()).collect();
    let mut variants: BTreeMap<String, String> = BTreeMap::new();
    for e in &m.environments {
        if servers.contains(&e.id) {
            continue;
        }
        if let Some(h) = host(&e.id) {
            if let Some(s) = servers.iter().find(|s| host(s).as_deref() == Some(h.as_str())) {
                variants.insert(e.id.clone(), s.clone());
            }
        }
    }
    for (v, srv) in &variants {
        let venv = m.environments.iter().find(|e| &e.id == v).cloned().unwrap();
        let expand = |envs: &Vec<String>| if envs.is_empty() { all.clone() } else { envs.clone() };
        let mut extra_products = Vec::new();
        for p in m.products.iter_mut() {
            let mut vsvcs = Vec::new();
            for svc in p.services.iter_mut() {
                let mut vacts = BTreeMap::new();
                let mut drop = Vec::new();
                for (name, a) in svc.actions.iter_mut() {
                    let envs = expand(&a.envs);
                    if !envs.contains(v) {
                        continue;
                    }
                    vacts.insert(name.clone(), Action { make: a.make.clone(), playbook: a.playbook.clone(), envs: vec![v.clone()], includes_deploy: a.includes_deploy });
                    let rest: Vec<String> = envs.into_iter().filter(|e| e != v).collect();
                    if rest.is_empty() { drop.push(name.clone()) } else { a.envs = rest }
                }
                for d in drop {
                    svc.actions.remove(&d);
                }
                if !vacts.is_empty() {
                    let mut c = svc.clone();
                    c.actions = vacts;
                    vsvcs.push(c);
                }
            }
            p.services.retain(|s| !s.actions.is_empty());
            if !vsvcs.is_empty() {
                let desc = sections.get(&v.to_lowercase()).map(|x| x.1.clone()).unwrap_or_default();
                let mut placements = BTreeMap::new();
                placements.insert(srv.clone(), Placement { token: v.clone(), inventory: venv.inventory.clone(), release: venv.release.clone() });
                extra_products.push(Product {
                    id: format!("{}-{v}", p.id),
                    label: format!("{} {}", p.label, venv.label),
                    description: desc,
                    environments: vec![srv.clone()],
                    placements,
                    services: vsvcs,
                });
            }
        }
        m.products.retain(|p| !p.services.is_empty());
        m.products.extend(extra_products);

        let mut extra_ops = Vec::new();
        let mut gone = Vec::new();
        for o in m.operations.iter_mut() {
            let envs = expand(&o.action.envs);
            // sem `{env}` no alvo, a operação não é de nenhum ambiente
            if !envs.contains(v) || !o.action.make.as_deref().unwrap_or("").contains("{env}") {
                continue;
            }
            let mut baked = o.clone();
            baked.id = format!("{}-{v}", o.id);
            baked.label = format!("{} ({})", o.label, venv.label);
            baked.action.make = o.action.make.as_ref().map(|mk| mk.replace("{env}", v));
            baked.action.envs = vec![srv.clone()];
            extra_ops.push(baked);
            let rest: Vec<String> = envs.into_iter().filter(|e| e != v).collect();
            if rest.is_empty() { gone.push(o.id.clone()) } else { o.action.envs = rest }
        }
        m.operations.retain(|o| !gone.contains(&o.id));
        m.operations.extend(extra_ops);
        m.environments.retain(|e| &e.id != v);
        m.promotion.retain(|p| &p.from != v && &p.to != v);
    }
    // envs que cobrem todos os servidores que restam = em todos
    let left: BTreeSet<String> = m.environments.iter().map(|e| e.id.clone()).collect();
    let norm = |a: &mut Action| {
        let set: BTreeSet<String> = a.envs.iter().cloned().collect();
        if !a.envs.is_empty() && set == left {
            a.envs.clear();
        }
    };
    for p in m.products.iter_mut().filter(|p| p.placements.is_empty()) {
        for s in p.services.iter_mut() {
            for a in s.actions.values_mut() {
                norm(a);
            }
        }
    }
    for o in m.operations.iter_mut() {
        norm(&mut o.action);
    }
    variants
}

/// Nomes legíveis para o que vive no `notify.yml`:
/// `deploy_notify_enabled` → "Deploy notify", `vault_deploy_discord_webhook_url` → "Discord webhook".
fn notify_label(k: &str, key: &str, kind: &str) -> String {
    if kind == "secret" && key.contains("webhook") {
        let svc = ["discord", "slack", "teams", "telegram"].into_iter().find(|s| key.contains(s));
        return match svc { Some(s) => format!("{} webhook", capitalize(s)), None => "Webhook".into() };
    }
    humanize_key(k.trim_end_matches("_enabled"))
}

fn humanize_key(k: &str) -> String {
    capitalize(&k.replace('_', " "))
}

/// Variáveis que se ajustam na app: o `notify.yml` de cada máquina e as
/// flags `*_enabled` dos host_vars. Um valor `{{ vault_x }}` é um segredo:
/// a variável aponta para a chave `vault_x` no vault da mesma pasta.
fn detect_variables(root: &Path, envs: &[Environment], variants: &BTreeMap<String, String>) -> Vec<Variable> {
    let mut vars: BTreeMap<String, Variable> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for e in envs {
        let Some((hostname, _)) = inventory_host(root, &e.inventory) else { continue };
        let inv_dir = Path::new(&e.inventory).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let dir = format!("{inv_dir}/host_vars/{hostname}");
        if !root.join(&dir).is_dir() {
            continue;
        }
        let (server, suffix) = match variants.get(&e.id) {
            Some(s) => (s.clone(), Some(e.label.clone())),
            None => (e.id.clone(), None),
        };
        let mut files: Vec<String> = walkdir::WalkDir::new(root.join(&dir))
            .into_iter()
            .flatten()
            .filter(|f| f.file_type().is_file())
            .map(|f| f.path().strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"))
            .filter(|f| (f.ends_with(".yml") || f.ends_with(".yaml")) && !f.ends_with("/vault.yml"))
            .collect();
        files.sort();
        for f in files {
            let is_notify = f.ends_with("/notify.yml");
            let Ok(kv) = releases::read(root, &f) else { continue };
            for (k, v) in kv {
                let val = v.trim();
                let (kind, key, file) = if let Some(inner) = val.strip_prefix("{{").and_then(|x| x.strip_suffix("}}")) {
                    let vk = inner.trim();
                    let vault = format!("{dir}/vault.yml");
                    if !is_notify || !vk.starts_with("vault_") || !root.join(&vault).is_file() {
                        continue;
                    }
                    ("secret", vk.to_string(), vault)
                } else if val == "true" || val == "false" {
                    if !is_notify && !k.ends_with("_enabled") {
                        continue;
                    }
                    ("bool", k.clone(), f.clone())
                } else if is_notify {
                    ("text", k.clone(), f.clone())
                } else {
                    continue;
                };
                let id = match &suffix { Some(_) => format!("{k}@{}", e.id), None => k.clone() };
                // o grupo é o caminho dentro da pasta da máquina: `notify`, `saco-admin/nestjs`
                let group = f.trim_start_matches(&format!("{dir}/")).trim_end_matches(".yaml").trim_end_matches(".yml").to_string();
                let entry = vars.entry(id.clone()).or_insert_with(|| {
                    order.push(id.clone());
                    let base = if is_notify { notify_label(&k, &key, kind) } else { humanize_key(&k) };
                    Variable {
                        id: id.clone(),
                        label: match &suffix { Some(sfx) => format!("{base} ({sfx})"), None => base },
                        group,
                        kind: kind.into(),
                        key: key.clone(),
                        files: BTreeMap::new(),
                        category: is_notify.then(|| "notifications".to_string()),
                        target: suffix.as_ref().map(|_| e.id.clone()),
                    }
                });
                entry.files.insert(server.clone(), file);
            }
        }
    }
    order.into_iter().map(|id| vars.remove(&id).unwrap()).collect()
}

/// Sem Makefile: um serviço por playbook, corrido com o inventário e o
/// release do ambiente escolhido.
pub fn playbooks_only(root: &Path, lang: &str) -> Report {
    let envs = environments(root, lang);
    let scan = project::scan(root);
    let services: Vec<Service> = scan
        .files
        .iter()
        .filter(|f| f.kind == "playbook")
        .map(|f| {
            let stem = f.path.rsplit('/').next().unwrap_or(&f.path).trim_end_matches(".yml").trim_end_matches(".yaml");
            let mut actions = BTreeMap::new();
            actions.insert("deploy".into(), Action { make: None, playbook: Some(f.path.clone()), envs: vec![], includes_deploy: false });
            Service {
                id: stem.to_string(),
                label: stem.trim_start_matches(|c: char| c.is_ascii_digit() || c == '-' || c == '_').to_string(),
                kind: "service".into(),
                release_key: None,
                image: None,
                per_env_image: false,
                versions: None,
                container: None,
                description: None,
                actions,
            }
        })
        .collect();
    let n = services.len();
    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    Report {
        template: "playbooks".into(),
        compatible: n > 0 && !envs.is_empty(),
        matched: n,
        total: n,
        manifest: Manifest {
            schema: Some(manifest::SCHEMA.into()),
            version: 2,
            name: capitalize(name.trim_end_matches("-infra")),
            template: Some("playbooks".into()),
            promotion: vec![],
            environments: envs,
            registry: None,
            products: vec![Product { id: "playbooks".into(), label: "Playbooks".into(), description: String::new(), environments: vec![], placements: BTreeMap::new(), services }],
            operations: vec![],
            variables: vec![],
        },
        unmatched: vec![],
        warnings: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_from_the_right() {
        let envs: BTreeSet<String> = ["staging", "production", "testes"].iter().map(|s| s.to_string()).collect();
        let p = parse("run-migrations-edu-nestjs-production", &envs).unwrap();
        assert_eq!((p.verb, p.rest.as_str(), p.env.as_deref()), ("run-migrations", "edu-nestjs", Some("production")));
        assert_eq!(split_product_tech("shop-nestjs-worker"), Some(("shop".into(), "nestjs-worker")));
        assert_eq!(split_product_tech("backup"), None);
        let p = parse("ping-staging", &envs).unwrap();
        assert_eq!((p.verb, p.rest.as_str()), ("ping", ""));
        assert!(parse("help", &envs).is_none());
    }

    /// Projectos reais, só lidos. Imprime o resumo e confirma a forma.
    #[test]
    fn guesses_tag_formats() {
        assert_eq!(guess_tag_format("1.17.0-staging-4be19d2-0a41dcef", "staging").as_deref(), Some("{version}-{env}-{commit}-{build}"));
        assert_eq!(guess_tag_format("1.20.0-124d06b-c2e5b81f", "staging").as_deref(), Some("{version}-{commit}-{build}"));
        assert_eq!(guess_tag_format("v2.3.1", "staging").as_deref(), Some("v{version}"));
        assert_eq!(guess_tag_format("4be19d2a", "staging").as_deref(), Some("{commit}"));
        assert_eq!(guess_tag_format("latest", "staging"), None);
    }

    #[test]
    fn real_projects() {
        let Ok(roots) = std::env::var("ANSIBLE_MARIO_FIXTURES") else { return };
        for root in roots.split(':') {
            let root = Path::new(root);
            let r = makefile_convention(root, "pt");
            println!("\n== {} · {}/{} alvos · compatível: {}", root.display(), r.matched, r.total, r.compatible);
            for e in &r.manifest.environments {
                println!("  env {} ({}) inv={} rel={:?} prot={}", e.id, e.color, e.inventory, e.release, e.protected);
            }
            for p in &r.manifest.products {
                println!("  produto {} — {}", p.label, p.description);
                for s in &p.services {
                    println!("    {:<16} {:<8} key={:<16} img={:?} perEnv={} acções={:?}", s.label, s.kind, s.release_key.clone().unwrap_or("-".into()), s.image, s.per_env_image,
                        s.actions.iter().map(|(k, a)| format!("{k}{}{}", if a.envs.is_empty() { String::new() } else { format!("{:?}", a.envs) }, if a.includes_deploy { "+deploy" } else { "" })).collect::<Vec<_>>());
                    if let Some(v) = &s.versions { println!("      versões: {} {:?}", v.source, v.tag_format); }
                }
            }
            for o in &r.manifest.operations {
                println!("  op [{}] {} {:?}{}", o.group, o.id, o.action.envs, if o.destructive { " ⚠ destrutiva" } else { "" });
            }
            for v in &r.manifest.variables {
                println!("  var [{}] {} ({}) {} → {:?}", v.group, v.id, v.kind, v.key, v.files);
            }
            println!("  fora: {:?}", r.unmatched);
            println!("  avisos: {:?}", r.warnings);
            assert!(r.compatible);
            let targets: BTreeSet<String> = project::make_targets(root).into_iter().map(|t| t.name).collect();
            let problems = manifest::validate(root, &r.manifest, &targets);
            assert!(problems.is_empty(), "{problems:?}");
        }
    }
}
