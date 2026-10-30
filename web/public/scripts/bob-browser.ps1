# bob-browser — open BOB in an automation-ready Chrome (Windows).
#
# Usage (PowerShell):
#   irm https://bobkat.hfxaiguy.com/scripts/bob-browser.ps1 | iex
#
# Optional app URL for a self-hosted copy:
#   $env:BOB_APP_URL = "http://192.168.1.20:8080"; irm .../bob-browser.ps1 | iex
#
# The script launches a *separate* Chrome (or Edge) profile so the normal
# browser is untouched, starts it with the DevTools port and Origin allowlist
# BOB's browser tools need, reads the browser-level debugger socket, and opens
# the app with `?cdp=<socket>`. The printed URL carries this machine's
# automation socket: treat it as a local secret and do not share it.
#
# Environment:
#   BOB_APP_URL=https://bobkat.hfxaiguy.com
#   BOB_CDP_PORT=9222
#   BOB_CHROME=C:\path\to\chrome.exe
#   BOB_PROFILE_DIR=%LOCALAPPDATA%\Bobkat\chrome-profile
#   BOB_BROWSER_HEADLESS=1   no window (prints the URL only)
#   BOB_NO_OPEN=1            print the URL instead of opening it
$ErrorActionPreference = "Stop"

$AppUrl = if ($env:BOB_APP_URL) { $env:BOB_APP_URL } else { "https://bobkat.hfxaiguy.com" }
$Port = if ($env:BOB_CDP_PORT) { [int]$env:BOB_CDP_PORT } else { 9222 }
$ProfileDir = if ($env:BOB_PROFILE_DIR) {
  $env:BOB_PROFILE_DIR
} else {
  Join-Path $env:LOCALAPPDATA "Bobkat\chrome-profile"
}
$Base = "http://127.0.0.1:$Port"

if ($AppUrl -notmatch '^https?://[^/]+') {
  throw "bob-browser: the app URL must start with http(s):// (got: $AppUrl)"
}
$Origin = ([Uri]$AppUrl).GetLeftPart([UriPartial]::Authority)

$candidates = @()
if ($env:BOB_CHROME) { $candidates += $env:BOB_CHROME }
foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
  if ($root) { $candidates += (Join-Path $root "Google\Chrome\Application\chrome.exe") }
}
foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
  if ($root) { $candidates += (Join-Path $root "Microsoft\Edge\Application\msedge.exe") }
}
$Chrome = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Chrome) {
  throw "bob-browser: Chrome or Edge was not found — install one, or set BOB_CHROME."
}

function Test-Endpoint {
  try {
    Invoke-RestMethod -Uri "$Base/json/version" -TimeoutSec 1 | Out-Null
    return $true
  } catch {
    return $false
  }
}

# Reuse an instance already listening on the debug port (a previous run).
if (-not (Test-Endpoint)) {
  New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
  $launchArgs = @(
    "--remote-debugging-port=$Port",
    "--remote-allow-origins=$Origin",
    "--user-data-dir=$ProfileDir",
    "--no-first-run",
    "--no-default-browser-check"
  )
  if ($env:BOB_BROWSER_HEADLESS -eq "1") { $launchArgs += "--headless=new" }
  $launchArgs += "about:blank"
  Start-Process -FilePath $Chrome -ArgumentList $launchArgs | Out-Null

  $ready = $false
  for ($i = 0; $i -lt 100; $i++) {
    if (Test-Endpoint) { $ready = $true; break }
    Start-Sleep -Milliseconds 200
  }
  if (-not $ready) { throw "bob-browser: Chrome did not open the automation port ($Base)." }
}

$version = Invoke-RestMethod -Uri "$Base/json/version"
if (-not $version.webSocketDebuggerUrl) {
  throw "bob-browser: Chrome is not answering on $Base. If another Chrome already uses port $Port, quit it and run this again so the new instance starts with --remote-allow-origins=$Origin."
}

$separator = if ($AppUrl.Contains("?")) { "&" } else { "?" }
$Target = "$AppUrl$separator`cdp=$($version.webSocketDebuggerUrl)"

if ($env:BOB_NO_OPEN -eq "1" -or $env:BOB_BROWSER_HEADLESS -eq "1") {
  Write-Output $Target
  return
}

# Same user-data-dir: the running instance opens the URL as a new tab.
Start-Process -FilePath $Chrome -ArgumentList @("--user-data-dir=$ProfileDir", $Target) | Out-Null
Write-Output "bob-browser: opened $Target"
