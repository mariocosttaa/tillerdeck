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

use crate::manifest::{self, Action, Environment, Manifest, Operation, Product, Promotion, Registry, Service};
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

fn env_meta(id: &str) -> (String, String, bool) {
    let l = id.to_lowercase();
    if l.contains("prod") {
        ("Produção".into(), "production".into(), true)
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

/// O nome de uma operação em português: o verbo traduzido e o resto com
/// os nomes conhecidos (`provision-security` → `Provisionar segurança`).
fn op_label(verb: &str, rest: &str) -> String {
    let v = match verb {
        "provision" => "Provisionar",
        "deploy" => "Instalar",
        "restore" => "Restaurar",
        "restore-upload" => "Restaurar de ficheiros deste computador",
        "restore-local" => "Restaurar de ficheiros na máquina",
        "snapshots" => "Listar os snapshots",
        "ping" => "Ping",
        "status" => "Estado dos containers",
        "logs" => "Logs de um container",
        "history" => "Diário de deploys",
        "audit-security" => "Auditoria de segurança",
        "test" => "Testar",
        "reset" => "Repor",
        "run-migrations" => "Migrar",
        "run-seed" => "Semear",
        "maintenance-on" => "Fechar",
        "maintenance-off" => "Reabrir",
        other => return capitalize(&format!("{other} {rest}").replace('-', " ").trim().to_string()),
    };
    let r = match rest {
        "" => "",
        "system" => "sistema",
        "security" => "segurança",
        "maintenance" => "manutenção",
        "platform" => "plataforma",
        "dbgate" => "DbGate",
        "netdata" => "Netdata",
        "kuma-push" => "Kuma",
        "beszel" => "Beszel",
        "local" => "deste computador",
        other => other,
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
fn environments(root: &Path) -> Vec<Environment> {
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
            let (label, color, protected) = env_meta(stem);
            let release = ["yml", "yaml"].iter().map(|x| format!("releases/{stem}.{x}")).find(|r| root.join(r).is_file());
            envs.push(Environment { id: stem.to_string(), label, inventory: format!("{dir}/{file}"), release, color, protected });
        }
    }
    envs.sort_by(|a, b| (env_rank(&a.color), &a.id).cmp(&(env_rank(&b.color), &b.id)));
    envs
}

pub fn makefile_convention(root: &Path) -> Report {
    let project_name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let main_product = project_name.trim_end_matches("-infra").trim_end_matches("-ansible").to_string();
    let envs = environments(root);
    let env_ids: BTreeSet<String> = envs.iter().map(|e| e.id.clone()).collect();
    let targets: Vec<MakeTarget> = project::make_targets(root);
    let mut warnings = Vec::new();

    let rel = release_keys(root, &envs);
    let all_keys: BTreeSet<String> = rel.values().flat_map(|m| m.keys().cloned()).collect();

    // product → (label, description), pela secção `##@ produto · descrição`
    let mut product_meta: BTreeMap<String, (String, String)> = BTreeMap::new();
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
            });
            entry.envs.extend(env_list);
        } else {
            let id = if p.rest.is_empty() { p.verb.to_string() } else { format!("{}-{}", p.verb, p.rest) };
            let o = ops.entry(id.clone()).or_insert_with(|| {
                op_order.push(id.clone());
                Operation {
                    id: id.clone(),
                    label: op_label(p.verb, &p.rest),
                    group: op_group(&id, p.verb, &t.section).to_string(),
                    description: t.description.clone(),
                    action: Action {
                        make: Some(if p.env.is_some() { format!("{id}-{{env}}") } else { id.clone() }),
                        playbook: None,
                        envs: vec![],
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
                s.release_key = Some(k);
            }
            None => warnings.push(format!("{} ({product}): nenhuma chave de versão nos releases — preenche à mão", s.label)),
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

    Report {
        template: "makefile-convention".into(),
        compatible,
        matched,
        total,
        manifest: Manifest {
            schema: Some(manifest::SCHEMA.into()),
            version: 2,
            name: capitalize(&main_product),
            template: Some("makefile-convention".into()),
            environments: envs,
            promotion,
            registry: None::<Registry>,
            products,
            operations: op_order.iter().map(|id| ops[id].clone()).collect(),
        },
        unmatched,
        warnings,
    }
}

/// Sem Makefile: um serviço por playbook, corrido com o inventário e o
/// release do ambiente escolhido.
pub fn playbooks_only(root: &Path) -> Report {
    let envs = environments(root);
    let scan = project::scan(root);
    let services: Vec<Service> = scan
        .files
        .iter()
        .filter(|f| f.kind == "playbook")
        .map(|f| {
            let stem = f.path.rsplit('/').next().unwrap_or(&f.path).trim_end_matches(".yml").trim_end_matches(".yaml");
            let mut actions = BTreeMap::new();
            actions.insert("deploy".into(), Action { make: None, playbook: Some(f.path.clone()), envs: vec![] });
            Service {
                id: stem.to_string(),
                label: stem.trim_start_matches(|c: char| c.is_ascii_digit() || c == '-' || c == '_').to_string(),
                kind: "service".into(),
                release_key: None,
                image: None,
                per_env_image: false,
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
            products: vec![Product { id: "playbooks".into(), label: "Playbooks".into(), description: String::new(), services }],
            operations: vec![],
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
    fn real_projects() {
        let Ok(roots) = std::env::var("ANSIBLE_MARIO_FIXTURES") else { return };
        for root in roots.split(':') {
            let root = Path::new(root);
            let r = makefile_convention(root);
            println!("\n== {} · {}/{} alvos · compatível: {}", root.display(), r.matched, r.total, r.compatible);
            for e in &r.manifest.environments {
                println!("  env {} ({}) inv={} rel={:?} prot={}", e.id, e.color, e.inventory, e.release, e.protected);
            }
            for p in &r.manifest.products {
                println!("  produto {} — {}", p.label, p.description);
                for s in &p.services {
                    println!("    {:<16} {:<8} key={:<16} img={:?} perEnv={} acções={:?}", s.label, s.kind, s.release_key.clone().unwrap_or("-".into()), s.image, s.per_env_image,
                        s.actions.iter().map(|(k, a)| format!("{k}{}", if a.envs.is_empty() { String::new() } else { format!("{:?}", a.envs) })).collect::<Vec<_>>());
                }
            }
            for o in &r.manifest.operations {
                println!("  op [{}] {} {:?}{}", o.group, o.id, o.action.envs, if o.destructive { " ⚠ destrutiva" } else { "" });
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
