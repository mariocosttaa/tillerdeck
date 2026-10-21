# Notes for coding agents

## Writing `tillerdeck.json` for someone's Ansible project

Follow [`skills/tillerdeck-json/SKILL.md`](skills/tillerdeck-json/SKILL.md). The short version:

- Read the Makefile, inventories and releases.
- Never invent a target or a file.
- Never run anything against servers.
- Never print vault contents.
- Validate the result against [`schema/v2.json`](schema/v2.json).

The full field reference is [`docs/configuration.md`](docs/configuration.md).

## Working on this repository

| Path | What |
| --- | --- |
| `src-tauri/src/` | Rust: the manifest model and validation (`manifest.rs`), templates (`template.rs`), release rewrites (`releases.rs`), registry (`registry.rs`), git and inventory reads (`ops.rs`), runs (`runner.rs`), Tauri commands (`lib.rs`). |
| `src/v2/` | The React app: pages, the deploy dialog, git preferences, and the English/Portuguese strings (`pt.ts`, keyed by the English text). |
| `src/legacy/` | The v1 editor, now the *Files* page. |
| `examples/demo-infra` | A demo project that runs against localhost. Use it for screenshots and manual tests. |

```bash
npm install
npm run tauri dev                      # run the app
npx tsc --noEmit -p .                  # type-check the UI
cd src-tauri && cargo test --lib       # Rust tests (templates, releases, registry parsing, git, vault, runs)
```

Rules the code follows:

- **The app never connects to servers by itself.** Everything runs through the project's own `make` or `ansible-playbook`, started by a person.
- **Release files are rewritten line by line,** keeping comments. A failed deploy puts the line back.
- **Secrets are only handled in memory** and through `ansible-vault`.
- **New UI text is written in English** and gets a Portuguese entry in `src/v2/pt.ts`.
- **Commits use Conventional Commits** (`feat(ui): …`, `fix(git): …`).
