# install-shortcut.ps1 - put a "micr0pad" shortcut on the Windows desktop.
#
#   npm run launcher:install
#
# The shortcut runs launcher/launcher.js with no console window. The icon is
# the 0P mark from public/0p.png, written once as an .ico into the per-user
# micr0pad folder (the same folder config.json lives in), because a shortcut
# cannot use a .png. Run it again after moving the checkout: the shortcut
# stores the path this script was run from.
#
# -Remove deletes the shortcut and the icon and touches nothing else.
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'launcher.js'
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'micr0pad.lnk'
$dataDir = if ($env:RK_MICROPAD_DATA_DIR) { $env:RK_MICROPAD_DATA_DIR } else { Join-Path $env:APPDATA 'micr0pad' }
$ico = Join-Path $dataDir '0p.ico'

if ($Remove) {
  foreach ($f in @($link, $ico)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Confirm:$false } }
  Write-Output "removed: $link"
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is not on PATH. Install Node 18 or newer, then run this again.' }
if (-not (Test-Path -LiteralPath $launcher)) { throw "launcher.js not found beside this script: $launcher" }

# The icon: the 0P mark scaled to 256 px, wrapped as a one-image .ico (an .ico
# may carry a PNG as its image data).
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile((Join-Path $appDir 'public\0p.png'))
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, 256, 256)
$g.Dispose(); $src.Dispose()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$png = $ms.ToArray(); $ms.Dispose()
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)   # reserved, type icon, one image
$w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0)   # 256 x 256, no palette
$w.Write([UInt16]1); $w.Write([UInt16]32)                        # planes, bits per pixel
$w.Write([UInt32]$png.Length); $w.Write([UInt32]22)              # size, offset
$w.Write($png); $w.Flush()
[System.IO.File]::WriteAllBytes($ico, $out.ToArray())
$w.Dispose(); $out.Dispose()

# powershell -WindowStyle Hidden starts node with no console of its own. The
# shortcut itself opens minimized so the brief powershell window never shows.
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($link)
$s.TargetPath = (Get-Command powershell).Source
# The script path is given relative to the working directory, so it never
# needs quotes of its own, whatever folder the checkout sits in.
$q = { param($p) $p.Replace("'", "''") }
$s.Arguments = "-NoProfile -WindowStyle Hidden -Command `"Start-Process -WindowStyle Hidden -FilePath '$(& $q $node)' -ArgumentList 'launcher\launcher.js' -WorkingDirectory '$(& $q $appDir)'`""
$s.WorkingDirectory = $appDir
$s.IconLocation = "$ico,0"
$s.WindowStyle = 7
$s.Description = 'Start micr0pad: the bridge, the pad and the pairing page'
$s.Save()
Write-Output "created: $link"
