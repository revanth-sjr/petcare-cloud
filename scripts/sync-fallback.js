#!/usr/bin/env node
/* =====================================================================
   scripts/sync-fallback.js
   ---------------------------------------------------------------------
   Regenerates functions/fallback.js (CommonJS) from the browser copy at
   public/js/ai-fallback.js (ES module), so the two runtimes can never
   disagree about what counts as an emergency.

   Edit public/js/ai-fallback.js, then:  npm run sync-fallback
   ===================================================================== */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "public/js/ai-fallback.js");
const OUT  = path.join(ROOT, "functions/fallback.js");

const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";

/* keep whatever SYSTEM_PROMPT block is already there — it is hand-written */
const marker = "/* ---------------------------------------------------------------------\n   The guardrail is a system prompt";
const tail = existing.includes(marker)
  ? "\n" + existing.slice(existing.indexOf(marker))
  : "\nmodule.exports = { answerLocally, DISCLAIMER };\n";

const header = `/* =====================================================================
   functions/fallback.js — CommonJS twin of public/js/ai-fallback.js.
   Pod C owns this file.
   ---------------------------------------------------------------------
   GENERATED: run \`npm run sync-fallback\` from the project root after
   editing public/js/ai-fallback.js. Do not hand-edit the rules below —
   edit the browser copy and regenerate, so the two runtimes can never
   disagree about what counts as an emergency.
   ===================================================================== */

`;

const body = fs.readFileSync(SRC, "utf8")
  .replace("export function answerLocally", "function answerLocally")
  .replace("export const DISCLAIMER", "const DISCLAIMER");

fs.writeFileSync(OUT, header + body + tail);
console.log(`  synced  public/js/ai-fallback.js  →  functions/fallback.js`);
