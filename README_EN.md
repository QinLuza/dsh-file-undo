# dsh-file-undo

[简体中文](README.md) | English

A DSH plugin that undoes agent **`write` / `edit`** file operations, restoring files to their pre-operation state via `/undo`.

## Commands

| Command | Description |
|---|---|
| `/undo` | Undo the most recent file write/edit |
| `/undo list` | Show all recorded operations (index + time + tool + file path) |
| `/undo <n>` | Undo the operation at the given index |
| `/undo prune [days]` | Purge snapshots older than N days (default 7); only shortens rollback depth, never touches current files |

## How It Works

Before every `write` / `edit`, the plugin automatically saves a snapshot of the file's pre-operation content; `/undo` writes that snapshot back to the file.

## Installation

### Option 1: Local build (link)

1. Build the plugin:

   ```sh
   pnpm install
   pnpm build
   ```

2. Add the dependency in your profile's `package.json`:

   ```json
   "dependencies": {
     "dsh-file-undo": "link:<absolute path to this directory>"
   }
   ```

3. Mount it in your profile's `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: file-undo
         name: 'dsh-file-undo'
   ```

4. Install dependencies and restart:

   ```sh
   cd ~/.dsh/profiles/web
   pnpm install
   dsh web
   ```

### Option 2: After publishing to npm

```sh
dsh plugin --profile web add dsh-file-undo
```

## Snapshot Storage

- Location: `~/.dsh/file-undo/snapshots.jsonl`
- A lazy 7-day purge runs automatically each time the plugin loads
- Manual purge: `/undo prune [days]` (default 7)
- Snapshot entries missing the `time` field are conservatively kept, never purged

## Limitations

- Covers only the `write` / `edit` tools; direct shell-side file changes (e.g. `Set-Content`, redirection) are not covered
- Rollback of deletions is not supported (the official fs exposes no delete method)
- Snapshots are shared globally, not isolated per session

## Development

```sh
pnpm typecheck        # Type checking
pnpm build            # Build
node verify-prune.mjs # Isolated verification of the purge logic (temp HOME; real snapshots untouched)
```
