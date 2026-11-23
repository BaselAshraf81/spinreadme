# Stop: keep the Trail map in sync after edits. Silent, never fails.
$ErrorActionPreference = 'SilentlyContinue'
if (-not (Get-Command trail -ErrorAction SilentlyContinue)) { exit 0 }
trail build --dir .trail/cache 2>&1 | Out-Null
exit 0

