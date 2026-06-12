# Building from a Google Drive folder

## The problem

This project lives in a Google Drive synced folder (`G:\My Drive\...`).
Google Drive's virtual filesystem cannot handle npm's write patterns —
`npm install` creates tens of thousands of small files concurrently, and
Drive silently truncates a large fraction of them to **zero bytes**. The
install *reports success*, but `node_modules` is corrupt: builds fail with
bizarre parse errors, or tools simply behave as if files were empty.

Observed here on 2026-06-12: ~2,500 zero-byte `.js` files after a "successful"
install. Junctions/symlinks into `node_modules` are not a fix either — the
Drive filesystem rejects creating them ("Incorrect function").

This is not specific to this project: assume **any** npm project in a Google
Drive folder has this problem.

## The workaround

Keep the **source of truth on Drive** (so it stays synced/backed up), but do
all node/npm work in a **mirror on the local disk**, then copy the build
output back:

```
G:\My Drive\...\vtube            %LOCALAPPDATA%\vtube-build
  src/, public/, package.json --->  (robocopy /MIR)
                                    npm install        (local disk: safe)
                                    npm run build
  dist/  <---------------------     dist/
```

`node_modules` only ever exists in the mirror. The Drive folder never needs
one (and `.gitignore` already excludes `node_modules/` and `dist/` from git).

## Day-to-day usage

Everything is wrapped in [build.ps1](./build.ps1):

```powershell
.\build.ps1            # sync -> install if needed -> build -> dist/ copied back
.\build.ps1 -Install   # force a fresh npm install in the mirror
.\build.ps1 -Dev       # sync, then run the Vite dev server from the mirror
```

Typical build-and-deploy loop:

1. Edit code in the Drive folder as usual.
2. Run `.\build.ps1`.
3. Upload the refreshed `dist\` folder to Cloudflare Pages.

Notes:

- **Dev server caveat:** `-Dev` serves the *mirror's* files. Edits made on
  Drive are not picked up until you re-run the script (it syncs before
  starting). For long live-reload sessions, either work directly in the
  mirror and copy changes back, or just re-run `.\build.ps1 -Dev` after a
  batch of edits.
- If PowerShell refuses to run the script, unblock it once:
  `powershell -ExecutionPolicy Bypass -File .\build.ps1`
- Adding/upgrading a dependency: edit `package.json` on Drive, then
  `.\build.ps1 -Install`. Never run `npm install` in the Drive folder.

## Adapting this to another project

`build.ps1` is intentionally generic:

- It derives all paths from its own location — the mirror lands at
  `%LOCALAPPDATA%\<project-folder-name>-build`.
- The only project-specific part is the `$SYNC_FILES` / `$SYNC_DIRS` lists at
  the top (which top-level files and directories constitute the buildable
  source). Adjust those, drop the script into the new project, done.
- It assumes `npm run build` produces `dist/`; change step 4 if your project
  outputs elsewhere.
