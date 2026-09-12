/* =====================================================================
   app.js — bootstrap and wiring.
   Pod D (integrator) owns this file — it is the one place the pods meet.
   ---------------------------------------------------------------------
   Multi-pet: a signed-in person can have several pets. `pets` is the
   trimmed list from auth.myPets(); `currentPet` is whichever one of
   those is open right now, and it is where "role" (owner/caretaker)
   actually lives — the same person can be the owner of one pet and a
   caretaker on another, so role is never a global.

   Switching pets disposes the old store and opens a new one scoped to
   the new petId — nothing more. store-firebase.js already isolates
   every subcollection under pets/{petId}, so there is no cross-pet
   leakage to guard against here, only bookkeeping.
   ===================================================================== */

import { $, $$, toast, showNotification, showActionToast, openModal, closeModal, closeAllModals, esc } from "./ui.js";
import { createStore, buildDashboard, TASK_META } from "./data.js";
import {
  setTimeOffsetMs, getTimeOffsetMs, fmtClock, fmtDate, now, realNow, istTimeToday
} from "./time.js";
import { GRACE_MINUTES, UNDO_WINDOW_SECONDS } from "./config.js";
import { initAuth, speciesMeta, validatePetForm, normaliseCode } from "./auth.js";
import { wireSpeciesGrid, wireBreedSelect, wireFeedingScheduleEditor, wirePhotoPicker } from "./pets-ui.js";
import * as dashboardView from "./dashboard.js";
import * as timelineView from "./timeline.js";
import * as caretakersView from "./caretakers.js";
import * as healthView from "./health.js";
import * as kpiView from "./kpi.js";
import * as calendarView from "./calendar.js";
import * as medicationsView from "./medications.js";
import * as binView from "./bin.js";
import * as memoriesView from "./memories.js";
import * as chat from "./chat.js";
import { setVets, showVets } from "./vets.js";
import { exportCsv, exportHandoff, exportTxt } from "./export.js";
import { initTheme } from "./theme.js";

let auth = null;
let session = null;          // identity only: {uid, email, name, lastSelectedPetId}
let pets = [];                // trimmed list from auth.myPets()
let currentPet = null;        // the pets[] entry that is open right now — carries .role
let selectedPetId = null;
let store = null;
let ctx = null;               // shared with caretakers.js / health.js; .store is swapped in place
let state = { pet: null, medications: [], logs: [], caretakers: [], vaccinations: [], weights: [], vets: [], trash: [], memories: [] };
let dash = null;
const sentCareNotifications = new Set();

let epSpecies = null;         // edit-pet species grid controller
let epBreed = null;           // edit-pet breed select controller
let epFeeding = null;         // edit-pet feeding-schedule editor controller
let epPhoto = null;           // edit-pet photo picker controller

/* ------------------------------------------------------------------ */
boot();

async function boot() {
  initTheme();
  auth = await initAuth();
  session = await auth.ready;

  /* Auth guard. Everything past this line assumes a signed-in person. */
  if (!session || (auth.mode === "live" && session.otpVerified !== true)) {
    window.location.replace("./login.html");
    return;
  }

  paintUser();
  wireStaticUi();
  wirePetSelector();
  wireEditArchive();
  chat.init();

  pets = await auth.myPets();
  if (!pets.length) {
    /* Zero pets — could be a brand new account that skipped onboarding,
       or the owner's only pet was just archived. Either way this is not
       an error state: show the empty dashboard, not a redirect loop. */
    showEmptyState();
    return;
  }

  ctx = {
    store: null,
    repaint,
    userName: () => session.name,
    latestWeight: () => dash?.health?.latestWeight?.valueKg ?? null
  };
  caretakersView.init(ctx);
  healthView.init(ctx);
  medicationsView.init({
    medications: () => state.medications,
    addMedication:    (payload)      => store.addMedication(payload),
    updateMedication: (id, patch)    => store.updateMedication(id, patch),
    deleteMedication: (id)           => store.deleteMedication(id),
    repaint
  });
  binView.init({
    trash:   () => dash?.trash || [],
    medName: (id) => dash?.medications.find((m) => m.medicationId === id)?.name || "Medication",
    restore:            (trashId) => store.restoreLog(trashId),
    permanentlyDelete:  (trashId) => store.permanentlyDeleteLog(trashId),
    repaint
  });
  memoriesView.init({
    session: viewSession,
    addMemory:    (payload) => store.addMemory(payload),
    updateMemory: (id, patch) => store.updateMemory(id, patch),
    deleteMemory: (id) => store.deleteMemory(id),
    repaint
  });

  let initialId = await auth.getSelectedPetId();
  if (!initialId || !pets.some((p) => p.id === initialId)) initialId = pets[0].id;

  await openPet(initialId);

  setInterval(repaint, 30_000);
}

