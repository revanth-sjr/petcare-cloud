/* =====================================================================
   home.js — the Home / Dashboard page.
   ---------------------------------------------------------------------
   Login -> Home -> Pet Gallery / Select Pet -> Pet Details (index.html).
   This page never invents its own data model: every number and status
   shown here — feeding counts, medication status, the over-feeding
   warning — comes from the exact same createStore()/buildDashboard()
   pipeline index.html's dashboard already uses. For each pet this page
   "peeks" a store — subscribe, take the first snapshot, dispose — so a
   multi-pet household never leaves more than one Firestore listener
   open from this page at a time.
   ===================================================================== */

import { $, esc, STATUS_LABEL, STATUS_PILL } from "./ui.js";
import { initAuth, speciesMeta } from "./auth.js";
import { createStore, buildDashboard } from "./data.js";
import { now, fmtClock, dayPeriod, istTimeToday } from "./time.js";
import { isFirebaseConfigured } from "./config.js";

let auth = null;
let session = null;
let pets = [];

boot();

async function boot() {
  try {
    auth = await initAuth();
    session = await auth.ready;

    /* Auth guard — same rule as index.html: nothing past this line
       assumes a signed-in person. */
    if (!session) {
      window.location.replace("./login.html");
      return;
    }

    paintUser();
    wireStatic();

    pets = await auth.myPets();
    if (!pets.length) {
      showEmptyState();
      return;
    }

    renderWelcome();

    const cards = await Promise.all(pets.map(peekPet));

    renderOverview(cards);
    renderAlerts(cards);
    renderGallery(cards);

    $("#boot").hidden = true;
    $("#homeMain").hidden = false;
  } catch (err) {
    console.error("[PetCare] Home page failed to load", err);
    const b = $("#boot");
    b.className = "boot boot-warn";
    b.innerHTML =
      '<span class="boot-mark">🐾</span>' +
      '<p class="boot-warn-title">This is taking longer than it should.</p>' +
      "<p>Your pets' status never arrived — check your connection and try reloading.</p>" +
      '<button class="btn btn-primary btn-sm" type="button" onclick="location.reload()">Reload</button>';
  }
}

/* ------------------------------------------------------------------
   Per-pet "peek": open the exact same store index.html would open,
   take one snapshot, build the exact same dashboard contract, then
   dispose. A pet this account can no longer reach (access revoked,
   flaky connection) resolves to dash:null after a short timeout
   instead of hanging the whole page — it still shows as a card, just
   one that says so, rather than silently vanishing from the gallery.
   ------------------------------------------------------------------ */
function peekPet(pet) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (store, dash) => {
      if (settled) return;
      settled = true;
      try { store?.dispose?.(); } catch { /* best effort */ }
      resolve({ pet, dash });
    };

    createStore(pet.id, { uid: session.uid, email: session.email, name: session.name, role: pet.role })
      .then((store) => {
        store.subscribe((state) => {
          finish(store, state?.pet ? buildDashboard(state, now()) : null);
        });
        setTimeout(() => finish(store, null), 6000);
      })
      .catch(() => finish(null, null));
  });
}

/* ------------------------------------------------------------------ */
function paintUser() {
  $("#userName").textContent    = session.name;
  $("#userInitial").textContent = (session.name || "?").charAt(0).toUpperCase();
}

function renderWelcome() {
  const first = (session.firstName || session.name || "").trim().split(/\s+/)[0] || "there";
  $("#welcomeHeading").textContent = `Good ${dayPeriod(now())}, ${first}.`;
}

function showEmptyState() {
  $("#boot").hidden     = true;
  $("#emptyDash").hidden = false;
}

function wireStatic() {
  $("#btnSignOut").addEventListener("click", async () => {
    await auth.signOut();
    window.location.replace("./login.html");
  });
  $("#btnEmptyAddPet").addEventListener("click", () => {
    /* Same as index.html's own empty-state CTA: straight to the Add Pet
       screen, no Welcome screen — this account has already been through
       sign-up (and possibly onboarding once before, if this is a zero
       state from archiving a last pet rather than a brand-new account). */
    window.location.href = "./onboarding.html?mode=add";
  });
  $("#btnAddPetHome").addEventListener("click", () => {
    window.location.href = "./onboarding.html?mode=add";
  });

  /* A coarse, immediate signal — the same flag data.js's createStore()
     itself branches on — rather than waiting on every pet's store just
     to paint a badge. */
  const live = isFirebaseConfigured();
  $("#modeBadge").dataset.mode = live ? "live" : "demo";
  $("#modeText").textContent   = live ? "Live · Firestore" : "Demo mode";
}

