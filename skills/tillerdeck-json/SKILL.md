---
name: tillerdeck-json
description: Write or update the tillerdeck.json of an Ansible project (servers, products, services, buttons, operations, variables, version sources) by reading its Makefile, inventories and releases. Use when someone wants their infra repo to open in Tillerdeck, or asks to fix, extend or validate that file.
---

# tillerdeck.json for an Ansible project

[Tillerdeck](https://github.com/mariocosttaa/tillerdeck) is a desktop app that runs a project's own
Makefile targets and playbooks behind buttons. It reads a single file at the root of the infra repo:
`tillerdeck.json`. This skill writes that file **from what the repository actually has**.

The app detects a first version itself when a project has no file: from the Makefile convention and
from the playbooks, roles and containers (Settings → Detect again re-runs it). Use this skill when the
detection got parts wrong, to group products the way the owner thinks of them, or to add what it can't
guess (labels, descriptions, version sources, variables).

## Rules

- **Read, never invent.** Every `make` value must be a real target (`make -qp` or the Makefile), every
  `playbook` a real file, every `inventory`/`release`/variable `files` path a file that exists. If
  something isn't there, leave it out and say so.
- **Don't run anything against servers.** Listing targets (`make -qp`, `grep`), reading YAML and
  `ansible-inventory --list` are fine. Deploys, playbooks and `make <target>` are not.
- **Never print vault contents.** A secret variable only needs the vault key name.
- **Keep what the owner wrote.** If the file exists, change only what was asked, and keep their
  labels, descriptions and order.
- Validate before you finish (see the end).

## 1. Look at the project

```bash
ls; ls inventories releases playbooks host_vars group_vars 2>/dev/null
grep -E '^[a-zA-Z0-9_.-]+:' Makefile | cut -d: -f1 | sort -u      # targets
grep -nE '^[a-zA-Z0-9_.-]+:.*##' Makefile                          # targets with descriptions
cat releases/*.yml 2>/dev/null                                     # version keys (not vault files)
grep -rn 'callbacks_enabled' ansible.cfg 2>/dev/null
```

Note per target: which playbook its recipe runs, which `-e` extra vars it passes, and whether it asks
for confirmation (a `read` that `CONFIRM=yes` skips).

## 2. Servers (`environments`)

One entry per **machine/server**, not per variant. An environment is an inventory plus, optionally,
a release file:

```json
{ "id": "production", "label": "Production", "inventory": "inventories/production.ini",
  "release": "releases/production.yml", "color": "production", "protected": true }
```

- `id` replaces `{env}` in targets and is the word typed to confirm a protected run.
- `color`: `staging`, `production`, `testes` or `neutral`. Mark production `protected: true`.
- Two inventories pointing at the same `ansible_host` (a `testes` stack on the production box) are
  **one server**. The variant becomes a product with a placement (step 3).
- `promotion`: `[{ "from": "staging", "to": "production" }]` when staging feeds production.

## 3. Products and services

A product is an application the owner thinks of as one thing ("Shop", "Shop Admin"). Services are
its parts (API, worker, web app, nginx, postgres, redis).

```json
{
  "id": "shop", "label": "Shop", "description": "the customer app",
  "environments": ["staging", "production"],
  "services": [
    { "id": "api", "label": "shop-api", "kind": "nestjs", "releaseKey": "api_tag",
      "image": "shop-api", "container": "shop-api",
      "versions": { "source": "registry", "tagFormat": "{version}-{commit}-{build}" },
      "actions": {
        "deploy":  { "make": "deploy-shop-nestjs-{env}" },
        "migrate": { "make": "run-migrations-shop-nestjs-{env}", "includesDeploy": true },
        "maintenanceOn":  { "make": "maintenance-on-shop-nestjs-{env}" },
        "maintenanceOff": { "make": "maintenance-off-shop-nestjs-{env}" }
      } }
  ]
}
```

- `kind`: `nestjs`, `worker`, `nextjs`, `vite`, `node`, `nginx`, `postgres`, `redis`, `mysql`,
  `mongodb` or `service`. It only picks the icon.
- `environments`: the servers where the product exists. Leave it out if it exists on all.
- `placements`: a product that lives on another product's server, with its own `{env}` token,
  inventory and release:
  `"environments": ["production"], "placements": { "production": { "token": "testes", "inventory": "inventories/testes.ini", "release": "releases/testes.yml" } }`.
- `actions` keys: `deploy`, `migrate`, `seed`, `maintenanceOn`, `maintenanceOff`. Each is
  `{ "make": "target-with-{env}" }` or `{ "playbook": "playbooks/x.yml" }` (run with the server's
  inventory and release). Add `"envs": ["staging"]` when the target only exists for some servers.
- `includesDeploy: true` on `migrate`/`seed` when its recipe runs **the same playbook as the deploy**
  (for example `-e run_migrations=true`). Then "Deploy + migrations" runs only that target. Without it,
  the app runs the deploy, then the migration.
- `releaseKey`: the line in `releases/<env>.yml` with this service's version (`api_tag`,
  `admin_app_tag`, `web_commit`…). Without it, the service has no version and no version picker.
