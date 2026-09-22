"use strict";
// The copy button next to the hosted pairing code on the local dashboard
// (public/pair-copy.js). It must put exactly the code on the clipboard, say
// "Copied", come back to "copy", and fail visibly rather than quietly. The
// page wiring (public/app.js) is held by shape: the button is a real button,
// so Enter and Space work, and the code stays in its own selectable span.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { copyPairCode, COPY_LABEL, COPIED_LABEL, FAILED_LABEL } = require("../public/pair-copy");

const ROOT = path.join(__dirname, "..");

function fakeClipboard() {
  const writes = [];
  return { writes, writeText: async (t) => { writes.push(t); } };
}

test("copy puts exactly the code on the clipboard and says Copied", async () => {
  const clip = fakeClipboard();
  const button = { textContent: COPY_LABEL };
  const timers = [];
  const ok = await copyPairCode("AB7K9M2P", button, clip, (fn, ms) => timers.push({ fn, ms }));
  assert.equal(ok, true);
  assert.deepEqual(clip.writes, ["AB7K9M2P"]);
  assert.equal(button.textContent, COPIED_LABEL);
  assert.equal(COPIED_LABEL, "Copied");
  timers[0].fn();
  assert.equal(button.textContent, COPY_LABEL, "the label comes back");
});

test("stray whitespace never reaches the clipboard", async () => {
  const clip = fakeClipboard();
  await copyPairCode(" AB7K 9M2P\n", { textContent: "" }, clip, () => {});
  assert.deepEqual(clip.writes, ["AB7K9M2P"]);
});

test("a clipboard that refuses is said on the button, not swallowed", async () => {
  const button = { textContent: COPY_LABEL };
  const ok = await copyPairCode("AB7K9M2P", button, { writeText: async () => { throw new Error("denied"); } }, () => {});
  assert.equal(ok, false);
  assert.equal(button.textContent, FAILED_LABEL);
  const none = { textContent: COPY_LABEL };
  assert.equal(await copyPairCode("AB7K9M2P", none, undefined, () => {}), false);
  assert.equal(none.textContent, FAILED_LABEL);
});

test("the handler logs and stores nothing", () => {
  const src = fs.readFileSync(path.join(ROOT, "public", "pair-copy.js"), "utf8");
  for (const banned of ["console.", "localStorage", "sessionStorage", "indexedDB", "fetch(", "document.cookie"]) {
    assert.equal(src.includes(banned), false, `pair-copy.js must not use ${banned}`);
  }
});

test("the dashboard draws a real copy button beside a selectable code", () => {
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "public", "app.css"), "utf8");
  const block = app.slice(app.indexOf("function renderPairCode("), app.indexOf("async function renderPairings()"));
  assert.match(block, /document\.createElement\("button"\)/, "a button element, so the keyboard can reach and press it");
  assert.match(block, /copy\.type = "button"/);
  assert.match(block, /PairCopy\.copyPairCode\(code, copy, navigator\.clipboard\)/);
  assert.match(css, /\.pair-code \.pair-value \{ user-select: all; \}/, "the code alone stays selectable");
  assert.ok(html.indexOf("pair-copy.js") > 0 && html.indexOf("pair-copy.js") < html.indexOf("app.js?v="),
    "pair-copy.js loads before app.js");
  assert.equal(/console\.|localStorage/.test(block), false, "the render path logs and stores nothing");
});