/* ------------------------------------------------------------------
   Overview cards — Pets / Today's Feeding / Upcoming Medication /
   Missed Tasks / Completed Tasks. Every number is summed straight off
   each pet's own dash.today (itself built from that pet's own
   configured feeding schedule and medications — never a shared or
   hard-coded target).
   ------------------------------------------------------------------ */
function renderOverview(cards) {
  const valid = cards.filter((c) => c.dash);

  let feedDone = 0, feedTarget = 0, upcomingMeds = 0, missed = 0, completed = 0;
  for (const { dash } of valid) {
    const { counts, targets } = dash.today;
    feedDone     += counts.feeding;
    feedTarget   += targets.feeding;
    completed    += counts.feeding + counts.walk + counts.medication;
    missed       += dash.alerts.overdue.length;
    upcomingMeds += dash.medications.filter((m) => m.status === "UPCOMING" || m.status === "DUE_NOW").length;
  }

  const items = [
    { icon: "🐾", label: "Pets",                value: String(cards.length) },
    { icon: "🍖", label: "Today's Feeding",     value: feedTarget ? `${feedDone}/${feedTarget}` : "—" },
    { icon: "💊", label: "Upcoming Medication", value: String(upcomingMeds) },
    { icon: "⚠️", label: "Missed Tasks",        value: String(missed), tone: missed ? "bad" : "good" },
    { icon: "✅", label: "Completed Tasks",     value: String(completed), tone: "good" }
  ];

  $("#overviewGrid").innerHTML = items.map((it) => `
    <div class="overview-card${it.tone ? ` is-${it.tone}` : ""}">
      <span class="overview-icon" aria-hidden="true">${it.icon}</span>
      <div class="overview-body">
        <b>${esc(it.value)}</b>
        <span>${esc(it.label)}</span>
      </div>
    </div>`).join("");
}

/* ------------------------------------------------------------------
   Cross-pet alerts: every OVERDUE / DUE_NOW row and every pet whose
   over-feeding warning is on, from every pet at once. Text always
   states a fact off dash.alerts / dash.today.overFeeding — nothing
   here is a second, separately-maintained rule about what "overdue"
   or "over-fed" means. Not color-only: every row leads with an icon
   and states the status in words.
   ------------------------------------------------------------------ */
