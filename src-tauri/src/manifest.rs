//! O `ansible-mario.json`: a descrição de um projecto que a app usa para
//! mostrar serviços, promoção, backups e máquina com botões.
//!
//! Vive na raiz do repositório de infra, ao lado do `ansible.cfg`, e vai com
//! ele para o git — a equipa vê o mesmo. A app só o escreve quando alguém
//! carrega em "Aplicar template" ou em "Guardar" nas Definições.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

pub const FILE: &str = "ansible-mario.json";
pub const SCHEMA: &str = "https://raw.githubusercontent.com/mariocosttaa/ansible-mario/main/schema/v2.json";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default = "two")]
    pub version: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    pub environments: Vec<Environment>,
    #[serde(default)]
    pub promotion: Vec<Promotion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry: Option<Registry>,
    #[serde(default)]
    pub products: Vec<Product>,
    #[serde(default)]
    pub operations: Vec<Operation>,
}

fn two() -> u32 {
    2
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub label: String,
    pub inventory: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release: Option<String>,
    /// staging · production · testes · neutral — o tom da cor na interface
    #[serde(default = "neutral")]
    pub color: String,
    #[serde(default)]
    pub protected: bool,
}

fn neutral() -> String {
    "neutral".into()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Promotion {
    pub from: String,
    pub to: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
    pub services: Vec<Service>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: String,
    pub label: String,
    /// nestjs · worker · nextjs · vite · nginx · postgres · redis · service
    pub kind: String,
    /// A chave nos releases/<env>.yml com a versão deste serviço.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_key: Option<String>,
    /// Nome da imagem no registry, para encontrar tags.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// A tag traz o ambiente (`-staging-`): promover não é copiar.
    #[serde(default)]
    pub per_env_image: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    /// Uma linha para quem lê: "a fila de emails".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// deploy · migrate · seed · maintenanceOn · maintenanceOff
    #[serde(default)]
    pub actions: BTreeMap<String, Action>,
}

/// Uma acção corre um alvo do make (com `{env}` no nome) ou um playbook.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub make: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playbook: Option<String>,
    /// Os ambientes onde a acção existe. Vazio = em todos.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub envs: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    pub label: String,
    /// machine · backup · observability · verify · maintenance · other
    pub group: String,
    #[serde(default)]
    pub description: String,
    pub action: Action,
    /// Apaga ou repõe dados: pede a palavra mesmo fora da produção.
    #[serde(default)]
    pub destructive: bool,
}

pub fn load(root: &Path) -> Result<Option<Manifest>, String> {
    let p = root.join(FILE);
    if !p.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map(Some).map_err(|e| format!("{FILE}: {e}"))
}

pub fn save(root: &Path, m: &Manifest) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    text.push('\n');
    let tmp = root.join(format!(".{FILE}.tmp"));
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, root.join(FILE)).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Validação: o manifesto pode ficar para trás do Makefile.
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub path: String,
    pub message: String,
}

/// Resolve `{env}` e confirma que o alvo existe. Um botão cujo alvo
/// desapareceu do Makefile tem de aparecer desligado, não falhar ao clicar.
pub fn resolve_target(action: &Action, env: &str) -> Option<String> {
    action.make.as_ref().map(|m| m.replace("{env}", env))
}

pub fn validate(root: &Path, m: &Manifest, targets: &BTreeSet<String>) -> Vec<Problem> {
    let mut out = Vec::new();
    let env_ids: BTreeSet<&str> = m.environments.iter().map(|e| e.id.as_str()).collect();
    for e in &m.environments {
        if !root.join(&e.inventory).is_file() {
            out.push(Problem { path: format!("environments.{}", e.id), message: format!("o inventário {} não existe", e.inventory) });
        }
        if let Some(r) = &e.release {
            if !root.join(r).is_file() {
                out.push(Problem { path: format!("environments.{}", e.id), message: format!("o release {r} não existe") });
            }
        }
    }
    for p in &m.promotion {
        if !env_ids.contains(p.from.as_str()) || !env_ids.contains(p.to.as_str()) {
            out.push(Problem { path: "promotion".into(), message: format!("{} → {}: ambiente desconhecido", p.from, p.to) });
        }
    }
    let check = |path: String, a: &Action, out: &mut Vec<Problem>| {
        if a.make.is_some() {
            let envs: Vec<&str> = if a.envs.is_empty() { env_ids.iter().copied().collect() } else { a.envs.iter().map(|s| s.as_str()).collect() };
            let has_env = a.make.as_ref().unwrap().contains("{env}");
            let probe: Vec<String> = if has_env { envs.iter().map(|e| resolve_target(a, e).unwrap()).collect() } else { vec![a.make.clone().unwrap()] };
            for t in probe {
                let name = t.split_whitespace().next().unwrap_or("").to_string();
                if !targets.contains(&name) {
                    out.push(Problem { path: path.clone(), message: format!("o alvo `{name}` não existe no Makefile") });
                }
            }
        } else if let Some(pb) = &a.playbook {
            if !root.join(pb).is_file() {
                out.push(Problem { path: path.clone(), message: format!("o playbook {pb} não existe") });
            }
        } else {
            out.push(Problem { path, message: "acção sem make nem playbook".into() });
        }
    };
    for p in &m.products {
        for s in &p.services {
            for (name, a) in &s.actions {
                check(format!("products.{}.{}.{name}", p.id, s.id), a, &mut out);
            }
        }
    }
    for o in &m.operations {
        check(format!("operations.{}", o.id), &o.action, &mut out);
    }
    out
}
