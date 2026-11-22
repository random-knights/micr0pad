"use strict";
// focus.js - bring a window on this machine to the front.
//
// Two callers:
//
//   raiseBrowser   the MicroPad page itself, when the pad's talk key is
//                  pressed. Chrome will not run speech recognition (or write
//                  the clipboard) for a document that is not focused, and a
//                  page cannot focus itself, so the bridge does it.
//   raiseWindow    the window an agent session lives in, when that session's
//                  status key is pressed. The session's hook reported which
//                  process owns its window (windowOwnerOf below).
//
// Windows only. Elsewhere every function reports that it did nothing; it does
// not pretend.
const { execFile, execFileSync } = require("child_process");

// AppActivate matches the START of a window title. The page title is
// "0P | Micr0Pad", so a browser window showing it is titled
// "0P | Micr0Pad - Google Chrome" (or Edge, and so on) and this finds it
// without naming a browser. It only matches while that tab is the selected
// tab of its window: a browser titles a window after its selected tab.
const TITLE = "0P | Micr0Pad";

const PS = ["-NoProfile", "-NonInteractive", "-Command"];

function isPid(pid) {
  return Number.isInteger(pid) && pid > 0 && pid < 4294967296;
}

function raiseBrowser(onNotice) {
  if (process.platform !== "win32") return;
  const ps =
    "$w = New-Object -ComObject WScript.Shell; " +
    `if (-not $w.AppActivate('${TITLE}')) { exit 1 }`;
  execFile("powershell", PS.concat(ps), { windowsHide: true, timeout: 4000 }, (err) => {
    if (err && onNotice) onNotice("could not focus the MicroPad window: is its tab the selected one?");
  });
}

// The script that raises the main window of one process. A minimized window
// is restored first, because activating a minimized window leaves it
// minimized. The pid is a validated integer, the only value interpolated.
function raiseScript(pid) {
  return (
    `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
    "if ($p.MainWindowHandle -eq 0) { exit 2 }; " +
    "$sig = '[DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h); " +
    "[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr h, int c);'; " +
    "$u = Add-Type -MemberDefinition $sig -Name U -Namespace RkPad -PassThru; " +
    "if ($u::IsIconic($p.MainWindowHandle)) { [void]$u::ShowWindowAsync($p.MainWindowHandle, 9) }; " +
    "$w = New-Object -ComObject WScript.Shell; " +
    "if (-not $w.AppActivate($p.Id)) { exit 1 }"
  );
}

// Raise the main window of `pid`. Calls back with null on success or a short
// reason. `exec` is injectable so a test can read the command without running it.
function raiseWindow(pid, done, exec = execFile) {
  const cb = typeof done === "function" ? done : () => {};
  if (process.platform !== "win32") return cb("raising a window is only built for Windows");
  if (!isPid(pid)) return cb("no window is known for this session");
  exec("powershell", PS.concat(raiseScript(pid)), { windowsHide: true, timeout: 6000 }, (err) => {
    if (!err) return cb(null);
    if (err.code === 2) return cb("that session's program has no window");
    cb("that session's window is gone, or Windows would not bring it forward");
  });
}

// The script that walks up from one process to the nearest ancestor (itself
// included) that owns a visible top-level window, and prints that pid.
function ownerScript(pid) {
  return (
    `$id = ${pid}; ` +
    "for ($i = 0; $i -lt 12 -and $id; $i++) { " +
    "$p = Get-Process -Id $id -ErrorAction SilentlyContinue; " +
    "if ($p -and $p.MainWindowHandle -ne 0) { Write-Output $id; exit 0 }; " +
    "$c = Get-CimInstance Win32_Process -Filter \"ProcessId=$id\"; " +
    "if (-not $c) { break }; $id = $c.ParentProcessId }; exit 1"
  );
}

// Synchronous, because its one caller is a hook that is about to exit. Returns
// the pid of the window-owning ancestor of `pid`, or 0 when there is none or
// this is not Windows. Never throws.
function windowOwnerOf(pid, exec = execFileSync) {
  if (process.platform !== "win32" || !isPid(pid)) return 0;
  try {
    const out = exec("powershell", PS.concat(ownerScript(pid)), { windowsHide: true, timeout: 3500, encoding: "utf8" });
    const found = Number(String(out).trim().split(/\s+/)[0]);
    return isPid(found) ? found : 0;
  } catch (_) {
    return 0;
  }
}

module.exports = { raiseBrowser, raiseWindow, windowOwnerOf, raiseScript, ownerScript, isPid, TITLE };
