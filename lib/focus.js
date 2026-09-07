"use strict";
// focus.js - bring the MicroPad browser window to the front.
//
// WHY THIS EXISTS
// Pressing the pad's talk key while you are working in a terminal lights the
// gold underglow, but no transcript arrives: Chrome will not run speech
// recognition (or write the clipboard) for a document that is not focused.
// Nothing in the page can fix that - a page cannot focus itself - so the fix
// has to come from this side, which is running locally anyway.
//
// OFF BY DEFAULT. Stealing focus is exactly what you want when you deliberately
// press talk, and exactly what you do not want otherwise, so it is opt-in:
// set "focusBrowserOnTalk": true in config.json.
const { execFile } = require("child_process");

// Matches the browser window by title. The page title contains "Micr0Pad", and
// AppActivate matches from the start of the window title, so this finds
// "Micr0Pad - Google Chrome" and friends without naming a browser.
const TITLE = "Micr0Pad";

function raiseBrowser(onNotice) {
  if (process.platform !== "win32") return;
  const ps =
    "$w = New-Object -ComObject WScript.Shell; " +
    `if (-not $w.AppActivate('${TITLE}')) { exit 1 }`;
  execFile(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { windowsHide: true, timeout: 4000 },
    (err) => {
      if (err && onNotice) onNotice("could not focus the MicroPad window");
    },
  );
}

module.exports = { raiseBrowser, TITLE };
