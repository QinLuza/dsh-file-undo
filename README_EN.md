# dsh-file-undo

[简体中文](README.md) | English

A DSH plugin that undoes agent file operations: every **`write` / `edit`** is snapshotted before it hits disk, reviewed as red/green diffs in a sidebar panel, and rolled back with two-phase undo — plus redo, RewindTo, and multi-session follow. Current version **0.2.0**. MIT licensed.

## Visual panel

A "Undo" entry at the sidebar footer (with a pending-count badge) opens the review panel:

- **History list**: time, tool badge (write / edit / create), file name, `+restored / −removed` line counts, and model-turn badges; failed calls are logged too
- **Undo-perspective red/green diff**: green = content the undo will restore, red = content it will remove; hunk headers, dual line numbers, long-file truncation ("show all" after 800 lines)
- **Auto preflight**: runs when an entry opens, with a per-item reason whenever an undo isn't safe (see "Safety model")
- **Two-phase confirm**: the first click arms the button (auto-disarms after 3s); the second click executes
- **Session switcher**: lists all sessions in the same project tree (platform titles, active/archived state); selecting one pins it — by default the panel auto-follows the session you are viewing

## Safety model (two-phase + transactional + optimistic concurrency)

| Stage | Behavior |
|---|---|
| Preflight (read-only) | Classified per item with reasons: `file_creation` (undo = file deletion, guarded by content/hash double gate + confirm) / `external_modified` (the file was hand-edited after the snapshot — your manual edits are never silently clobbered) / `superseded_by_later_ops` (N later edits of its own exist — use "RewindTo") / `already_reverted` / `file_missing` / `stale` |
| Apply | Carries the preflight `expectedCurrentHash` as an optimistic lock — if the file changed between preview and confirm, the write is rejected (`stale`); otherwise the before-content is written back in full and the entry is marked `reverted` |
| RewindTo | Pick any historical entry for a single atomic write-back: chain-consistency checks + the number of later steps to be discarded is shown up front; later entries are bulk-marked `cascade` |
| Cascade revival | Reapplying an upstream entry revives the whole cascade batch in one go (the confirm shows "restore N entries together"); undo/redo loops are idempotent |

The `/undo` chat command keeps its forceful semantics (no `external_modified` gate).

## Session follow

The panel auto-follows the session you are viewing: the client half subscribes to the `betterSidebar` service (primary) and `sessions.list` (fallback), and every panel request carries that session id; the host verifies each request against the platform session directory and always reads cwd from the platform — forged session ids get `404 unknown-session`. With neither source available (headless), it silently degrades to the legacy behavior.

## Commands

| Command | Effect |
|---|---|
| `/undo` | Undo the most recent file write/edit |
| `/undo list` | List recorded operations for the current session |
| `/undo <n>` | Undo the operation at index n |
| `/undo sessions` | List sessions in the same project tree (same API as the panel switcher) |
| `/undo prune [days]` | Prune snapshots older than N days (default 7) — only shortens rewind depth, never touches current files |
| `/undo git [n]` | Restore the n-th snapshot from the git archive (0 = newest) |
| `/undo git-status` | Git-archive health |

## How it works

1. **Full-content snapshots, not reverse patches**: `tools/pre-execute` captures the before-content before write/edit lands; `tools/post-execute` fills in the after-content + sha256 (the expected hash for external-modification detection). Diffs are computed at render time; undo writes the whole file back.
2. **Diff computation and rendering are decoupled**: host-side line-level LCS (prefix/suffix trimming + integer line IDs + Uint32 DP) produces hunks; the client classifies lines and colors them with pure CSS.
3. **The engine decides, the UI renders**: every "may I touch this file" verdict lives host-side (preflight classification + transaction + optimistic lock).
4. **Closed state machine**: `recorded → reverted → reapplied` — a reapplied entry can be undone again.
5. **Relative paths resolve per session** against the session workspace cwd, stored as stable keys for reuse.
6. **HTTP API**: `POST /file-undo/api/*` behind a Host-header trust fence (loopback / trustedHosts + sec-fetch-site + Origin checks).

## Snapshot storage

```text
~/.dsh/file-undo/
  <workspace-key>/          # derived from the normalized session cwd (sanitized + 8-char hash suffix)
    <chat-key>/             # session id
      snapshots.jsonl       # append-only; single-flight write lock + atomic rename
      git-archive/          # second-layer archive: one commit per snapshot, silent degradation
```

- The same directory is always the same key, no matter how the path is spelled (`D:\proj` vs `d:/proj/`) — normalization makes existing stores zero-migration
- Lazy 7-day cleanup on load; `/undo prune` for manual cleanup; entries without a timestamp are conservatively kept

## Install

### Option 1: local build (link)

```sh
git clone https://github.com/QinLuza/dsh-file-undo.git
cd dsh-file-undo && pnpm install && pnpm build
```

Add the dependency in the profile's `package.json`:

```json
"dsh-file-undo": "link:<absolute path to this directory>"
```

Run `pnpm install` in the profile directory and restart DSH. Later client-only changes need just a hard browser refresh.

### Option 2: npm (after publish)

```sh
dsh plugin --profile web add dsh-file-undo
```

## Limitations

- Only `write` / `edit` are captured; file changes made through shell commands (e.g. `Set-Content`, redirection) are not on the timeline
- "RewindTo" discards later edits (the count is shown in preflight) — it does not replay them onto the old baseline
- The panel and session follow need the web UI; in headless mode the chat commands still work (with automatic degradation)

## Development

```sh
pnpm typecheck
pnpm build
node verify-prune.mjs    # isolated prune-logic verification (temp HOME, never touches real snapshots)
node verify-rewind.mjs   # rewind semantics regression
node smoke-test.mjs      # smoke test
node verify-follow.mjs   # session-follow data-source regression
```

## License

MIT
