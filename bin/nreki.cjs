#!/usr/bin/env node
"use strict";

// CJS wrapper for Windows npx compatibility.
// ESM packages + npx on Windows don't generate .cmd shims correctly.
// This file bridges CJS → ESM so the bin resolves on all platforms.

import("../dist/index.js").catch((err) => {
  console.error("NREKI failed to start:", err.message);
  process.exit(1);
});