/* ------------------------------------------------------------------
   Opening a pet: dispose whatever store is open, spin up a fresh one
   scoped to petId, and persist the choice so it survives a refresh (and,
   in live mode, a different device — lastSelectedPetId is synced through
   users/{uid}).
   ------------------------------------------------------------------ */
async function openPet(petId) {
  if (store) { try { store.dispose?.(); } catch { /* best effort */ } store = null; }

  currentPet = pets.find((p) => p.id === petId) || pets[0];
  selectedPetId = currentPet.id;
  state = { pet: null, medications: [], logs: [], caretakers: [], vaccinations: [], weights: [], vets: [], trash: [], memories: [] };
  dash = null;

  hideEmptyState();
  paintUser();
  updatePetSelectorUi();

  const boot = $("#boot");
  boot.hidden = false;
  boot.className = "boot";
  boot.innerHTML = `<span class="boot-mark">🐾</span><p>Loading ${esc(currentPet.name)}'s dashboard…</p>`;
  $("#layout").setAttribute("aria-busy", "true");

  try { await auth.setSelectedPetId(petId); } catch (err) { console.warn("[PetCare] could not persist selected pet", err); }

  try {
    store = await createStore(petId, viewSession());
  } catch (err) {
    console.error(err);
    boot.className = "boot boot-warn";
    boot.innerHTML =
      '<span class="boot-mark">🐾</span>' +
      '<p class="boot-warn-title">Could not open this pet.</p>' +
      '<p>You may no longer have access to it.</p>';
    return;
  }

  ctx.store = store;
  setMode(store.mode, store.modeLabel);
  chat.prewarm();

  let firstSnapshot = false;
  store.subscribe((next) => {
    if (selectedPetId !== petId) return;   // a later switch already moved on
    firstSnapshot = true;
    state = next;
    setVets(state.vets);
    chat.setPetContext(state.pet);
    repaint();
    $("#layout").setAttribute("aria-busy", "false");
    $("#boot").hidden = true;
  });

  /* Same "say what happened" guard as before, now scoped to this open. */
  setTimeout(() => {
    if (firstSnapshot || selectedPetId !== petId) return;
    const b = $("#boot");
    b.className = "boot boot-warn";
    b.innerHTML =
      '<span class="boot-mark">🐾</span>' +
      '<p class="boot-warn-title">This is taking longer than it should.</p>' +
      '<p>The dashboard data never arrived — check your connection, or that this ' +
      'account still has access to this pet.</p>' +
      '<button class="btn btn-primary btn-sm" type="button" onclick="location.reload()">Reload</button>';
  }, 4000);
}

/* A role-annotated view of the session for whichever pet is open. Role is
   per-pet, never global, so this is synthesized fresh on every switch —
   caretakers.js and health.js need no changes at all as a result. */
function viewSession() {
  return { uid: session.uid, email: session.email, name: session.name, role: currentPet?.role || "owner" };
}

/* ------------------------------------------------------------------ */
function repaint() {
  if (!state.pet) return;
  dash = buildDashboard(state, now());
  const c = { onGive: giveMedication, onGiveFeeding: giveFeeding };
  dashboardView.render(dash, c);
  notifyCareAlerts(dash);
  timelineView.render(dash, { onTrash: trashLogEntry });
  caretakersView.render(dash, viewSession());
  healthView.render(dash, viewSession());
  binView.render();
  memoriesView.render(dash);
  kpiView.render(state);
}

