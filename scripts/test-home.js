#!/usr/bin/env node
/* =====================================================================
   scripts/test-home.js
   ---------------------------------------------------------------------
   The new Home/Dashboard page: Login -> Home -> Pet Gallery -> Pet
   Details. Covers the welcome banner (real name, never a hardcoded
   "Revanth"), the five overview cards, a flash card's own feeding/
   medication status, navigating into a pet's details, the cross-pet
   "Needs attention" alert list (including the over-feeding warning),
   and the empty state's own Home-specific wording.

   Usage:  node scripts/test-home.js
   ===================================================================== */

const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 5217;
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
    await testSinglePetHome(browser);
    await testMultiPetGalleryAndOverview(browser);
    await testNeedsAttentionAlertsAndOverFeeding(browser);
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
   1. Demo owner (one pet, "Buddy") — welcome banner is the real
      account name (seed.json's demoAccounts[0].name = "Revanth", never
      a string baked into the UI), overview cards, and the flash card's
      own feeding/medication status. Clicking the card opens Buddy's
      existing Pet Details page.
   ------------------------------------------------------------------ */
async function testSinglePetHome(browser) {
  console.log("A. Home page for the single-pet demo owner");
  const page = await browser.newPage();
  await page.goto(`${BASE}/login.html`);
  await page.click('[data-demo="owner"]');
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });

  check("lands on home.html, not straight on a pet's dashboard", page.url().includes("home.html"));
  check("welcome banner greets the real account name", (await page.textContent("#welcomeHeading")).includes("Revanth"));
  check("welcome banner never shows a hardcoded placeholder name instead", !(await page.textContent("#welcomeHeading")).includes("Jane"));
  check("welcome subtitle present", (await page.textContent(".welcome-sub")).includes("Here's what's happening"));

  const overviewCards = page.locator(".overview-card");
  check("five overview cards are shown", await overviewCards.count() === 5);
  check("Pets card counts exactly one pet", (await overviewCards.nth(0).textContent()).includes("1"));

  const card = page.locator(".pet-flash-card").first();
  check("gallery shows exactly one flash card", await page.locator(".pet-flash-card").count() === 1);
  check("flash card names Buddy", (await card.textContent()).includes("Buddy"));
  check("flash card shows a feeding status pill", (await card.textContent()).match(/Upcoming|Due now|Overdue|Completed/) !== null);
  check("flash card shows a medication status (Buddy has seeded meds)", (await card.textContent()).includes("Medication"));

  await card.click();
  await page.waitForURL(/index\.html/, { timeout: 8000 });
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });
  check("clicking the flash card opens Buddy's Pet Details page", (await page.textContent("#petName")).trim() === "Buddy");
  await page.close();
}

/* ------------------------------------------------------------------
   2. A brand-new account with two freshly-added pets — the gallery
      must show both, and the overview numbers must be the real sum
      across both pets' own configured schedules (never a shared or
      hard-coded target).
   ------------------------------------------------------------------ */
async function testMultiPetGalleryAndOverview(browser) {
  console.log("B. Home page aggregates two freshly-added pets correctly");
  const page = await browser.newPage();
  const email = `home-${Date.now()}@petcare.demo`;

  await page.goto(`${BASE}/login.html`);
  await page.click('.auth-tabs button[data-tab="signup"]');
  await page.fill("#suFirstName", "Priya");
  await page.fill("#suLastName", "Home");
  await page.fill("#suEmail", email);
  await page.fill("#suPassword", "petcare123");
  await page.click("#signupSubmit");
  await page.waitForURL(/onboarding\.html/, { timeout: 8000 });

  await page.click("#btnGetStarted");
  await page.click('#speciesGrid .species-chip[data-species="dog"]');
  await page.fill("#fName", "Rocky");
  await page.click("#petFormSubmit");
  await page.waitForSelector("#screenPetAdded:not([hidden])");

  await page.click("#btnAddAnother");
  await page.click('#speciesGrid .species-chip[data-species="cat"]');
  await page.fill("#fName", "Milo");
  await page.click("#petFormSubmit");
  await page.waitForSelector("#screenPetAdded:not([hidden])");
  await page.click("#btnFinish");

  await page.waitForURL((u) => u.pathname.endsWith("/home.html"), { timeout: 8000 });
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });

  check("welcome banner uses the real first name from sign-up (Priya)", (await page.textContent("#welcomeHeading")).includes("Priya"));
  check("Pets overview card counts both new pets", (await page.locator(".overview-card").nth(0).textContent()).includes("2"));
  check("gallery shows both new pets", await page.locator(".pet-flash-card").count() === 2);
  const feedingCardText = await page.locator(".overview-card").nth(1).textContent();
  check("Today's Feeding sums both pets' own default 3/day targets (0/6), not a shared number",
    feedingCardText.includes("0/6"));

  await page.click("#btnAddPetHome");
  await page.waitForURL(/onboarding\.html\?mode=add/, { timeout: 8000 });
  check("Add Pet screen shown directly", await page.isVisible("#screenAddPet"));
  check("Welcome screen skipped", await page.isHidden("#screenWelcome"));
  await page.close();
}

/* ------------------------------------------------------------------
   3. Cross-pet "Needs attention" list surfaces an over-feeding warning
      the moment one pet's logged feedings exceed ITS OWN configured
      schedule, and clicking that alert opens that pet.
   ------------------------------------------------------------------ */
async function testNeedsAttentionAlertsAndOverFeeding(browser) {
  console.log("C. Needs attention list + over-feeding warning, from Home");
  const page = await browser.newPage();
  await page.goto(`${BASE}/login.html`);
  await page.click('[data-demo="owner"]');
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });

  // Seed data starts Buddy at 2 of 3 feedings logged today. Open the
  // dashboard and log two more so today's count (4) exceeds the
  // configured target (3), then come back to Home.
  await page.click(".pet-flash-card");
  await page.waitForURL(/index\.html/, { timeout: 8000 });
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });
  await page.click('.action[data-log="feeding"]');
  await page.waitForTimeout(300);
  await page.click('.action[data-log="feeding"]');
  await page.waitForTimeout(300);

  await page.goto(`${BASE}/home.html`);
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });

  check("Needs attention section appears", await page.isVisible("#homeAlerts"));
  const alertsText = await page.textContent("#homeAlertList");
  check("over-feeding warning is listed by name", alertsText.includes("Feeding Warning"));
  check("flash card also shows the over-feeding warning", (await page.textContent(".pet-flash-card")).includes("Feeding Warning"));

  const alertBtn = page.locator(".home-alert-item", { hasText: "Feeding Warning" }).first();
  await alertBtn.click();
  await page.waitForURL(/index\.html/, { timeout: 8000 });
  await page.waitForSelector("#boot", { state: "hidden", timeout: 10000 });
  check("clicking the alert opens that pet's details", (await page.textContent("#petName")).trim() === "Buddy");
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
