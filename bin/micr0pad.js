#!/usr/bin/env node
"use strict";
// bin/micr0pad.js - the single entry point.
//
//   npx @randomknights/micr0pad            (from the npm registry)
//   npm start                              (from a clone)
//   node bin/micr0pad.js                   (the same thing, spelled out)
//
// It runs the preflight (Node version, dependencies, first-run config) and
// then hands over to the server. Nothing here duplicates server.js: this
// file exists so that the install steps happen in one place, whichever of
// the three commands above someone types.
//
// A shebang lives here rather than at the top of server.js on purpose:
// server.js is the app, and it should stay a plain module that `require()`
// and the tests can load without inheriting a command-line identity.

const preflight = require("../scripts/preflight");

preflight.main();

// Loading server.js starts it. Everything it needs (config, the pairing
// token, the HID bridge) is set up inside that module.
require("../server.js");
