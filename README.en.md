# dsh-plugin-snapshot

**Pre-upgrade snapshots, one-step rollback and a static health check for DeepSeek Harness plugins.**

One plugin, three tools.

- npm: https://www.npmjs.com/package/dsh-plugin-snapshot
- repo: https://github.com/Uesccda/dsh-plugin-snapshot
- compatible with DSH 0.2.0+ (tested on 0.2.2-rc.1)

---

## What problem it solves

| The trouble you hit | What this does |
| --- | --- |
| A plugin upgrade fails halfway: manifests changed, dependencies not installed, unknown state | Takes a snapshot with fingerprint and hashes before upgrading, so you can always go back |
| Dozens of plugins installed, no idea which collide or whose compatibility claim is stale | One scan reports installed / enabled / missing / incompatible / untested, plus a review priority |
| No idea which plugins have newer versions, and afraid of auto-upgrading to a beta | Lists updatable items and marks prereleases separately instead of mixing them in |

It deliberately does **not** install, remove or toggle plugins: that is what the built-in plugin_manager is for. Two implementations fighting over the same profile is the most common source of breakage in this ecosystem.

---

## The three tools

| Tool | Does | Writes |
| --- | --- | --- |
| plugin_snapshot | create / list / restore snapshots of the profile manifests | only its own data dir, plus the three manifests on restore |
| plugin_doctor | static diagnostic: install state, author-declared compatibility, duplicate patch ids, missing packages | read-only |
| plugin_updates | compares the version resolved in pnpm-lock.yaml against the registry | read-only |

---

## Usage

Just talk to the model:

- "Take a snapshot before upgrading my plugins"
- "Check my installed plugins for problems"
- "Which plugins have updates available?"
- "That upgrade failed, roll back to before it"

---

## Install

    dsh plugin add dsh-plugin-snapshot

Restart DSH afterwards. Remove with:

    dsh plugin remove dsh-plugin-snapshot

---

## What a snapshot contains

The three profile manifests (package.json, pnpm-lock.yaml, pnpm-workspace.yaml) plus a manifest.json recording the profile fingerprint, creation time, per-file existence and sha256.

Restoring verifies the fingerprint first, so a snapshot from another profile is rejected. A hash mismatch only warns, because you may have edited the manifest by hand.

Snapshots do **not** include node_modules. Dependencies must be reinstalled after a restore.

---

## Where data lives

    ~/.dsh-plugin-snapshot/snapshots/<timestamp>/
    ~/.dsh-plugin-snapshot/logs/

Nothing else is written except the three profile manifests on restore.

---

## Limitations

- Snapshots cover the three manifests only, not node_modules
- Diagnostics are static evidence, not runtime verification
- No scheduler: the plugin only exists while DSH runs

---

## License

MIT

