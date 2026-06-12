<#
.SYNOPSIS
  Build this project from a local-disk mirror (npm is unreliable on Google Drive).

.DESCRIPTION
  Google Drive's virtual filesystem corrupts `npm install` (thousands of
  silently zero-byte files in node_modules) and does not support junctions.
  This script keeps the SOURCE OF TRUTH on Google Drive and does all
  node/npm work on the local disk:

    1. Mirror package files + src/ + public/ + index.html to a build dir
       under %LOCALAPPDATA% (named after the project folder).
    2. `npm install` there (only when package-lock.json changed or
       node_modules is missing — use -Install to force).
    3. `npm run build` there (tsc --noEmit + vite build).
    4. Copy the resulting dist/ back to the project folder on Drive,
       ready to upload to Cloudflare Pages.

  Generic by design: it derives all paths from its own location, so you can
  drop this script (plus the SYNC_ITEMS list below, adjusted if your project
  has different top-level files) into any npm project that lives on Google
  Drive.

.PARAMETER Install
  Force a fresh `npm install` in the mirror even if nothing seems changed.

.PARAMETER Dev
  Instead of building, start the Vite dev server from the mirror.
  NOTE: the dev server watches the MIRROR's files. Re-run this script to
  push new edits from Drive into it, or edit in the mirror and copy back.

.EXAMPLE
  .\build.ps1            # sync, install if needed, build, copy dist back
  .\build.ps1 -Install   # same, but force reinstall of dependencies
  .\build.ps1 -Dev       # sync, then run the dev server from the mirror
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Dev
)

$ErrorActionPreference = "Stop"

# ---- paths -----------------------------------------------------------------
$ProjectRoot = $PSScriptRoot
$ProjectName = Split-Path $ProjectRoot -Leaf
$MirrorRoot  = Join-Path $env:LOCALAPPDATA "$ProjectName-build"

# Top-level items that make up the buildable source. Adjust per project.
$SYNC_FILES = @("package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "index.html")
$SYNC_DIRS  = @("src", "public")

Write-Host "Project : $ProjectRoot"
Write-Host "Mirror  : $MirrorRoot"

# ---- 1. sync source -> mirror ----------------------------------------------
New-Item -ItemType Directory -Force $MirrorRoot | Out-Null

foreach ($f in $SYNC_FILES) {
    $src = Join-Path $ProjectRoot $f
    if (Test-Path $src) { Copy-Item $src $MirrorRoot -Force }
}
foreach ($d in $SYNC_DIRS) {
    $src = Join-Path $ProjectRoot $d
    if (Test-Path $src) {
        # /MIR keeps the mirror exact (deletes files you deleted on Drive).
        robocopy $src (Join-Path $MirrorRoot $d) /MIR /NJH /NJS /NDL /NFL | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed for '$d' (exit $LASTEXITCODE)" }
    }
}
Write-Host "Synced source to mirror." -ForegroundColor Green

# ---- 2. npm install (in mirror, on local disk) ------------------------------
Set-Location $MirrorRoot
try {
    $stamp = Join-Path $MirrorRoot ".lockfile-stamp"
    $lock  = Join-Path $MirrorRoot "package-lock.json"
    $lockChanged = $true
    if ((Test-Path $stamp) -and (Test-Path $lock)) {
        $lockChanged = (Get-FileHash $lock).Hash -ne (Get-Content $stamp -ErrorAction SilentlyContinue)
    }

    if ($Install -or $lockChanged -or -not (Test-Path (Join-Path $MirrorRoot "node_modules"))) {
        Write-Host "Running npm install..." -ForegroundColor Cyan
        npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
        (Get-FileHash $lock).Hash | Set-Content $stamp -Encoding utf8
    } else {
        Write-Host "Dependencies up to date (use -Install to force)."
    }

    # ---- 2b. dev mode ---------------------------------------------------------
    if ($Dev) {
        Write-Host "Starting dev server from the mirror (Ctrl+C to stop)..." -ForegroundColor Cyan
        Write-Host "Remember: it serves the MIRROR. Re-run .\build.ps1 -Dev after editing on Drive."
        npm run dev
        return
    }

    # ---- 3. build ---------------------------------------------------------------
    Write-Host "Building..." -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "build failed (exit $LASTEXITCODE)" }
}
finally {
    Set-Location $ProjectRoot
}

# ---- 4. copy dist back to Drive ----------------------------------------------
robocopy (Join-Path $MirrorRoot "dist") (Join-Path $ProjectRoot "dist") /MIR /NJH /NJS /NDL /NFL | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed for dist (exit $LASTEXITCODE)" }

Write-Host "Done. Fresh build is in $ProjectRoot\dist - upload that to Cloudflare Pages." -ForegroundColor Green
