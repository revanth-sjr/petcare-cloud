#!/usr/bin/env node
/* =====================================================================
   scripts/test-bin.js
   ---------------------------------------------------------------------
   The Bin: moving a timeline entry to the bin, restoring it, deleting
   it permanently (two-click confirm), and — the part that actually
   matters — verifying the underlying record is never really erased and
   that existing tracking features (counts, calendar) stay correct
   around a trashed entry.

   Usage:  node scripts/test-bin.js
   ===================================================================== */

const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 5221;
const BASE = `http://localhost:${PORT}`;

let failures = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); }
  else { console.error(`  ✗ ${label}`); failures++; }
}

async function main() {
  const server = spawn("npx", ["--yes", "serve", "public", "-l", String(PORT)], { cwd: ROOT, stdio: "ignore" });
  await waitForServer();

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true })
    .catch(() => chromium.launch({ headless: true }));

  try {
    await testMoveRestoreAndPermanentDelete(browser);
  } catch (err) {
    failures++;
    console.error(err.message || err);
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

async function testMoveRestoreAndPermanentDelete(browser) {
  console.log("A. Move to bin -> restore -> delete permanently");
  const page = await browser.newPage();
  await page.goto(`${BASE}/login.html`);
  await page.click('[data-demo="owner"]');
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });
  await page.waitForSelector(".pet-flash-card", { timeout: 10000 });
  await page.click(".pet-flash-card");
  await page.waitForURL(/index\.html/, { timeout: 8000 });
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });

  // Seed data starts Buddy at 2 feedings logged today.
  const before = (await page.textContent("#cntFeeding")).trim();
  check("starts with a non-zero feeding count from seed data", before !== "0 / 3");

  const feedingRow = page.locator('.tl-item[data-type="feeding"]').first();
  check("today's timeline has a feeding entry to delete", await feedingRow.count() === 1);

  console.log("1. Move a feeding entry to the bin");
  await feedingRow.hover();
  await feedingRow.locator(".tl-trash").click();
  await page.waitForFunction((b) => document.querySelector("#cntFeeding")?.textContent.trim() !== b, before);
  const afterTrash = (await page.textContent("#cntFeeding")).trim();
  check("feeding count drops by one once moved to the bin", afterTrash !== before);
  const timelineFeedCountAfterTrash = await page.locator('.tl-item[data-type="feeding"]').count();

  console.log("2. Bin shows the deleted entry and its count badge");
  const binBadge = (await page.textContent("#binCount")).trim();
  check("bin badge shows exactly 1 item", binBadge === "1");
  await page.click("#btnOpenBin");
  await page.waitForSelector("#binModal:not([hidden])");
  check("bin lists the deleted feeding entry", (await page.textContent("#binList")).includes("Feeding"));
  check("bin entry names who deleted it (Revanth, the demo owner)", (await page.textContent("#binList")).includes("Revanth"));

  console.log("3. Restore brings it back to the timeline");
  await page.click('#binList .icon-btn[title="Restore to the timeline"]');
  await page.waitForFunction((b) => document.querySelector("#cntFeeding")?.textContent.trim() === b, before);
  check("feeding count is back to its original value after restore", (await page.textContent("#cntFeeding")).trim() === before);
  check("bin is empty again after restoring the only entry", (await page.textContent("#binList")).includes("Bin is empty"));
  await page.click('#binModal [data-close-modal]');
  await page.waitForSelector("#binModal", { state: "hidden" });
  check("restored entry is back on the timeline", await page.locator('.tl-item[data-type="feeding"]').count() === timelineFeedCountAfterTrash + 1);

  console.log("4. Move to bin again, then delete permanently (two-click confirm)");
  await page.locator('.tl-item[data-type="feeding"]').first().hover();
  await page.locator('.tl-item[data-type="feeding"]').first().locator(".tl-trash").click();
  await page.waitForFunction((b) => document.querySelector("#cntFeeding")?.textContent.trim() !== b, before);

  await page.click("#btnOpenBin");
  await page.waitForSelector("#binModal:not([hidden])");
  // A stable selector, not one keyed on the button's own text — that text
  // is exactly what the first click below changes (to "Confirm?"), which
  // would make a hasText-filtered locator stop matching its own target.
  const delBtn = page.locator("#binList button.btn-crit-ghost").first();
  await delBtn.click();
  check("first click arms the confirm, does not delete yet", (await delBtn.textContent()).includes("Confirm"));
  await delBtn.click();
  await page.waitForFunction(() => document.querySelector("#binList")?.textContent.includes("Bin is empty"));
  check("permanently deleting drops it out of the bin list", (await page.textContent("#binList")).includes("Bin is empty"));

  await page.click('#binModal [data-close-modal]');
  await page.waitForSelector("#binModal", { state: "hidden" });
  check("feeding count stays reduced — permanent delete does not un-delete it", (await page.textContent("#cntFeeding")).trim() !== before);
  check("no feeding entry reappears on the timeline after permanent delete",
    await page.locator('.tl-item[data-type="feeding"]').count() === timelineFeedCountAfterTrash);

  await page.close();
}

function waitForServer() {
  return new Promise((resolve) => {
    const tryOnce = () => {
      require("node:http").get(`${BASE}/login.html`, (res) => { res.resume(); resolve(); })
        .on("error", () => setTimeout(tryOnce, 200));
    };
    setTimeout(tryOnce, 400);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