function renderAlerts(cards) {
  const wrap = $("#homeAlerts");
  const list = $("#homeAlertList");
  const rows = [];

  for (const { pet, dash } of cards) {
    if (!dash) continue;
    for (const r of dash.alerts.overdue) {
      const label = r.kind === "feeding" ? "Feeding" : r.name;
      rows.push({
        tone: "crit", petId: pet.id,
        icon: r.kind === "feeding" ? "🍖" : "💊",
        text: `${pet.name}: ${label} overdue — was due ${fmtClock(istTimeToday(r.slot))}`
      });
    }
    for (const r of dash.alerts.dueNow) {
      const label = r.kind === "feeding" ? "Feeding" : r.name;
      rows.push({
        tone: "warn", petId: pet.id,
        icon: r.kind === "feeding" ? "🍖" : "💊",
        text: `${pet.name}: ${label} due now`
      });
    }
    if (dash.today.overFeeding) {
      rows.push({
        tone: "warn", petId: pet.id, icon: "⚠️",
        text: `${pet.name}: Feeding Warning — exceeded today's planned schedule`
      });
    }
  }

  if (!rows.length) {
    wrap.hidden = true;
    list.innerHTML = "";
    return;
  }

  wrap.hidden = false;
  list.innerHTML = "";
  for (const row of rows) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `home-alert-item is-${row.tone}`;
    btn.innerHTML = `<span class="home-alert-icon" aria-hidden="true">${row.icon}</span><span>${esc(row.text)}</span>`;
    btn.addEventListener("click", () => openPetDetails(row.petId));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

/* ------------------------------------------------------------------
   Pet gallery — flash cards. Each one shows the same status vocabulary
   (STATUS_LABEL/STATUS_PILL) already used on the Pet Details dashboard,
   so "Overdue" or "Due now" means the same thing everywhere in the app.
   ------------------------------------------------------------------ */
const RANK = { OVERDUE: 0, DUE_NOW: 1, UPCOMING: 2, COMPLETED: 3 };

function renderGallery(cards) {
  const grid = $("#petGallery");
  grid.innerHTML = "";
  for (const { pet, dash } of cards) {
    grid.appendChild(dash ? flashCard(pet, dash) : unavailableCard(pet));
  }
}

function flashCard(pet, dash) {
  const p = dash.pet || pet;
  const meta = speciesMeta(p.species);
  const photo = p.photoURL;

  const feedRows = dash.feedingSchedule?.rows || [];
  const worstFeed = feedRows.length
    ? [...feedRows].sort((a, b) => RANK[a.status] - RANK[b.status])[0]
    : null;
  const allFeedDone = feedRows.length > 0 && feedRows.every((r) => r.status === "COMPLETED");

  const hasMeds = dash.medications.length > 0;
  const allMedDone = hasMeds && dash.medications.every((m) => m.status === "COMPLETED");
  const medRow = hasMeds ? (allMedDone ? { status: "COMPLETED" } : dash.nextMedication) : null;

  const ageText = p.ageYears ? `${p.ageYears} yr` : null;
  const metaLine = [meta.label, p.breed, ageText].filter(Boolean).map(esc).join(" · ");

  const nextFeedLine = !feedRows.length
    ? ""
    : allFeedDone
      ? `<p class="pfc-next">✅ All feedings done for today</p>`
      : `<p class="pfc-next">Next feeding: ${esc(fmtClock(istTimeToday(worstFeed.slot)))}</p>`;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pet-flash-card";
  btn.setAttribute("aria-label", `Open ${p.name || pet.name}'s details`);
  btn.addEventListener("click", () => openPetDetails(pet.id));

  btn.innerHTML = `
    <div class="pfc-photo"${photo ? ` style="background-image:url(${esc(photo)})"` : ""}>
      ${photo ? "" : esc(p.emoji || meta.icon)}
    </div>
    <div class="pfc-body">
      <h3 class="pfc-name">${esc(p.name || pet.name)}</h3>
      ${metaLine ? `<p class="pfc-meta">${metaLine}</p>` : ""}

      <div class="pfc-row">
        <span class="pfc-row-label">🍖 Feeding</span>
        ${worstFeed
          ? `<span class="pill ${STATUS_PILL[worstFeed.status]}">${STATUS_LABEL[worstFeed.status]}</span>`
          : `<span class="pill p-up">Not configured</span>`}
      </div>
      ${nextFeedLine}

      ${hasMeds ? `
      <div class="pfc-row">
        <span class="pfc-row-label">💊 Medication</span>
        <span class="pill ${STATUS_PILL[medRow.status]}">${STATUS_LABEL[medRow.status]}</span>
      </div>` : ""}

      ${dash.today.overFeeding ? `<p class="pfc-warn">⚠️ Feeding Warning — exceeded today's schedule</p>` : ""}
    </div>`;

  return btn;
}

function unavailableCard(pet) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pet-flash-card pet-flash-card--unavailable";
  btn.setAttribute("aria-label", `${pet.name} — status unavailable, open details`);
  btn.addEventListener("click", () => openPetDetails(pet.id));
  btn.innerHTML = `
    <div class="pfc-photo">${esc(pet.emoji || "🐾")}</div>
    <div class="pfc-body">
      <h3 class="pfc-name">${esc(pet.name)}</h3>
      <p class="pfc-meta">Could not load today's status right now.</p>
      <span class="pill p-over">⚠️ Unavailable</span>
    </div>`;
  return btn;
}

/* Persist the choice through the same auth.setSelectedPetId() call
   index.html's own pet switcher uses, then hand off — index.html's
   boot() reads it right back via auth.getSelectedPetId(). */
async function openPetDetails(petId) {
  try { await auth.setSelectedPetId(petId); } catch { /* index.html falls back to pets[0] anyway */ }
  window.location.href = "./index.html";
}
