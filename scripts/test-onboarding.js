#!/usr/bin/env node
/* =====================================================================
   scripts/test-onboarding.js
   ---------------------------------------------------------------------
   End-to-end check of the multi-pet onboarding flow, run against demo
   mode (no Firebase project needed) with Playwright + Chromium:

     signup → Welcome → add Max → "add another?" → add Luna → Finish →
     dashboard shows Max selected → switch to Luna, verify isolation →
     switch back to Max, verify unaffected → AI context follows the
     selected pet → log care for Luna → Max's timeline is untouched.

   Usage:  node scripts/test-onboarding.js
   Requires the `playwright` package and its Chromium build.
   ===================================================================== */

const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 5183;
const BASE = `http://localhost:${PORT}`;

let failures = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); }
  else { console.error(`  ✗ ${label}`); failures++; }
}

async function main() {
  const server = spawn("npx", ["--yes", "serve", "public", "-l", String(PORT)], {
    cwd: ROOT, stdio: "ignore", shell: true
  });
  await waitForServer();

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true })
    .catch(() => chromium.launch({ headless: true }));
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("  [page error]", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.error("  [console error]", msg.text()); });

  try {
    console.log("1. Fresh signup as an owner");
    const email = `test-${Date.now()}@petcare.demo`;
    await page.goto(`${BASE}/login.html`);
    await page.click('.auth-tabs button[data-tab="signup"]');
    await page.fill("#suFirstName", "Test");
    await page.fill("#suLastName", "Owner");
    await page.fill("#suEmail", email);
    await page.fill("#suPassword", "petcare123");
    await page.click("#signupSubmit");

    await page.waitForURL(/onboarding\.html/, { timeout: 8000 });
    check("redirected to onboarding after signup (zero pets)", page.url().includes("onboarding.html"));

    console.log("2. Welcome screen → Get started");
    await page.waitForSelector("#screenWelcome:not([hidden])");
    await page.click("#btnGetStarted");
    await page.waitForSelector("#screenAddPet:not([hidden])");

    console.log("3. Add Max (dog)");
    await page.click('#speciesGrid .species-chip[data-species="dog"]');
    check("breed select populated with the dog list", (await page.locator("#fBreed option").allTextContents()).includes("Labrador Retriever"));
    await page.fill("#fName", "Max");
    await page.selectOption("#fBreed", "Labrador Retriever");
    await page.fill("#fAge", "4");
    await page.click("#petFormSubmit");

    await page.waitForSelector("#screenPetAdded:not([hidden])");
    check("confirmation names Max", (await page.textContent("#addedName")).includes("Max"));
    check("Max's preview card shows the selected breed", (await page.textContent("#petPreviewCard")).includes("Labrador Retriever"));

    console.log("4. Add another pet — Luna (cat)");
    await page.click("#btnAddAnother");
    await page.waitForSelector("#screenAddPet:not([hidden])");
    await page.click('#speciesGrid .species-chip[data-species="cat"]');
    check("breed select populated with the cat list", (await page.locator("#fBreed option").allTextContents()).includes("Persian"));
    await page.selectOption("#fBreed", "Persian");
    await page.fill("#fName", "Luna");
    await page.click("#petFormSubmit");

    await page.waitForSelector("#screenPetAdded:not([hidden])");
    check("confirmation names Luna", (await page.textContent("#addedName")).includes("Luna"));
    check("tally mentions 2 pets", (await page.textContent("#addedTally")).includes("2"));

    console.log("5. Finish → Home → dashboard");
    await page.click("#btnFinish");
    await page.waitForURL((u) => u.pathname.endsWith("/home.html"), { timeout: 8000 });
    await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });
    check("Home page's gallery shows both pets", await page.locator(".pet-flash-card").count() === 2);
    check("Home welcomes the signed-up owner by first name", (await page.textContent("#welcomeHeading")).includes("Test"));

    /* Finish already persisted Max as the selected pet via
       auth.setSelectedPetId() — going straight to index.html exercises
       that hand-off exactly like clicking Max's flash card would. */
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });

    check("Max is the pet shown first", (await page.textContent("#petName")).trim() === "Max");
    check("pet switcher shows Max", (await page.textContent("#petSwitcherName")).trim() === "Max");

    console.log("6. Switch to Luna and verify isolation");
    await page.click("#petSwitcherBtn");
    await page.click('.pet-switcher-item:has-text("Luna")');
    await page.waitForFunction(() => document.querySelector("#petName")?.textContent.trim() === "Luna");
    check("dashboard now shows Luna", (await page.textContent("#petName")).trim() === "Luna");
    check("Luna starts with an empty timeline", await page.isVisible("#timelineEmpty"));
    check("Luna's feeding count starts at 0/3", (await page.textContent("#cntFeeding")).trim() === "0 / 3");

    console.log("7. AI assistant follows the selected pet (Luna)");
    await page.click("#aiFab");
    await page.fill("#aiInput", "find a vet nearby");
    await page.click('#aiForm button[type="submit"]');
    await page.waitForFunction(() => document.querySelectorAll(".msg.bot").length >= 2);
    let lastBotMsg = await page.locator(".msg.bot").last().textContent();
    check("AI reply mentions Luna, not Max", lastBotMsg.includes("Luna") && !lastBotMsg.includes("Max"));
    await page.click("#aiClose");

    console.log("8. Log a feeding for Luna");
    await page.click('.action[data-log="feeding"]');
    await page.waitForFunction(() => document.querySelector("#cntFeeding")?.textContent.trim() === "1 / 3");
    check("Luna's feeding count is now 1/3", (await page.textContent("#cntFeeding")).trim() === "1 / 3");

    console.log("9. Switch back to Max — unaffected by Luna's log");
    await page.click("#petSwitcherBtn");
    await page.click('.pet-switcher-item:has-text("Max")');
    await page.waitForFunction(() => document.querySelector("#petName")?.textContent.trim() === "Max");
    check("dashboard shows Max again", (await page.textContent("#petName")).trim() === "Max");
    check("Max's feeding count is still 0/3", (await page.textContent("#cntFeeding")).trim() === "0 / 3");
    check("Max's timeline has no entries", await page.isVisible("#timelineEmpty"));

    console.log("10. AI assistant on Max — no leftover Luna context");
    await page.click("#aiFab");
    await page.fill("#aiInput", "find a vet nearby");
    await page.click('#aiForm button[type="submit"]');
    await page.waitForFunction(
      (prev) => {
        const msgs = document.querySelectorAll(".msg.bot");
        const last = msgs[msgs.length - 1];
        return last && last.textContent !== prev;
      },
      lastBotMsg
    );
    lastBotMsg = await page.locator(".msg.bot").last().textContent();
    check("AI reply now mentions Max, not Luna", lastBotMsg.includes("Max") && !lastBotMsg.includes("Luna"));

    console.log("11. Edit Max's profile — species change and photo skip are optional");
    await page.click("#btnEditPet");
    await page.waitForSelector("#editPetModal:not([hidden])");
    await page.fill("#epNotes", "No special notes for this test.");
    await page.click('#editPetForm button[type="submit"]');
    await page.waitForSelector("#editPetModal", { state: "hidden", timeout: 8000 });
    check("edit modal closed after save", await page.isHidden("#editPetModal"));

  } catch (err) {
    failures++;
    try { await page.screenshot({ path: path.join(ROOT, "scripts", "test-failure.png") }); } catch { /* ignore */ }
    console.error(err.message || err);
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
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
