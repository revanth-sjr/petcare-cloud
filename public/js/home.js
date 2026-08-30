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

import { $, $$, esc, toast, openModal, closeAllModals, STATUS_LABEL, STATUS_PILL } from "./ui.js";
import { initAuth, speciesMeta, normaliseCode } from "./auth.js";
import { createStore, buildDashboard } from "./data.js";
import { now, fmtClock, dayPeriod, istTimeToday } from "./time.js";
import { isFirebaseConfigured } from "./config.js";
import { initTheme } from "./theme.js";

let auth = null;
let session = null;
let pets = [];
const petStoreMap = new Map();

boot();

async function boot() {
  initTheme();
  try {
    auth = await initAuth();
    session = await auth.ready;

    /* Auth guard — same rule as index.html: nothing past this line
       assumes a signed-in person. */
    if (!session || (auth.mode === "live" && session.emailVerified === false)) {
      window.location.replace("./login.html");
      return;
    }

    paintUser();
    wireStatic();

    pets = await auth.myPets();
    renderRoleUi();
    if (!pets.length) {
      showEmptyState();
      return;
    }

    renderWelcome();

    /* Setup live store subscriptions so when a care task is logged or completed,
       overdue alerts, KPIs, and pet cards update automatically in real time. */
    await setupLiveStores();

    $("#boot").hidden = true;
    $("#homeMain").hidden = false;

    /* 30s periodic repaint to keep overdue/due-now timers accurate without refreshing */
    setInterval(updateHomeView, 30_000);
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
   Live per-pet store subscription: opens real-time listeners for all
   user's pets. As care logs are completed or added, store updates fire
   and updateHomeView() automatically clears completed overdue alerts!
   ------------------------------------------------------------------ */
async function setupLiveStores() {
  const promises = pets.map((pet) => {
    return new Promise((resolve) => {
      let settled = false;
      createStore(pet.id, { uid: session.uid, email: session.email, name: session.name, role: pet.role })
        .then((store) => {
          petStoreMap.set(pet.id, { pet, store, dash: null });
          store.subscribe((state) => {
            const dash = state?.pet ? buildDashboard(state, now()) : null;
            const entry = petStoreMap.get(pet.id);
            if (entry) {
              entry.dash = dash;
              updateHomeView();
            }
            if (!settled) {
              settled = true;
              resolve();
            }
          });
          setTimeout(() => {
            if (!settled) { settled = true; resolve(); }
          }, 6000);
        })
        .catch(() => {
          petStoreMap.set(pet.id, { pet, store: null, dash: null });
          if (!settled) { settled = true; resolve(); }
        });
    });
  });

  await Promise.all(promises);
  updateHomeView();
}

function updateHomeView() {
  const cards = pets.map((pet) => petStoreMap.get(pet.id) || { pet, dash: null });
  renderOverview(cards);
  renderAlerts(cards);
  renderGallery(cards);
}

/* ------------------------------------------------------------------ */
function paintUser() {
  $("#userName").textContent    = session.name;
  $("#userInitial").textContent = (session.name || "?").charAt(0).toUpperCase();
}

function renderRoleUi() {
  const owned = pets.some((p) => p.role === "owner");
  const caretakerOnly = pets.length > 0 && pets.every((p) => p.role === "caretaker");
  const allCaretaker  = pets.length > 0 && pets.every((p) => p.role === "caretaker");

  const showOwnerActions = session?.role === "owner" || (session?.role !== "caretaker" && (owned || pets.length === 0));

  const role = $("#userRole");
  role.textContent = showOwnerActions ? "owner" : "caretaker";
  role.className = `role-chip ${role.textContent}`;

  if ($("#btnAddPetHome")) $("#btnAddPetHome").hidden = !showOwnerActions;
  if ($("#btnEmptyAddPet")) $("#btnEmptyAddPet").hidden = !showOwnerActions;

  if ($("#btnJoinPetHome")) $("#btnJoinPetHome").hidden = showOwnerActions;
  if ($("#btnEmptyJoinPet")) $("#btnEmptyJoinPet").hidden = showOwnerActions;

  if (!showOwnerActions) {
    $("#welcomeSub").textContent = "Caretaker dashboard: keep every pet's care on track today.";
  }
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
  $$('[data-close-modal]').forEach((button) => {
    button.addEventListener("click", closeAllModals);
  });
  $("#btnSignOut").addEventListener("click", async () => {
    await auth.signOut();
    window.location.replace("./login.html");
  });
  $("#btnEmptyAddPet")?.addEventListener("click", () => {
    window.location.href = "./onboarding.html?mode=add";
  });
  $("#btnAddPetHome")?.addEventListener("click", () => {
    window.location.href = "./onboarding.html?mode=add";
  });

  wireJoinPetModal();

  /* A coarse, immediate signal — the same flag data.js's createStore()
     itself branches on — rather than waiting on every pet's store just
     to paint a badge. */
  const live = isFirebaseConfigured();
  $("#modeBadge").dataset.mode = live ? "live" : "demo";
  $("#modeText").textContent   = live ? "Live · Firestore" : "Demo mode";
}

function wireJoinPetModal() {
  const openJoin = () => {
    $("#joinPetForm")?.reset();
    $("#jpError").hidden = true;
    openModal("joinPetModal");
    setTimeout(() => $("#jpCode")?.focus(), 60);
  };

  $("#btnEmptyJoinPet")?.addEventListener("click", openJoin);
  $("#btnJoinPetHome")?.addEventListener("click", openJoin);

  $("#joinPetForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = normaliseCode($("#jpCode").value);
    const password = $("#jpPassword").value;

    if (!code)     return showJpError("Enter a care code.");
    if (!password) return showJpError("Enter your current password.");

    const btn = $("#jpSubmit");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Verifying…";
    $("#jpError").hidden = true;

    try {
      await auth.joinWithCode(code, password);
      closeAllModals();
      toast("Joined pet care team successfully!", "ok");

      pets = await auth.myPets();
      renderRoleUi();
      await setupLiveStores();
      $("#emptyDash").hidden = true;
      $("#homeMain").hidden = false;
    } catch (err) {
      showJpError(err.message || "Could not join pet. Check code and password.");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

function showJpError(msg) {
  const el = $("#jpError");
  if (el) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    toast(msg, "err");
  }
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
    { icon: '<img src="https://img.icons8.com/ios-filled/50/dog-bowl.png" alt="Feeding" class="ui-icon">', label: "Today's Feeding",     value: feedTarget ? `${feedDone}/${feedTarget}` : "—" },
    { icon: '<img src="https://img.icons8.com/ios-filled/50/pill.png" alt="Medication" class="ui-icon">', label: "Upcoming Medication", value: String(upcomingMeds) },
    { icon: '<img src="https://img.icons8.com/ios-filled/50/warning-shield.png" alt="Warning" class="ui-icon">', label: "Missed Tasks",        value: String(missed), tone: missed ? "bad" : "good" },
    { icon: '<img src="https://img.icons8.com/ios-filled/50/checkmark.png" alt="Check" class="ui-icon">', label: "Completed Tasks",     value: String(completed), tone: "good" }
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
  const wrap  = $("#homeAlerts");
  const list  = $("#homeAlertList");
  const count = $("#homeAlertCount");
  const toggleBtn = $("#btnToggleAlerts");
  const rows  = [];

  for (const { pet, dash } of cards) {
    if (!dash) continue;
    for (const r of dash.alerts.overdue) {
      const label = r.kind === "feeding" ? "Feeding" : r.kind === "walk" ? "Walk" : r.name;
      rows.push({
        tone: "crit", petId: pet.id,
        icon: r.kind === "feeding" ? '<img src="https://img.icons8.com/ios-filled/50/dog-bowl.png" alt="Feeding" class="ui-icon">' : r.kind === "walk" ? '<img src="https://img.icons8.com/ios-filled/50/walking.png" alt="Walk" class="ui-icon">' : '<img src="https://img.icons8.com/ios-filled/50/pill.png" alt="Medication" class="ui-icon">',
        text: `${pet.name}: ${label} overdue — was due ${fmtClock(istTimeToday(r.slot))}`
      });
    }
    for (const r of dash.alerts.dueNow) {
      const label = r.kind === "feeding" ? "Feeding" : r.kind === "walk" ? "Walk" : r.name;
      rows.push({
        tone: "warn", petId: pet.id,
        icon: r.kind === "feeding" ? '<img src="https://img.icons8.com/ios-filled/50/dog-bowl.png" alt="Feeding" class="ui-icon">' : r.kind === "walk" ? '<img src="https://img.icons8.com/ios-filled/50/walking.png" alt="Walk" class="ui-icon">' : '<img src="https://img.icons8.com/ios-filled/50/pill.png" alt="Medication" class="ui-icon">',
        text: `${pet.name}: ${label} due now`
      });
    }
    if (dash.today.overFeeding) {
      rows.push({
        tone: "warn", petId: pet.id, icon: '<img src="https://img.icons8.com/ios-filled/50/warning-shield.png" alt="Warning" class="ui-icon">',
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
  if (count) count.textContent = String(rows.length);

  if (toggleBtn && !toggleBtn._wired) {
    toggleBtn._wired = true;
    list.hidden = true;
    toggleBtn.textContent = `Show details (${rows.length})`;
    toggleBtn.addEventListener("click", () => {
      const isCollapsed = list.hidden;
      list.hidden = !isCollapsed;
      toggleBtn.textContent = !isCollapsed ? `Show details (${rows.length})` : "Collapse";
    });
  } else if (toggleBtn) {
    toggleBtn.textContent = list.hidden ? `Show details (${rows.length})` : "Collapse";
  }

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
    const card = dash ? flashCard(pet, dash) : unavailableCard(pet);
    if (pet.role === "owner") {
      const wrap = document.createElement("div");
      wrap.className = "pet-card-wrap";
      wrap.append(card, deletePetButton(pet));
      grid.appendChild(wrap);
    } else {
      grid.appendChild(card);
    }
  }
}

function deletePetButton(pet) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pet-delete-btn";
  button.textContent = "Remove pet";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    $("#homeDeletePetName").textContent = pet.name || "this pet";
    const confirm = $("#homeDeletePetConfirm");
    confirm.onclick = () => removePet(pet);
    openModal("homeDeletePetModal");
  });
  return button;
}

async function removePet(pet) {
  const confirm = $("#homeDeletePetConfirm");
  confirm.disabled = true;
  try {
    await auth.archivePet(pet.id);
    closeAllModals();
    pets = await auth.myPets();
    if (!pets.length) {
      showEmptyState();
      return;
    }
    renderRoleUi();
    const cards = await Promise.all(pets.map(peekPet));
    renderOverview(cards);
    renderAlerts(cards);
    renderGallery(cards);
    toast(`${pet.name} removed`, "ok");
  } catch (err) {
    toast(err.message || "Could not remove that pet.", "err");
  } finally {
    confirm.disabled = false;
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
      ? `<p class="pfc-next"><img src="https://img.icons8.com/ios-filled/50/22c55e/checkmark.png" alt="Check" class="ui-icon no-invert"> All feedings done for today</p>`
      : `<p class="pfc-next">Next feeding: ${esc(fmtClock(istTimeToday(worstFeed.slot)))}</p>`;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pet-flash-card";
  btn.setAttribute("aria-label", `Open ${p.name || pet.name}'s details`);
  btn.addEventListener("click", () => openPetDetails(pet.id));

  btn.innerHTML = `
    <div class="pfc-photo"${photo ? ` style="background-image:url(${esc(photo)})"` : ""}>
      ${photo ? "" : (meta.icon.includes('<') ? meta.icon : esc(p.emoji || meta.icon))}
    </div>
    <div class="pfc-body">
      <h3 class="pfc-name">${esc(p.name || pet.name)}</h3>
      ${metaLine ? `<p class="pfc-meta">${metaLine}</p>` : ""}

      <div class="pfc-row">
        <span class="pfc-row-label"><img src="https://img.icons8.com/ios-filled/50/dog-bowl.png" alt="Feeding" class="ui-icon"> Feeding</span>
        ${worstFeed
          ? `<span class="pill ${STATUS_PILL[worstFeed.status]}">${STATUS_LABEL[worstFeed.status]}</span>`
          : `<span class="pill p-up">Not configured</span>`}
      </div>
      ${nextFeedLine}

      ${hasMeds ? `
      <div class="pfc-row">
        <span class="pfc-row-label"><img src="https://img.icons8.com/ios-filled/50/pill.png" alt="Medication" class="ui-icon"> Medication</span>
        <span class="pill ${STATUS_PILL[medRow.status]}">${STATUS_LABEL[medRow.status]}</span>
      </div>` : ""}

      ${dash.today.overFeeding ? `<p class="pfc-warn"><img src="https://img.icons8.com/ios-filled/50/warning-shield.png" alt="Warning" class="ui-icon"> Feeding Warning — exceeded today's schedule</p>` : ""}
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
      <span class="pill p-over"><img src="https://img.icons8.com/ios-filled/50/warning-shield.png" alt="Warning" class="ui-icon"> Unavailable</span>
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
