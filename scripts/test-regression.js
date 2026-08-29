#!/usr/bin/env node
/* =====================================================================
   scripts/test-regression.js
   ---------------------------------------------------------------------
   Covers what test-onboarding.js doesn't: the existing single-pet demo
   experience (unchanged for someone who never touches multi-pet), the
   skip-onboarding → empty-state path, adding a pet from the dashboard
   empty state, and archiving a pet back down to zero.

   Usage:  node scripts/test-regression.js
   ===================================================================== */

const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 5187;
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
    await testDemoOwnerLogin(browser);
    await testSkipOnboardingThenAddFromEmptyState(browser);
    await testArchiveOnlyPetReturnsToEmptyState(browser);
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

/* ------------------------------------------------------------------
   1. The pre-existing single-pet demo experience must be completely
      unaffected by multi-pet: the owner demo account still opens
      straight onto Buddy's dashboard with meds, timeline, care team.
   ------------------------------------------------------------------ */
async function testDemoOwnerLogin(browser) {
  console.log("A. Existing single-pet demo account (owner@petcare.demo)");
  const page = await browser.newPage();
  await page.goto(`${BASE}/login.html`);
  await page.click('[data-demo="owner"]');
  await openFirstPetFromHome(page);

  check("Buddy's dashboard loads for the owner demo account", (await page.textContent("#petName")).trim() === "Buddy");
  check("owner role chip shown", (await page.textContent("#userRole")).trim().toLowerCase() === "owner");
  check("medication schedule is populated", (await page.locator("#medList .med-item").count()) > 0);
  check("care team shows the seeded caretaker", (await page.textContent("#caretakerList")).includes("Arun"));
  check("join code box is visible to the owner", await page.isVisible("#joinCodeBox"));
  check("edit-pet button visible to the owner", await page.isVisible("#btnEditPet"));
  await page.close();
}

/* ------------------------------------------------------------------
   2. Skipping onboarding must not redirect-loop — it should land on
      the dashboard's empty state, which offers its own way to add a
      first pet (mode=add, no Welcome screen).
   ------------------------------------------------------------------ */
async function testSkipOnboardingThenAddFromEmptyState(browser) {
  console.log("B. Skip onboarding → empty state → add first pet from there");
  const page = await browser.newPage();
  const email = `skip-${Date.now()}@petcare.demo`;

  await page.goto(`${BASE}/login.html`);
  await page.click('.auth-tabs button[data-tab="signup"]');
  await page.fill("#suFirstName", "Skip");
  await page.fill("#suLastName", "Tester");
  await page.fill("#suEmail", email);
  await page.fill("#suPassword", "petcare123");
  await page.click("#signupSubmit");

  await page.waitForURL(/onboarding\.html/, { timeout: 8000 });
  await page.waitForSelector("#screenWelcome:not([hidden])");
  await page.click("#btnSkip");

  await page.waitForURL((u) => u.pathname.endsWith("/home.html"), { timeout: 8000 });
  check("empty state is shown, not a redirect loop", await page.isVisible("#emptyDash"));
  check("home content is hidden while empty", await page.isHidden("#homeMain"));

  await page.click("#btnEmptyAddPet");
  await page.waitForURL(/onboarding\.html\?mode=add/, { timeout: 8000 });
  check("empty-state CTA jumps straight to the Add Pet screen", await page.isVisible("#screenAddPet"));
  check("Welcome screen is skipped in mode=add", await page.isHidden("#screenWelcome"));

  await page.click('#speciesGrid .species-chip[data-species="rabbit"]');
  await page.fill("#fName", "Clover");
  await page.click("#petFormSubmit");
  await page.waitForSelector("#screenPetAdded:not([hidden])");
  await page.click("#btnFinish");

  await openFirstPetFromHome(page);
  check("dashboard now shows the pet added from the empty state", (await page.textContent("#petName")).trim() === "Clover");
  await page.close();
}

/* ------------------------------------------------------------------
   3. Archiving an owner's only pet must drop them back to the empty
      state, not to an error or a blank dashboard.
   ------------------------------------------------------------------ */
async function testArchiveOnlyPetReturnsToEmptyState(browser) {
  console.log("C. Archiving the only pet returns to the empty state");
  const page = await browser.newPage();
  const email = `archive-${Date.now()}@petcare.demo`;

  await page.goto(`${BASE}/login.html`);
  await page.click('.auth-tabs button[data-tab="signup"]');
  await page.fill("#suFirstName", "Archive");
  await page.fill("#suLastName", "Tester");
  await page.fill("#suEmail", email);
  await page.fill("#suPassword", "petcare123");
  await page.click("#signupSubmit");

  await page.waitForURL(/onboarding\.html/, { timeout: 8000 });
  await page.click("#btnGetStarted");
  await page.click('#speciesGrid .species-chip[data-species="hamster"]');
  await page.fill("#fName", "Peanut");
  await page.click("#petFormSubmit");
  await page.waitForSelector("#screenPetAdded:not([hidden])");
  await page.click("#btnFinish");
  await openFirstPetFromHome(page);

  await page.click("#btnEditPet");
  await page.waitForSelector("#editPetModal:not([hidden])");
  await page.click("#btnArchivePet");
  await page.waitForSelector("#archivePetModal:not([hidden])");
  check("archive confirmation names the pet", (await page.textContent("#archivePetName")).includes("Peanut"));
  await page.click("#archivePetConfirm");

  await page.waitForSelector("#emptyDash:not([hidden])", { timeout: 8000 });
  check("back to the empty state after archiving the only pet", await page.isVisible("#emptyDash"));
  await page.close();
}

/* ------------------------------------------------------------------
   Login and "Finish" onboarding now land on the Home page first (its
   pet gallery), not straight on a pet's dashboard. Every test above was
   written against the dashboard (index.html), so this hops through the
   first pet's flash card exactly the way a person clicking into their
   pet would, then waits for that dashboard to finish loading. ------- */
async function openFirstPetFromHome(page) {
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });
  await page.waitForSelector(".pet-flash-card", { timeout: 10000 });
  await page.click(".pet-flash-card");
  await page.waitForURL(/index\.html/, { timeout: 8000 });
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });
  // #boot hides the instant the first snapshot arrives; wait for the pet
  // name to actually be painted too, so a click right after this call
  // never races repaint() on a slow store load.
  await page.waitForFunction(() => {
    const el = document.querySelector("#petName");
    return el && el.textContent.trim() !== "" && el.textContent.trim() !== "—";
  }, { timeout: 10000 });
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
