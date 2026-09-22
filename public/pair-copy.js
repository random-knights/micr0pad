"use strict";
// pair-copy.js - the copy button next to the hosted pairing code.
//
// The code is read off this screen and put into a hosted page, so copying it
// beats retyping eight characters. This file is the whole copy handler, kept
// apart from app.js so the test suite can load it without a browser.
//
// It puts exactly the code on the clipboard (no spaces, no expiry note) and
// says "Copied" on the button. It logs nothing and stores nothing: the code
// lives on this screen for its five minutes and in the clipboard the owner
// asked for, and nowhere else.
(function (root) {
  const COPY_LABEL = "copy";
  const COPIED_LABEL = "Copied";
  const FAILED_LABEL = "select and copy";
  const RESET_MS = 1500;

  async function copyPairCode(code, button, clipboard, setTimer) {
    const text = String(code == null ? "" : code).replace(/\s+/g, "");
    const later = typeof setTimer === "function" ? setTimer : setTimeout;
    const say = (label) => { if (button) button.textContent = label; };
    if (!text || !clipboard || typeof clipboard.writeText !== "function") {
      say(FAILED_LABEL);
      return false;
    }
    try {
      await clipboard.writeText(text);
    } catch (_) {
      // The clipboard needs a focused, secure tab. The code stays visible and
      // selectable, so the fallback is to select it by hand.
      say(FAILED_LABEL);
      return false;
    }
    say(COPIED_LABEL);
    later(() => say(COPY_LABEL), RESET_MS);
    return true;
  }

  const api = { copyPairCode, COPY_LABEL, COPIED_LABEL, FAILED_LABEL, RESET_MS };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PairCopy = api;
})(typeof window !== "undefined" ? window : globalThis);
