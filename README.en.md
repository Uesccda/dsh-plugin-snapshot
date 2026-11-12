# dsh-plugin-snapshot

**Checks and upgrades your installed DSH plugins automatically — a snapshot before every upgrade, automatic rollback on failure, plus one-click rollback and a static health check.**

One plugin = automatic upgrades + three tools + a Settings panel.

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

![Settings panel preview](https://cdn.jsdelivr.net/gh/Uesccda/dsh-plugin-snapshot@main/docs/panel-preview.svg)

> Structural preview of the panel (Settings → Plugin Updates). Not a screenshot.
## The three tools

| Tool | Does | Writes |
| --- | --- | --- |
| plugin_snapshot | create / list / restore snapshots of the profile manifests | only its own data dir, plus the three manifests on restore |
| plugin_doctor | static diagnostic: install state, author-declared compatibility, duplicate patch ids, missing packages | read-only |
| plugin_updates | compares the version resolved in pnpm-lock.yaml against the registry | read-only |

---

## Settings panel

After install, **Settings → Plugin Updates** shows a three-tab panel:

| Tab | Contents | Writes |
| --- | --- | --- |
| **Updates** | plugins with changes (updatable / major / prerelease / below-local / incompatible), per-row update, update-all | yes |
| **Snapshots** | list, create, restore | yes |
| **Diagnostics** | installed / enabled / missing / incompatible / untested / native counts, conflict table, review priority | no |

All write operations go over same-origin HTTP with three guards: custom header, `application/json`, Origin check; plus a 1.5 s throttle per endpoint.
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

## Auto-update

**Disabled by default.** Set `"autoUpdate": true` explicitly to enable it — installing a snapshot tool should not silently rewrite your dependency tree.

When enabled, it runs 45 seconds after DSH starts:

```
checkUpdates  ->  filter (exclude list + scope)
  ->  lock probe: drop packages currently held by DSH
  ->  snapshot
  ->  per-package install (pnpm add --save-exact --ignore-scripts)
  ->  four-state verdict: read the on-disk version, trust no exit code
  ->  layered rollback on failure (package-level / full)
```

| Mechanism | What it does |
| --- | --- |
| **Lock probe** | directory rename + `.node` open probe, removes packages that cannot be replaced |
| **Four-state verdict** | on-disk version present means success; only NO_MATCHING_VERSION / UNSUPPORTED_ENGINE / FETCH_404 count as failure |
| **Layered rollback** | partial success reverts only failed items; full failure restores then reinstalls |
| **Transient retry** | network failures retried at 8s / 30s / 90s; deterministic failures are not retried |

Results are written to `~/.dsh-plugin-snapshot/auto-update.json` and shown at the top of the Updates tab.
## Configuration

    {
      "profileDir": "explicit profile directory (auto-detected when empty)",
      "snapshotsKeep": 7,
      "concurrency": 8,
      "autoUpdate": false,
      "autoUpdateScope": "patch",
      "autoExclude": ["package-you-never-want-touched"]
    }

| Option | Default | Meaning |
| --- | --- | --- |
| autoUpdate | false | Disabled by default. Set true to check and update 45 s after DSH starts |
| autoUpdateScope | patch | patch only / minor / major |
| autoExclude | [] | packages never touched by auto-update |
| snapshotsKeep | 7 | how many snapshots to retain |
| concurrency | 8 | registry query parallelism |

## Limitations

- Snapshots cover the three manifests only, not node_modules
- Diagnostics are static evidence, not runtime verification
- No scheduler: the plugin only exists while DSH runs

---

## License

MIT

