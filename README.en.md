# dsh-plugin-snapshot

Pre-upgrade snapshots, one-step rollback and a static health check for DeepSeek Harness plugins.

The built-in plugin_manager already installs, removes and toggles plugins. This plugin adds what it does not: a verifiable recovery point before you change anything, a way back when an upgrade goes wrong, and a clear view of which plugins collide.

## Install

    dsh plugin add dsh-plugin-snapshot

Restart DSH (or let HMR pick it up), then the three tools are available.

## Tools

### plugin_snapshot

Create, list and restore snapshots of the profile manifests (package.json, pnpm-lock.yaml, pnpm-workspace.yaml).

Every snapshot carries a manifest with the profile fingerprint, creation time, and per-file sha256. Restoring verifies the fingerprint first, so a snapshot from another profile is rejected; a hash mismatch only warns, because you may have edited the manifest by hand.

### plugin_updates

Read-only version check. Compares the version resolved in pnpm-lock.yaml against the registry and reports updatable / major / uptodate / prerelease / failed / manual. Prereleases are never suggested, and GitHub sources are always flagged for manual review.

### plugin_doctor

Static diagnostic: declared vs installed vs enabled, author-declared DSH compatibility (an explicit incompatible is reported as incompatible, never as probably fine), duplicate cordis.patch.yml ids, missing packages and unparseable manifests. The returned priority is a rule-weighted score, not a crash probability.

## Where data lives

    ~/.dsh-plugin-snapshot/snapshots/<timestamp>/
    ~/.dsh-plugin-snapshot/logs/

Nothing else is written except the three profile manifests on restore. node_modules and the bundles list are never touched, and DSH is never started or stopped.

## Limitations

- Snapshots cover the three manifests only, not node_modules
- Diagnostics are static evidence, not runtime verification
- No scheduler: the plugin only exists while DSH runs

## License

MIT