- `perEnvImage: true` when the tag carries the environment (`1.4.0-staging-ab12cd3-…`). Promoting then
  asks the registry for the target environment's tag of the same commit.

### Version sources (`versions`)

What the deploy dialog and the Builds page offer:

| `source` | Lists | Needs |
| --- | --- | --- |
| `registry` | the image's tags, newest first, with date, size and OCI labels | top-level `"registry": { "url": "https://registry.example.com" }`, `image`, `docker login` on the machine |
| `git` | recent commits of a local repo (`repo`: `"../shop-api"`, optional `branch`; `commitFormat`: `short` or `full`) | the repo checked out next to the infra repo |
| `none` | nothing: deploys use the release value | — |

`tagFormat` uses `{version}`, `{env}`, `{commit}` and `{build}`. Derive it from a real value in the
release file: `1.20.0-124d06b-c2e5b81f` → `{version}-{commit}-{build}`;
`1.17.0-staging-4be19d2-0a41dcef` → `{version}-{env}-{commit}-{build}`; `v2.3.1` → `v{version}`.
Tags that don't match are hidden, so check the format against two or three real values.

## 4. Operations

Everything that isn't a service button: backups, provisioning, observability, checks.

```json
{ "id": "restore", "label": "Restore", "group": "backup", "description": "restores the latest snapshot",
  "action": { "make": "restore-{env}" }, "destructive": true }
```

`group`: `machine`, `backup`, `observability`, `verify`, `maintenance` or `other`. Set
`destructive: true` for anything that deletes or overwrites data (restore, reset, drop). The app then
asks for the typed word on every server.

## 5. Variables (notifications, feature flags)

Settings the app can edit in place, in plain YAML files (one line at column 0) or in the vault:

```json
{ "id": "deploy_notify", "label": "Deploy notifications", "group": "Discord", "kind": "bool",
  "key": "deploy_notify_enabled",
  "files": { "staging": "host_vars/shop-staging/notify.yml", "production": "host_vars/shop-prod/notify.yml" } }
```

- `kind`: `bool`, `text` or `secret`. For `secret`, `key` is the **vault key** (`vault_discord_webhook`)
  and `files` points at the vault file. The app writes it through `ansible-vault` and never displays it.
- Only use keys that already exist in those files.

## 6. File skeleton

```json
{
  "$schema": "https://raw.githubusercontent.com/mariocosttaa/tillerdeck/main/schema/v2.json",
  "version": 2,
  "name": "Shop",
  "template": "auto",
  "environments": [],
  "promotion": [],
  "registry": { "url": "https://registry.example.com" },
  "products": [],
  "operations": [],
  "variables": []
}
```

## 7. Validate

```bash
npx -y ajv-cli@5.0.0 validate --spec=draft2020 \
  -s <(curl -s https://raw.githubusercontent.com/mariocosttaa/tillerdeck/main/schema/v2.json) \
  -d tillerdeck.json
# every make target in the file exists:
grep -o '"make": *"[^"]*"' tillerdeck.json | cut -d'"' -f4 | sort -u
```

Expand `{env}` for each server or placement token and check every target with `make -n <target>`
(dry run, it doesn't execute). Then open the project in the app: **Settings** lists anything that
drifted (a missing target, file or key).

Report what you wrote, what you left out and why, and anything the owner should check (labels,
`includesDeploy`, `tagFormat`, `destructive`).

## Installing this skill

Copy this folder to `.claude/skills/tillerdeck-json/` in the infra repo (shared with the team) or to
`~/.claude/skills/tillerdeck-json/` (for you only). Other agents can read it as plain instructions.
