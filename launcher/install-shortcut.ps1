# install-shortcut.ps1 - put a "micr0pad" shortcut on the Windows desktop.
#
#   npm run launcher:install
#
# The shortcut runs launcher/launcher.js with no window: it starts the bridge
# if it is not running, then opens the app. Its icon is launcher/micr0pad.ico,
# a still frame of the animated pad drawing (a Windows shortcut icon cannot
# animate). Run this again after moving the checkout: the shortcut stores the
# path this script was run from.
#
# -Remove deletes the shortcut and touches nothing else.
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $PSScriptRoot
$ico = Join-Path $PSScriptRoot 'micr0pad.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'micr0pad.lnk'

if ($Remove) {
  if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Confirm:$false }
  Write-Output "removed: $link"
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is not on PATH. Install Node 18 or newer, then run this again.' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'launcher.js'))) { throw 'launcher.js not found beside this script.' }

# powershell -WindowStyle Hidden starts node with no console of its own, and
# the shortcut opens minimized so the brief powershell window never shows.
# The script path is given relative to the working directory, so it never
# needs quotes of its own, whatever folder the checkout sits in.
$q = { param($p) $p.Replace("'", "''") }
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($link)
$s.TargetPath = (Get-Command powershell).Source
$s.Arguments = "-NoProfile -WindowStyle Hidden -Command `"Start-Process -WindowStyle Hidden -FilePath '$(& $q $node)' -ArgumentList 'launcher\launcher.js' -WorkingDirectory '$(& $q $appDir)'`""
$s.WorkingDirectory = $appDir
$s.IconLocation = "$ico,0"
$s.WindowStyle = 7
$s.Description = 'Start micr0pad: the bridge, the pad and the app'
$s.Save()
Write-Output "created: $link"