function notifyCareAlerts(dashboard) {
  const rows = [
    ...(dashboard.alerts?.dueNow || []).map((row) => ({ row, status: "due" })),
    ...(dashboard.alerts?.overdue || []).map((row) => ({ row, status: "overdue" }))
  ];

  for (const { row, status } of rows) {
    const rowId = row.kind === "feeding"
      ? `feeding:${row.slot}`
      : row.kind === "walk"
        ? `walk:${row.slot}`
        : `medication:${row.medicationId}:${row.slot}`;
    const key = `${dashboard.today.dayKey}:${rowId}:${status}`;
    if (sentCareNotifications.has(key)) continue;
    sentCareNotifications.add(key);

    const label = row.kind === "feeding" ? "Feeding"
      : row.kind === "walk" ? "Walk" : `${row.name} medication`;
    const when = fmtClock(row.due || istTimeToday(row.slot));
    showNotification(
      status === "overdue"
        ? `${label} is overdue by 1 hour — due at ${when}`
        : `${label} is due now — scheduled for ${when}`,
      status === "overdue" ? "err" : "warn"
    );
  }

  // Update topbar notification bell badge and dropdown
  const bellBtn = $("#notifBellBtn");
  const badge = $("#notifBadge");
  const dropdown = $("#notifDropdown");
  const dropCount = $("#notifDropdownCount");
  const dropList = $("#notifDropdownList");

  const notifRows = [];
  if (dashboard.alerts?.overdue) {
    for (const r of dashboard.alerts.overdue) {
      const label = r.kind === "feeding" ? "Feeding" : r.kind === "walk" ? "Walk" : r.name;
      notifRows.push({
        tone: "crit",
        icon: r.kind === "feeding" ? '<img src="https://img.icons8.com/ios-filled/50/dog-bowl.png" alt="Feeding" class="ui-icon">' : r.kind === "walk" ? '<img src="https://img.icons8.com/ios-filled/50/walking.png" alt="Walk" class="ui-icon">' : '<img src="https://img.icons8.com/ios-filled/50/pill.png" alt="Medication" class="ui-icon">',
        text: `${dashboard.pet?.name || currentPet?.name || "Pet"}: ${label} overdue — was due ${fmtClock(istTimeToday(r.slot))}`
      });
    }
  }
  if (dashboard.alerts?.dueNow) {
    for (const r of dashboard.alerts.dueNow) {
      const label = r.kind === "feeding" ? "Feeding" : r.kind === "walk" ? "Walk" : r.name;
      notifRows.push({
        tone: "warn",
        icon: r.kind === "feeding" ? '<img src="https://img.icons8.com/ios-filled/50/dog-bowl.png" alt="Feeding" class="ui-icon">' : r.kind === "walk" ? '<img src="https://img.icons8.com/ios-filled/50/walking.png" alt="Walk" class="ui-icon">' : '<img src="https://img.icons8.com/ios-filled/50/pill.png" alt="Medication" class="ui-icon">',
        text: `${dashboard.pet?.name || currentPet?.name || "Pet"}: ${label} due now`
      });
    }
  }
  if (dashboard.today?.overFeeding) {
    notifRows.push({
      tone: "warn",
      icon: '<img src="https://img.icons8.com/ios-filled/50/warning-shield.png" alt="Warning" class="ui-icon">',
      text: `${dashboard.pet?.name || currentPet?.name || "Pet"}: Feeding Warning — exceeded today's planned schedule`
    });
  }

  const total = notifRows.length;
  if (badge) {
    badge.textContent = String(total);
    badge.hidden = total === 0;
  }
  if (dropCount) dropCount.textContent = String(total);

  if (dropList) {
    dropList.innerHTML = "";
    if (!total) {
      dropList.innerHTML = `<li class="notif-dropdown-empty">No items needing attention right now</li>`;
    } else {
      for (const row of notifRows) {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `notif-dropdown-item is-${row.tone}`;
        btn.innerHTML = `<span aria-hidden="true">${row.icon}</span><span>${esc(row.text)}</span>`;
        btn.addEventListener("click", () => {
          if (dropdown) dropdown.hidden = true;
        });
        li.appendChild(btn);
        dropList.appendChild(li);
      }
    }
  }

  if (bellBtn && !bellBtn._wired) {
    bellBtn._wired = true;
    bellBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dropdown) dropdown.hidden = !dropdown.hidden;
    });
    document.addEventListener("click", (e) => {
      if (dropdown && !$("#notifBellWrap")?.contains(e.target)) {
        dropdown.hidden = true;
      }
    });
  }
}

function paintUser() {
  $("#userName").textContent    = session.name;
  $("#userInitial").textContent = (session.name || "?").charAt(0).toUpperCase();
  const role = $("#userRole");
  const r = currentPet?.role || "owner";
  role.textContent = r.toUpperCase();
  role.className = `role-chip ${r === "owner" ? "owner" : "caretaker"}`;
  document.body.classList.toggle("caretaker-dashboard", r === "caretaker");
  $("#caretakerBanner").hidden = r !== "caretaker";
  $("#exportCard").hidden = r === "caretaker";
  $("#careTeamCard").hidden = r === "caretaker";
  /* Only the owner of the pet can edit pet details — hidden for caretakers */
  $("#btnEditPet").hidden = r !== "owner";
}

/* ------------------------------------------------------------------
   Logging — the one-click path, with a short "Undo" window
   ------------------------------------------------------------------
   A mistouch on Feed/Walk/Log Medication is common enough on a phone that
   it deserves the same pattern modern apps use for a mid-air delete:
   record it right away (so nothing is lost if the tab closes), but hold
   up a dismissible "<Task> recorded • Undo" toast for a few seconds. If
   the same log is tapped again before store.logCare() for the first one
   has even resolved — the classic rapid-double-tap — `inFlight` below
   drops the second call instead of creating a duplicate record. */
const inFlight = new Set();

