# `tillerdeck.json` reference

Tillerdeck reads one file at the root of your infra repository: `tillerdeck.json`. It says which servers you have, which products live on them, which Makefile target or playbook each button runs, and what the app may edit for you.

You rarely write it from scratch:

- **No file yet?** The app detects it from the project (the Makefile, and the playbooks, roles and containers themselves) and opens with it, in memory. A review shows each item with where it came from: untick, rename, **Accept and save**.
- **Change anything later** in **Settings**: forms for servers, products, buttons, operations, version sources and variables, plus a JSON tab. **Detect again** proposes only what's new and adds it without touching your edits.
- **Let an agent do it:** [`skills/tillerdeck-json`](../skills/tillerdeck-json/SKILL.md).

The JSON schema is [`schema/v2.json`](../schema/v2.json). Add `"$schema"` to the file to get autocomplete and validation in your editor:

```bash
npx -y ajv-cli@5.0.0 validate --spec=draft2020 -s schema/v2.json -d tillerdeck.json
```

## A complete example

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/mariocosttaa/tillerdeck/main/schema/v2.json",
  "version": 2,
  "name": "Shop",
  "template": "auto",

  // Servers. `id` replaces {env} in targets and is the word typed to confirm protected runs.
  "environments": [
    { "id": "staging",    "label": "Staging",    "inventory": "inventories/staging.ini",    "release": "releases/staging.yml",    "color": "staging" },
    { "id": "production", "label": "Production", "inventory": "inventories/production.ini", "release": "releases/production.yml", "color": "production", "protected": true }
  ],
  "promotion": [{ "from": "staging", "to": "production" }],
  "registry": { "url": "https://registry.example.com" },

  "products": [
    {
      "id": "shop", "label": "Shop", "description": "the customer app",
      "services": [
        {
          "id": "api", "label": "shop-api", "kind": "nestjs",
          "releaseKey": "api_tag", "image": "shop-api", "container": "shop-api",
          "versions": { "source": "registry", "tagFormat": "{version}-{commit}-{build}" },
          "actions": {
            "deploy":         { "make": "deploy-shop-nestjs-{env}" },
            "migrate":        { "make": "run-migrations-shop-nestjs-{env}", "includesDeploy": true },
            "seed":           { "make": "run-seed-shop-nestjs-{env}", "includesDeploy": true },
            "maintenanceOn":  { "make": "maintenance-on-shop-nestjs-{env}" },
            "maintenanceOff": { "make": "maintenance-off-shop-nestjs-{env}" }
          }
        },
        {
          "id": "app", "label": "shop-web", "kind": "nextjs",
          "releaseKey": "app_tag", "image": "shop-web", "perEnvImage": true,
          "versions": { "source": "registry", "tagFormat": "{version}-{env}-{commit}-{build}" },
          "actions": { "deploy": { "make": "deploy-shop-nextjs-{env}" } }
        },
        { "id": "postgres", "label": "Postgres", "kind": "postgres", "actions": { "deploy": { "make": "deploy-shop-postgres-{env}" } } }
      ]
    },
    {
      // A test stack that lives on the production machine, with its own token, inventory and release.
      "id": "shop-testes", "label": "Shop Testes",
      "environments": ["production"],
      "placements": { "production": { "token": "testes", "inventory": "inventories/testes.ini", "release": "releases/testes.yml" } },
      "services": [
        { "id": "api", "label": "shop-api", "kind": "nestjs", "releaseKey": "api_tag",
          "actions": { "deploy": { "make": "deploy-shop-nestjs-{env}", "envs": ["testes"] } } }
      ]
    }
  ],

  "operations": [
    { "id": "restore", "label": "Restore", "group": "backup", "description": "restores the latest snapshot",
      "action": { "make": "restore-{env}" }, "destructive": true },
    { "id": "provision-system", "label": "Provision system", "group": "machine", "action": { "make": "provision-system-{env}" } }
  ],

  "variables": [
    { "id": "deploy_notify_enabled", "label": "Deploy notify", "group": "notify", "kind": "bool",
      "key": "deploy_notify_enabled", "category": "notifications",
      "files": { "staging": "inventories/host_vars/shop-staging/notify.yml", "production": "inventories/host_vars/shop-prod/notify.yml" } },
    { "id": "deploy_notify_webhook", "label": "Discord webhook", "group": "notify", "kind": "secret",
      "key": "vault_deploy_discord_webhook_url", "category": "notifications",
      "files": { "staging": "inventories/host_vars/shop-staging/vault.yml", "production": "inventories/host_vars/shop-prod/vault.yml" } }
  ]
}
```

## Fields

### Top level

| Field | Meaning |
| --- | --- |
| `version` | Always `2`. |
| `name` | Shown in the app. |
| `template` | How the file was first made: `auto` (detected), `makefile-convention` or `playbooks`. Informative only. |
| `environments` | The **servers** (below). |
| `promotion` | `[{ "from", "to" }]`: enables the Promote page and the *Ready to promote* status. |
| `registry` | `{ "url" }`: the Docker registry used for builds and per-environment tags. Credentials come from `docker login` (config.json or the macOS Keychain) and never go in this file. |
| `products`, `operations`, `variables` | Below. |

### `environments[]` (servers)

| Field | Meaning |
| --- | --- |
| `id` | Replaces `{env}` in targets. It is also the word typed to confirm a protected run. |
| `label` | Shown in the top bar. |
| `inventory` | Path from the project root. |
| `release` | `releases/<env>.yml` with one version per service. Optional. |
| `color` | `staging`, `production`, `testes` or `neutral`. |
| `protected` | Every action on this server asks you to type its id. |

### `products[]`

| Field | Meaning |
| --- | --- |
| `id`, `label`, `description` | How the product appears. |
| `environments` | The servers where it exists. Leave it out if it exists on all of them. |
| `placements` | `{ "<server id>": { "token", "inventory", "release" } }`: the product runs on that server with its own `{env}` token, inventory and release. |
| `services` | Below. |

### `services[]`

| Field | Meaning |
| --- | --- |
| `kind` | `nestjs`, `worker`, `nextjs`, `vite`, `node`, `nginx`, `postgres`, `redis`, `mysql`, `mongodb` or `service`. It picks the icon and whether the service counts as an app or as infra. |
| `releaseKey` | The line in the release file with this service's version. Without it, the service has no version and no version picker. |
| `image` | The image name in the registry. |
| `perEnvImage` | The tag carries the environment (`1.4.0-staging-…`). Promoting then looks up the target environment's tag of the same commit, and each server only lists its own tags. |
| `container` | Shown in the inspector. |
| `versions` | Where the deploy dialog and the Builds page get versions from (below). |
| `actions` | `deploy`, `migrate`, `seed`, `maintenanceOn`, `maintenanceOff` (below). |

### `actions` (and `operations[].action`)

| Field | Meaning |
| --- | --- |
| `make` | A Makefile target. `{env}` is replaced by the server id or placement token. |
| `playbook` | Instead of `make`: the playbook, run with the server's inventory and release as extra vars. |
| `envs` | Where the action exists. Empty means everywhere. A missing target is shown disabled. |
| `includesDeploy` | On `migrate` / `seed`: the target re-runs the deploy (for example the same playbook with `-e run_migrations=true`), so *Deploy + migrations* runs only this target. Without it, the app runs the deploy and then the migration. |

### `versions`

| `source` | Lists | Writes to the release |
| --- | --- | --- |
| `registry` | The image's tags, newest first, with date, size and commit from the OCI labels. Only tags matching `tagFormat` are listed. | The tag. |
| `git` | Recent commits of a local checkout (`repo`, relative to the project, for example `../shop-api`; optional `branch`, for example `origin/main`). | The commit: `commitFormat` `short` (7 characters) or `full`. |
| `none` | Nothing. Deploys use the value already in the release. | — |

`tagFormat` uses `{version}`, `{env}`, `{commit}` and `{build}`, for example `{version}-{commit}-{build}`, `{version}-{env}-{commit}-{build}` or `v{version}`. `limit` sets how many versions to show (default 20).

### `operations[]`

`group` is `machine`, `backup`, `observability`, `verify`, `maintenance` or `other`, and decides where the operation appears (Backups, Machine). Set `destructive: true` on restores, resets and anything else that deletes data: the app then asks for the typed word on every server.

### `variables[]`

Values the app edits in place in your YAML files. It rewrites one line at column 0 and keeps your comments.

| Field | Meaning |
| --- | --- |
| `kind` | `bool` (a switch), `text` or `secret`. |
| `key` | The YAML key. For a `secret`, the **vault key**: it is written encrypted through `ansible-vault` and never displayed. |
| `files` | Server id → the file holding the key. |
| `group` | How variables are grouped in Settings → Variables. |
| `category` | `notifications` to show the variable on the Notifications screen. |
| `target` | A placement token (`testes`) when the variable belongs to a product on another server. |

## What stays on your computer

Some choices are personal and never go into the file: language, theme, refresh interval, and what happens to release files after a deploy (nothing, commit, or commit and push to a chosen branch). They live in **Settings → Preferences** and **Settings → Git**.
