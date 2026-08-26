#!/usr/bin/env node
/* =====================================================================
   scripts/test-features.js
   ---------------------------------------------------------------------
   Covers the feature set added on top of the existing multi-pet app:
   pet-type -> breed cascade (incl. "Other"), per-pet customizable
   feeding schedule + calendar, medication add/edit/delete, and the
   caretaker edit-yes/delete-no permission split. Existing single-pet
   demo behaviour and the onboarding flow are covered by
   test-regression.js and test-onboarding.js respectively — this script
   does not repeat those checks.

   Usage:  node scripts/test-features.js
   ===================================================================== */

const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 5193;
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
    await testBreedCascade(browser);
    await testFeedingScheduleAndCalendar(browser);
    await testMedicationCrud(browser);
    await testCaretakerPermissions(browser);
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
   1. Pet type -> breed cascade: every type shows its own curated list,
      and "Other" reveals a free-text field that round-trips.
   ------------------------------------------------------------------ */
async function testBreedCascade(browser) {
  console.log("A. Pet type -> breed cascade");
  const page = await browser.newPage();
  const email = `cascade-${Date.now()}@petcare.demo`;
  await signUp(page, email);
  await page.click("#btnGetStarted");

  const cases = [
    ["dog", "Golden Retriever"], ["cat", "Persian"], ["bird", "Cockatiel"],
    ["fish", "Betta"], ["rabbit", "Mini Rex"], ["hamster", "Syrian"], ["reptile", "Gecko"]
  ];
  for (const [type, breed] of cases) {
    await page.click(`#speciesGrid .species-chip[data-species="${type}"]`);
    const options = await page.locator("#fBreed option").allTextContents();
    check(`${type} breed list includes "${breed}"`, options.includes(breed));
    check(`${type} breed list ends in "Other"`, options[options.length - 1] === "Other");
  }

  await page.click('#speciesGrid .species-chip[data-species="other"]');
  await page.selectOption("#fBreed", "Other");
  check("Other reveals the custom text field", await page.isVisible("#fBreedOtherWrap"));
  await page.fill("#fBreedOther", "Chinchilla");
  await page.fill("#fName", "Custom Pet");
  await page.click("#petFormSubmit");
  await page.waitForSelector("#screenPetAdded:not([hidden])");
  check("custom breed shows on the preview card", (await page.textContent("#petPreviewCard")).includes("Chinchilla"));
  await page.close();
}

/* ------------------------------------------------------------------
   2. Feeding schedule is per-pet and customizable, drives the dashboard
      card, and the calendar's month/week views reflect it.
   ------------------------------------------------------------------ */
async function testFeedingScheduleAndCalendar(browser) {
  console.log("B. Customizable feeding schedule + calendar");
  const page = await browser.newPage();
  const email = `feeding-${Date.now()}@petcare.demo`;
  await signUp(page, email);
  await page.click("#btnGetStarted");
  await page.click('#speciesGrid .species-chip[data-species="dog"]');
  await page.fill("#fName", "Scout");
  await page.click("#feedingTimesEditor .feed-time-add");           // 3 -> 4 times
  await page.click("#petFormSubmit");
  await page.waitForSelector("#screenPetAdded:not([hidden])");
  await page.click("#btnFinish");
  await openFirstPetFromHome(page);

  check("feeding target reflects the 4 configured times", (await page.textContent("#cntFeeding")).trim() === "0 / 4");
  check("feeding schedule card lists 4 rows", await page.locator("#feedingScheduleList .med-item").count() === 4);

  const firstBtn = page.locator("#feedingScheduleList .med-item button", { hasText: "Mark as given" }).first();
  await firstBtn.click();
  await page.waitForFunction(() => document.querySelector("#cntFeeding")?.textContent.trim() === "1 / 4");
  check("marking one feeding time given updates the count", true);

  await page.click("#btnOpenCalendar");
  await page.waitForSelector("#calendarModal:not([hidden])");
  check("month view renders a 6x7 grid", await page.locator("#calMonthGrid .cal-cell").count() === 42);
  await page.click("#calTabWeek");
  await page.waitForTimeout(200);
  const todayCard = page.locator(".cal-day-card.is-today");
  check("week view's today card has the pet's own 4 feeding rows", await todayCard.locator(".med-item").count() === 4);
  await page.close();
}

/* ------------------------------------------------------------------
   3. Medication add / edit / delete — the feature that did not exist
      at all before this pass.
   ------------------------------------------------------------------ */