async function logTask(type, extra = {}) {
  const key = `${type}:${extra.medicationId || ""}:${extra.slot || ""}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);

  const role = currentPet?.role || "owner";
  try {
    const logId = await store.logCare({
      type,
      performedBy:     session.name,
      performedByRole: role,
      ...extra
    });
    repaint();                     // the live store re-renders itself; harmless

    const label = TASK_META[type]?.label || type;
    showActionToast(`${label} recorded`, "Undo", () => undoLog(type, logId), { seconds: UNDO_WINDOW_SECONDS });
  } catch (err) {
    console.error(err);
    toast(err.message || "Could not save that", "err");
  } finally {
    inFlight.delete(key);
  }
}

/** Reverts a just-logged entry — see store.undoLog()'s own comment for why
    this can only ever remove a record within a short window of its own
    creation, never anyone else's, never after the fact. */
async function undoLog(type, logId) {
  if (!logId) return;
  try {
    const undone = await store.undoLog(logId);
    if (undone) {
      repaint();
      toast(`${TASK_META[type]?.label || type} entry removed`, "ok");
    } else {
      toast("Too late to undo that — it's already saved.", "err");
    }
  } catch (err) {
    console.error(err);
    toast(err.message || "Could not undo that.", "err");
  }
}

/** Moves one timeline entry to the Bin — never a hard delete. The
    underlying careLog is untouched (see store.trashLog()'s own comment);
    this just creates the marker that hides it from the timeline, counts
    and calendar until someone restores it from the Bin. No confirm
    dialog here — unlike a real delete, this is fully reversible from
    the Bin, the same "Stop, don't confirm" treatment medications.js
    gives its own reversible pause action. */
async function trashLogEntry(item) {
  try {
    await store.trashLog(item.id, {
      deletedBy:     session.name,
      deletedByRole: currentPet?.role || "owner",
      deletedByUid:  session.uid
    });
    repaint();
    toast("Moved to the bin", "ok");
  } catch (err) {
    console.error(err);
    toast(err.message || "Could not move that entry to the bin.", "err");
  }
}

async function giveMedication(row) {
  closeAllModals();
  await logTask("medication", {
    medicationId: row.medicationId,
    slot:         row.slot,
    notes:        `${row.name} ${row.dosage}`
  });
}

/** Marking one configured feeding time as given — separate from the
    one-click "Log Feeding" action button, which still just logs an
    unslotted feeding the way it always has. This is what lets the
    dashboard and calendar know WHICH feeding happened, not just how many. */
async function giveFeeding(row) {
  await logTask("feeding", { slot: row.slot });
}

/** Same log as giveMedication() above, minus the closeAllModals() call —
    used from the calendar's week view, which stays open after logging a
    past/today dose (giveMedication() is for the dashboard's medication
    picker modal, which does need to close first). */
async function giveMedicationLogOnly(row) {
  await logTask("medication", {
    medicationId: row.medicationId,
    slot:         row.slot,
    notes:        `${row.name} ${row.dosage}`
  });
}

/** "Log Medication" opens a picker of the doses that are still outstanding. */
function openMedicationPicker() {
  const pending = dash.medications.filter((m) => m.status !== "COMPLETED");
  const list = $("#medModalList");
  list.innerHTML = "";

  if (!pending.length) {
    $("#medModalTitle").textContent = "All doses given";
    list.innerHTML = `<p class="empty">Every scheduled dose for today has been logged. Nothing left to give.</p>`;
  } else {
    $("#medModalTitle").textContent = pending.length === 1 ? "Confirm the dose" : "Which dose?";
    for (const row of pending) {
      list.appendChild(dashboardView.medItem(row, { onGive: giveMedication }));
    }
  }
  openModal("medModal");
}

/* ------------------------------------------------------------------
   Pet selector — dropdown in the topbar. Switching pets never leaves
   stale data on screen: state is reset and the boot overlay comes back
   until the new pet's first snapshot arrives.
   ------------------------------------------------------------------ */
function wirePetSelector() {
  const btn = $("#petSwitcherBtn");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    $("#petSwitcherMenu").hidden ? openPetMenu() : closePetMenu();
  });
  document.addEventListener("click", (e) => {
    if (!$("#petSwitcher").contains(e.target)) closePetMenu();
  });
  wireDashboardJoinModal();
}

function openPetMenu() {
  renderPetMenu();
  $("#petSwitcherMenu").hidden = false;
  $("#petSwitcherBtn").setAttribute("aria-expanded", "true");
  const searchInput = $("#petSearchInput");
  if (searchInput) {
    searchInput.value = "";
    setTimeout(() => searchInput.focus(), 50);
  }
}
function closePetMenu() { $("#petSwitcherMenu").hidden = true;  $("#petSwitcherBtn").setAttribute("aria-expanded", "false"); }

function updatePetSelectorUi() {
  const switcher = $("#petSwitcher");
  switcher.hidden = !pets.length;
  if (!currentPet) return;

  const meta = speciesMeta(currentPet.species);
  const avatar = $("#petSwitcherAvatar");
  avatar.textContent = currentPet.photoURL ? "" : (currentPet.emoji || meta.icon);
  avatar.style.backgroundImage = currentPet.photoURL ? `url(${currentPet.photoURL})` : "";
  $("#petSwitcherName").textContent = currentPet.name;
}

function renderPetMenu(filterText = "") {
  const menu = $("#petSwitcherMenu");
  menu.innerHTML = `
    <div class="pet-search-wrap">
      <img src="https://img.icons8.com/ios-filled/50/search.png" alt="" class="ui-icon search-bar-icon" aria-hidden="true">
      <input type="text" id="petSearchInput" placeholder="Search pet..." class="pet-search-input" value="${esc(filterText)}">
    </div>
    <div class="pet-switcher-list" id="petSwitcherList"></div>
  `;

  const searchInput = $("#petSearchInput");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      e.stopPropagation();
      filterPetItems(e.target.value);
    });
    searchInput.addEventListener("click", (e) => e.stopPropagation());
    searchInput.addEventListener("keydown", (e) => e.stopPropagation());
  }

  filterPetItems(filterText);
}

function filterPetItems(term) {
  const listContainer = $("#petSwitcherList");
  if (!listContainer) return;
  listContainer.innerHTML = "";

  const query = (term || "").trim().toLowerCase();
  const filtered = pets.filter((p) =>
    !query ||
    (p.name || "").toLowerCase().includes(query) ||
    (p.breed || "").toLowerCase().includes(query) ||
    (p.species || "").toLowerCase().includes(query)
  );

  if (!filtered.length) {
    listContainer.innerHTML = `<p class="pet-search-empty">No pets match "${esc(term)}"</p>`;
  } else {
    for (const p of filtered) {
      const meta = speciesMeta(p.species);
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "option");
      item.className = `pet-switcher-item${p.id === selectedPetId ? " is-on" : ""}`;
      item.innerHTML = `
        <span class="pet-switcher-item-avatar"${p.photoURL ? ` style="background-image:url(${esc(p.photoURL)})"` : ""}>${p.photoURL ? "" : meta.icon}</span>
        <span class="pet-switcher-item-info"><b>${esc(p.name)}</b><i>${esc(p.role)}</i></span>`;
      item.addEventListener("click", () => {
        closePetMenu();
        if (p.id !== selectedPetId) openPet(p.id);
      });
      listContainer.appendChild(item);
    }
  }

  const isOwner = (currentPet && currentPet.role === "owner") || pets.some((p) => p.role === "owner");

  if (!isOwner) {
    const joinItem = document.createElement("button");
    joinItem.type = "button";
    joinItem.className = "pet-switcher-item pet-switcher-add";
    joinItem.textContent = "+ Join a pet";
    joinItem.addEventListener("click", () => {
      closePetMenu();
      openJoinModalOnDashboard();
    });
    listContainer.appendChild(joinItem);
  }

  if (isOwner) {
    const addItem = document.createElement("button");
    addItem.type = "button";
    addItem.className = "pet-switcher-item pet-switcher-add";
    addItem.textContent = "+ Add a pet";
    addItem.addEventListener("click", () => { window.location.href = "./onboarding.html?mode=add"; });
    listContainer.appendChild(addItem);
  }
}

function openJoinModalOnDashboard() {
  $("#joinPetForm")?.reset();
  $("#jpError").hidden = true;
  openModal("joinPetModal");
  setTimeout(() => $("#jpCode")?.focus(), 60);
}

function wireDashboardJoinModal() {
  $("#joinPetForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = normaliseCode($("#jpCode").value);
    const password = $("#jpPassword").value;

    if (!code)     return showJpDashError("Enter a care code.");
    if (!password) return showJpDashError("Enter your current password.");

    const btn = $("#jpSubmit");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Verifying…";
    $("#jpError").hidden = true;

    try {
      const petId = await auth.joinWithCode(code, password);
      closeAllModals();
      toast("Joined pet care team successfully!", "ok");
      pets = await auth.myPets();
      await openPet(petId);
    } catch (err) {
      showJpDashError(err.message || "Could not join pet. Check code and password.");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

function showJpDashError(msg) {
  const el = $("#jpError");
  if (el) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    toast(msg, "err");
  }
}

/* ------------------------------------------------------------------
   Edit / archive the pet that is currently open. Editing is open to any
   member (owner or caretaker); removing the pet is owner-only — the
   Archive button is hidden for a caretaker here AND the auth layer /
   (in live mode) Firestore rules refuse that write regardless of the UI.
   ------------------------------------------------------------------ */
function wireEditArchive() {
  epBreed = wireBreedSelect($("#epBreed"), $("#epBreedOtherWrap"), $("#epBreedOther"), $("#epBreedLabel"));
  epSpecies = wireSpeciesGrid($("#epSpeciesGrid"), (id) => epBreed.populate(id));
  epFeeding = wireFeedingScheduleEditor($("#epFeedingTimesEditor"));
  epPhoto = wirePhotoPicker({
    input: $("#epPhoto"), preview: $("#epPhotoPreview"), clearBtn: $("#epPhotoClear"),
    onChange: (_, err) => { if (err) toast(err, "err"); }
  });

  $("#btnEditPet").addEventListener("click", openEditPet);
  $("#btnEmptyAddPet")?.addEventListener("click", () => { window.location.href = "./onboarding.html?mode=add"; });
  $("#btnEmptyJoinPet")?.addEventListener("click", () => { openJoinModalOnDashboard(); });

  $("#editPetForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pet = state.pet || {};
    const isOwner = currentPet?.role === "owner";
    const payload = {
      name: $("#epName").value.trim(),
      species: epSpecies.get(),
      breed: epBreed.get(),
      ageYears: $("#epAge").value === "" ? null : Number($("#epAge").value),
      gender: $("#epGender").value,
      weightKg: $("#epWeight").value === "" ? null : Number($("#epWeight").value),
      photoURL: epPhoto.get(),
      feedingSchedule: { ...(pet.feedingSchedule || {}), times: epFeeding.get() },
      /* dailyTargets.feeding stays a mirror of the schedule's own length;
         walk target is customizable (set to 0 for indoor/non-walking pets) */
      dailyTargets: {
        ...(pet.dailyTargets || {}),
        feeding: epFeeding.get().length,
        walk: $("#epWalkTarget") ? Math.max(0, Number($("#epWalkTarget").value) || 0) : (pet.dailyTargets?.walk ?? (epSpecies.get() === "dog" ? 2 : 0))
      },
      /* merge, don't replace — an existing allergy/medication note set
         outside this form (seed data, or set up before this UI existed)
         must survive an edit that only touches the free-text notes. Both
         owner and caretaker may edit allergy/notes — that mirrors the
         existing caretaker "can edit pet details" permission. Only the
         vet contact stays owner-only, added below. */
      specialInstructions: {
        ...(pet.specialInstructions || {}),
        allergy: $("#epAllergy").value.trim(),
        notes: $("#epNotes").value.trim()
      }
    };
    /* Vet contact: owner-only, enforced twice over — the fields are
       readonly in the UI for a caretaker (openEditPet below), the demo
       store strips a non-owner's `vet` patch regardless, and the Firestore
       rule denies `vet` in memberDetailUpdate()'s affected-keys check for
       live mode. Simplest correct client behaviour is to just never send
       a changed vet payload from a caretaker's session in the first place. */
    if (isOwner) {
      payload.vet = {
        name: $("#epVetName").value.trim(),
        phone: $("#epVetPhone").value.trim(),
        emergencyPhone: $("#epVetEmergencyPhone").value.trim()
      };
    }
    const problem = validatePetForm(payload);
    if (problem) return showEditError(problem);

    const btn = $("#editPetForm").querySelector('[type="submit"]');
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      await auth.updatePet(currentPet.id, payload);
      closeAllModals();
      toast("Pet updated", "ok");
      pets = await auth.myPets();
      await openPet(currentPet.id);
    } catch (err) {
      showEditError(err.message || "Could not save that.");
    } finally {
      btn.disabled = false; btn.textContent = original;
    }
  });

  $("#btnArchivePet").addEventListener("click", () => {
    closeModal("editPetModal");
    $("#archivePetName").textContent = currentPet?.name || "this pet";
    $("#archivePetName2").textContent = currentPet?.name || "this pet";
    openModal("archivePetModal");
  });

  $("#archivePetConfirm").addEventListener("click", async () => {
    const petId = currentPet?.id;
    const name = currentPet?.name || "This pet";
    if (!petId) return;
    try {
      await auth.archivePet(petId);
      closeAllModals();
      toast(`${name} removed`, "ok");
      pets = await auth.myPets();
      if (!pets.length) {
        if (store) { try { store.dispose?.(); } catch { /* ignore */ } store = null; }
        showEmptyState();
      } else {
        await openPet(pets[0].id);
      }
    } catch (err) {
      toast(err.message || "Could not remove that pet.", "err");
    }
  });
}

function openEditPet() {
  const pet = state.pet;
  /* Only the owner of the pet can edit pet details */
  if (!pet || !currentPet || currentPet.role !== "owner") return;

  $("#editPetError").hidden = true;
  $("#epName").value = pet.name || "";
  epSpecies.set(pet.species || "other");   // triggers epBreed.populate() via onSelect
  epBreed.set(pet.breed || "");
  $("#epAge").value = pet.ageYears ?? "";
  $("#epGender").value = pet.gender || "";
  $("#epWeight").value = pet.weightKg ?? "";
  if ($("#epWalkTarget")) {
    const defaultWalk = pet.species === "dog" ? 2 : 0;
    $("#epWalkTarget").value = pet.dailyTargets?.walk ?? defaultWalk;
  }
  epPhoto.set(pet.photoURL || "");
  epFeeding.set(pet.feedingSchedule?.times);
  $("#epAllergy").value = pet.specialInstructions?.allergy || "";
  $("#epNotes").value = pet.specialInstructions?.notes || "";

  /* Vet contact is owner-only to edit — everyone else sees the current
     values but cannot change them, per the caretaker permission split. */
  const isOwner = currentPet.role === "owner";
  const vet = pet.vet || {};
  $("#epVetName").value = vet.name || "";
  $("#epVetPhone").value = vet.phone || "";
  $("#epVetEmergencyPhone").value = vet.emergencyPhone || "";
  for (const id of ["#epVetName", "#epVetPhone", "#epVetEmergencyPhone"]) {
    $(id).readOnly = !isOwner;
  }
  $("#epVetHint").textContent = isOwner ? "optional" : "owner only";
  $("#epVetLockedNote").hidden = isOwner;

  $("#btnArchivePet").hidden = currentPet.role !== "owner";
  openModal("editPetModal");
}

function showEditError(msg) {
  const el = $("#editPetError");
  el.textContent = msg;
  el.hidden = false;
}

/* ------------------------------------------------------------------
   Empty state — zero pets on this account. Reachable by skipping
   onboarding, or by archiving your only pet from the dashboard.
   ------------------------------------------------------------------ */
function showEmptyState() {
  $("#boot").hidden = true;
  $("#layout").hidden = true;
  $("#petSwitcher").hidden = true;
  const strip = $("#alertStrip");
  if (strip) strip.hidden = true;
  $("#emptyDash").hidden = false;
}

function hideEmptyState() {
  $("#emptyDash").hidden = true;
  $("#layout").hidden = false;
}

/* ------------------------------------------------------------------
   Ultra-Smooth 3D Liquid Tilt Engine (Clean, Non-Shiny)
   ------------------------------------------------------------------ */
function initLiquidReflectionEngine() {
  let activeEl = null;
  let targetRx = 0, targetRy = 0;
  let currentRx = 0, currentRy = 0;
  let animating = false;

  function update() {
    currentRx += (targetRx - currentRx) * 0.12;
    currentRy += (targetRy - currentRy) * 0.12;

    if (activeEl) {
      activeEl.style.transform = `perspective(1000px) rotateX(${currentRx.toFixed(2)}deg) rotateY(${currentRy.toFixed(2)}deg) translateZ(3px)`;
    }

    if (activeEl || Math.abs(currentRx) > 0.05 || Math.abs(currentRy) > 0.05) {
      requestAnimationFrame(update);
    } else {
      animating = false;
    }
  }

  document.addEventListener("mousemove", (e) => {
    const el = e.target.closest(".card, .pet-flash-card, .overview-card, .memory-card, .action, .btn-primary, .btn-ghost, .btn-secondary, .pet-switcher-btn, .topbar");
    
    if (el !== activeEl) {
      if (activeEl) {
        activeEl.style.transform = "";
      }
      activeEl = el;
      currentRx = 0; currentRy = 0;
    }

    if (!activeEl) return;

    const rect = activeEl.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;

    // Subtle 3D tilt (-4deg to +4deg)
    targetRx = (0.5 - py) * 6;
    targetRy = (px - 0.5) * 6;

    if (!animating) {
      animating = true;
      requestAnimationFrame(update);
    }
  });

  document.addEventListener("mouseout", (e) => {
    if (activeEl && (!e.relatedTarget || !activeEl.contains(e.relatedTarget))) {
      activeEl.style.transform = "";
      targetRx = 0; targetRy = 0;
      activeEl = null;
    }
  });
}

/* ------------------------------------------------------------------ */
function wireStaticUi() {
  initLiquidReflectionEngine();

  $$(".action").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.log;
      if (type === "medication") openMedicationPicker();
      else logTask(type);
    });
  });

  $("#btnSignOut").addEventListener("click", async () => {
    await auth.signOut();
    window.location.replace("./login.html");
  });

  wireProfileModal();

  /* Always opened with THIS pet's own store and pet doc — switching pets
     and reopening the calendar can never show another pet's schedule or
     history, the same guarantee every other panel on this page has. */
  $("#btnOpenCalendar").addEventListener("click", () => {
    if (!state.pet || !store) return;
    calendarView.open({
      pet: state.pet, store,
      onGiveFeeding: giveFeeding,
      medications: () => state.medications,
      onGiveMedication: giveMedicationLogOnly
    });
  });

  $("#btnManageMeds").addEventListener("click", () => {
    if (!state.pet) return;
    medicationsView.openManage(viewSession());
  });

  $("#btnOpenBin").addEventListener("click", () => {
    if (!state.pet) return;
    binView.openManage();
  });

  $$("[data-close-modal]").forEach((b) => b.addEventListener("click", closeAllModals));
  $$(".modal").forEach((m) => m.addEventListener("click", (e) => {
    if (e.target === m) closeAllModals();
  }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeAllModals(); closePetMenu(); } });

  $("#btnExportLog").addEventListener("click", () => exportTxt(state, dash));
  $("#btnExportCsv").addEventListener("click", () => exportCsv(state, dash));
  $("#btnExportPlan").addEventListener("click", () => exportHandoff(dash));
  $("#btnHandoff").addEventListener("click", () => exportHandoff(dash));
  $("#vetName").addEventListener("click", () => showVets(null, "", false));

}

/* ------------------------------------------------------------------ */
function setMode(mode, label) {
  const badge = $("#modeBadge");
  if (badge) badge.dataset.mode = mode;
  const txt = $("#modeText");
  if (txt) txt.textContent = mode === "live" ? "Live · Firestore" : "Demo mode";
  const foot = $("#footMode");
  if (foot) foot.textContent = label;
}

/* ---------------- User Profile Modal ---------------- */
async function openProfileModal() {
  const modal = $("#profileModal");
  if (!modal) return;

  const currentSession = auth ? auth.current() : session;
  if (!currentSession) return;

  const nameParts = (currentSession.name || "").trim().split(/\s+/);
  const firstName = currentSession.firstName || nameParts[0] || "";
  const lastName = currentSession.lastName || (nameParts.length > 1 ? nameParts.slice(1).join(" ") : "");
  const middleName = currentSession.middleName || "";

  $("#pfAvatar").textContent = (currentSession.name || "?").charAt(0).toUpperCase();
  $("#pfDisplayName").textContent = currentSession.name || "User";
  $("#pfEmailText").textContent = currentSession.email || "";
  $("#pfEmailInput").value = currentSession.email || "";

  $("#pfFirstName").value = firstName;
  $("#pfLastName").value = lastName;
  $("#pfMiddleName").value = middleName;
  if ($("#pfPhone")) $("#pfPhone").value = currentSession.phone || "";

  $("#pfError").hidden = true;
  $("#pfError").textContent = "";

  openModal("profileModal");

  // Render pets list
  const petsListEl = $("#pfPetsList");
  if (petsListEl) {
    petsListEl.innerHTML = `<div class="profile-pet-item-skeleton">Loading connected pets...</div>`;
    try {
      const myPets = await auth.myPets();
      if (!myPets || myPets.length === 0) {
        petsListEl.innerHTML = `<div class="profile-pet-item" style="color:var(--ink-2);">No connected pets yet</div>`;
      } else {
        petsListEl.innerHTML = myPets.map(p => `
          <div class="profile-pet-item">
            <div class="profile-pet-item-left">
              <span class="profile-pet-emoji">${p.emoji || "🐾"}</span>
              <span>${esc(p.name)}</span>
            </div>
            <span class="role-chip ${p.role === "owner" ? "owner" : "caretaker"}">${p.role.toUpperCase()}</span>
          </div>
        `).join("");
      }
    } catch (err) {
      console.warn("Error fetching pets for profile:", err);
      petsListEl.innerHTML = `<div class="profile-pet-item" style="color:var(--ink-2);">Unable to load pets list</div>`;
    }
  }
}

function wireProfileModal() {
  const userChip = $(".user-chip");
  if (userChip && !userChip._profileWired) {
    userChip._profileWired = true;
    userChip.addEventListener("click", (e) => {
      if (e.target.closest("#btnSignOut")) return;
      openProfileModal();
    });
  }

  const profileForm = $("#profileForm");
  if (profileForm && !profileForm._profileWired) {
    profileForm._profileWired = true;
    profileForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = $("#pfError");
      const saveBtn = $("#btnProfileSave");
      errEl.hidden = true;
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";

      const firstName = $("#pfFirstName").value.trim();
      const lastName = $("#pfLastName").value.trim();
      const middleName = $("#pfMiddleName").value.trim();
      const phone = $("#pfPhone") ? $("#pfPhone").value.trim() : "";

      try {
        const updatedSession = await auth.updateUserProfile({ firstName, middleName, lastName, phone });
        if (updatedSession) {
          session = updatedSession;
        }
        paintUser();
        toast("Profile updated successfully!", "ok");
        closeAllModals();
      } catch (err) {
        errEl.textContent = err.message || "Failed to update profile.";
        errEl.hidden = false;
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Changes";
      }
    });
  }

  const signOutBtn = $("#btnProfileSignOut");
  if (signOutBtn && !signOutBtn._profileWired) {
    signOutBtn._profileWired = true;
    signOutBtn.addEventListener("click", async () => {
      await auth.signOut();
      window.location.replace("./login.html");
    });
  }
}

