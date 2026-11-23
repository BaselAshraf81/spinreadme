# SessionStart: refresh Trail map, print short ASCII status. Never fails.
$ErrorActionPreference = 'SilentlyContinue'
if (-not (Get-Command trail -ErrorAction SilentlyContinue)) { exit 0 }
[Console]::OutputEncoding = [Text.Encoding]::UTF8
trail build --dir .trail/cache 2>&1 | Out-Null
$out = trail status --dir .trail/cache 2>&1 | Select-Object -First 4 | ForEach-Object { ($_ -replace '[^\x20-\x7E]+', ' ').Trim() }
"Trail map refreshed. Use trail ask/callers/skeleton/grep before grepping files."
$out
exit 0