async function testMedicationCrud(browser) {
  console.log("C. Medication add / edit / delete");
  const page = await browser.newPage();
  await page.goto(`${BASE}/login.html`);
  await page.click('[data-demo="owner"]');
  await openFirstPetFromHome(page);

  await page.click("#btnManageMeds");
  await page.waitForSelector("#medManageModal:not([hidden])");
  const startCount = await page.locator("#medManageList .med-manage-item").count();

  await page.click("#btnAddMed");
  await page.waitForSelector("#medFormModal:not([hidden])");
  await page.fill("#medName", "Test Med");
  await page.fill("#medDosage", "10mg");
  await page.selectOption("#medFrequency", "Once daily");
  await page.click('#medForm button[type="submit"]');
  await page.waitForSelector("#medManageModal:not([hidden])", { timeout: 8000 });
  check("medication added", await page.locator("#medManageList .med-manage-item").count() === startCount + 1);
  check("new medication shows on the dashboard", (await page.textContent("#medList")).includes("Test Med"));

  const item = page.locator("#medManageList .med-manage-item", { hasText: "Test Med" });
  await item.locator('.icon-btn[title="Edit this medication"]').click();
  await page.waitForSelector("#medFormModal:not([hidden])");
  check("edit form opens pre-filled", await page.inputValue("#medName") === "Test Med");
  await page.fill("#medDosage", "20mg");
  await page.click('#medForm button[type="submit"]');
  await page.waitForSelector("#medManageModal:not([hidden])", { timeout: 8000 });
  check("edit persisted", (await item.textContent()).includes("20mg"));

  const stopBtn = item.locator('.icon-btn[title="Stop this medication"]');
  await stopBtn.click();
  await page.waitForFunction(() => document.querySelector("#medManageList")?.textContent.includes("Stopped"));
  check("stopping a medication marks it Stopped without deleting it", await page.locator("#medManageList .med-manage-item", { hasText: "Test Med" }).count() === 1);
  check("a stopped medication drops out of today's dashboard checklist", !(await page.textContent("#medList")).includes("Test Med"));
  await item.locator('.icon-btn[title="Resume this medication"]').click();
  await page.waitForFunction(() => document.querySelector("#medList")?.textContent.includes("Test Med"));
  check("resuming a medication brings it back to today's checklist", (await page.textContent("#medList")).includes("Test Med"));

  const delBtn = item.locator(".med-manage-actions button.btn-crit-ghost");
  await delBtn.click();
  await delBtn.click();
  await page.waitForTimeout(300);
  check("delete requires a second confirm click and then removes it", await page.locator("#medManageList .med-manage-item", { hasText: "Test Med" }).count() === 0);
  await page.close();
}

/* ------------------------------------------------------------------
   4. Caretaker can edit a pet's details but never delete it, and has no
      access to medication management — enforced in the UI here; the
      matching Firestore rule (memberDetailUpdate) is what enforces it
      server-side in live mode.
   ------------------------------------------------------------------ */
async function testCaretakerPermissions(browser) {
  console.log("D. Caretaker: edit yes, delete no");
  const page = await browser.newPage();
  await page.goto(`${BASE}/login.html`);
  await page.click('[data-demo="caretaker"]');
  await openFirstPetFromHome(page);

  check("caretaker can open Edit pet", await page.isVisible("#btnEditPet"));
  await page.click("#btnEditPet");
  await page.waitForSelector("#editPetModal:not([hidden])");
  check("Archive/Remove pet is hidden for a caretaker", await page.isHidden("#btnArchivePet"));
  await page.fill("#epNotes", "Edited by caretaker in an automated check.");
  await page.click('#editPetForm button[type="submit"]');
  await page.waitForSelector("#editPetModal", { state: "hidden", timeout: 8000 });
  check("caretaker's edit saved without a permission error", true);

  await page.click("#btnManageMeds");
  await page.waitForSelector("#medManageModal:not([hidden])");
  check("caretaker cannot add medications", await page.isHidden("#btnAddMed"));
  check("caretaker sees the read-only note", await page.isVisible("#medManageReadonlyNote"));
  check("caretaker sees no edit/delete controls", await page.locator("#medManageList .med-manage-actions").count() === 0);
  await page.close();
}

/* ------------------------------------------------------------------
   Login and "Finish" onboarding now land on the Home page first (its
   pet gallery), not straight on a pet's dashboard. Every test below was
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

/* ------------------------------------------------------------------ */
async function signUp(page, email) {
  await page.goto(`${BASE}/login.html`);
  await page.click('.auth-tabs button[data-tab="signup"]');
  await page.fill("#suFirstName", "Feature");
  await page.fill("#suLastName", "Tester");
  await page.fill("#suEmail", email);
  await page.fill("#suPassword", "petcare123");
  await page.click("#signupSubmit");
  await page.waitForURL(/onboarding\.html/, { timeout: 8000 });
  await page.waitForSelector("#screenWelcome:not([hidden])");
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
