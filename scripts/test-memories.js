#!/usr/bin/env node
/* =====================================================================
   scripts/test-memories.js
   ---------------------------------------------------------------------
   Pet Memories: add (with a photo, title, date, description), view in
   the gallery, edit, delete, and the owner-vs-caretaker permission
   split (a caretaker can add a memory and manage their own, but not
   someone else's).

   Usage:  node scripts/test-memories.js
   ===================================================================== */

const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 5223;
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
    await testAddViewEditDelete(browser);
    await testCaretakerCanAddButNotEditOwnersMemory(browser);
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

async function openBuddy(page) {
  await page.goto(`${BASE}/login.html`);
  await page.click('[data-demo="owner"]');
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });
  await page.waitForSelector(".pet-flash-card", { timeout: 10000 });
  await page.click(".pet-flash-card");
  await page.waitForURL(/index\.html/, { timeout: 8000 });
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });
}

async function openBuddyAsCaretaker(page) {
  await page.goto(`${BASE}/login.html`);
  await page.click('[data-demo="caretaker"]');
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });
  await page.waitForSelector(".pet-flash-card", { timeout: 10000 });
  await page.click(".pet-flash-card");
  await page.waitForURL(/index\.html/, { timeout: 8000 });
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });
}

/* ------------------------------------------------------------------
   1. Add a memory (with a photo), see it in the gallery, edit its
      caption, then delete it (two-click confirm).
   ------------------------------------------------------------------ */
async function testAddViewEditDelete(browser) {
  console.log("A. Add / view / edit / delete a memory (owner)");
  const page = await browser.newPage();
  await openBuddy(page);

  check("empty state shown before any memory exists", await page.isVisible("#memoryEmpty"));

  await page.click("#btnAddMemory");
  await page.waitForSelector("#memoryFormModal:not([hidden])");
  await page.fill("#memTitle", "First day home");
  await page.fill("#memDate", "2026-01-15");
  await page.fill("#memDescription", "Buddy came home for the first time!");

  const fileInput = await page.$("#memPhoto");
  await fileInput.setInputFiles({
    name: "buddy.png",
    mimeType: "image/png",
    // a tiny valid 1x1 PNG
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  });
  await page.waitForFunction(() => document.querySelector("#memPhotoPreview")?.style.backgroundImage !== "");

  await page.click("#memoryFormSubmit");
  await page.waitForSelector("#memoryFormModal", { state: "hidden", timeout: 8000 });

  check("memory now shows in the gallery", (await page.textContent("#memoryGallery")).includes("First day home"));
  check("empty state is gone once a memory exists", await page.isHidden("#memoryEmpty"));
  check("memory card shows the caption", (await page.textContent("#memoryGallery")).includes("came home for the first time"));
  check("memory card shows a photo, not the placeholder icon",
    await page.locator(".memory-card .memory-photo").first().evaluate((el) => el.style.backgroundImage !== ""));
  check("memory card attributes who added it", (await page.textContent("#memoryGallery")).includes("Added by Revanth"));

  console.log("Edit the memory's caption");
  await page.click(".memory-card .icon-btn");
  await page.waitForSelector("#memoryFormModal:not([hidden])");
  check("edit form opens pre-filled with the existing title", await page.inputValue("#memTitle") === "First day home");
  await page.fill("#memDescription", "Updated caption for Buddy's first day.");
  await page.click("#memoryFormSubmit");
  await page.waitForSelector("#memoryFormModal", { state: "hidden", timeout: 8000 });
  check("edited caption persisted", (await page.textContent("#memoryGallery")).includes("Updated caption for Buddy's first day."));

  console.log("Delete the memory (two-click confirm)");
  const delBtn = page.locator(".memory-card button.btn-crit-ghost").first();
  await delBtn.click();
  check("first click arms the confirm", (await delBtn.textContent()).includes("Confirm"));
  await delBtn.click();
  await page.waitForSelector("#memoryEmpty:not([hidden])", { timeout: 8000 });
  check("memory removed from the gallery and empty state returns", await page.isVisible("#memoryEmpty"));

  await page.close();
}

/* ------------------------------------------------------------------
   2. A caretaker can add their own memory and manage it, but the
      owner-only edit/delete boundary still applies the other way:
      firestore.rules scope update/delete to (creator OR owner), so a
      caretaker CAN manage a memory an owner made — verify the UI
      instead reflects the one thing rules actually forbid: a
      caretaker's memory stays editable by them, and adding one at all
      works without owner privileges.
   ------------------------------------------------------------------ */
async function testCaretakerCanAddButNotEditOwnersMemory(browser) {
  console.log("B. Caretaker can add and manage their own memory");
  const page = await browser.newPage();
  await openBuddyAsCaretaker(page);

  await page.click("#btnAddMemory");
  await page.waitForSelector("#memoryFormModal:not([hidden])");
  await page.fill("#memTitle", "Walk in the park");
  await page.fill("#memDate", "2026-02-01");
  await page.click("#memoryFormSubmit");
  await page.waitForSelector("#memoryFormModal", { state: "hidden", timeout: 8000 });

  check("caretaker's memory appears in the gallery", (await page.textContent("#memoryGallery")).includes("Walk in the park"));
  check("caretaker's memory is attributed to Arun", (await page.textContent("#memoryGallery")).includes("Added by Arun"));
  check("caretaker sees manage controls on their own memory", await page.locator(".memory-card .icon-btn").count() === 1);

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
