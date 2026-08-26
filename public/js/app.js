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

import { $, $$, toast, showActionToast, openModal, closeModal, closeAllModals, esc } from "./ui.js";
import { createStore, buildDashboard, TASK_META } from "./data.js";
import {
  setTimeOffsetMs, getTimeOffsetMs, fmtClock, fmtDate, now, realNow, istTimeToday
} from "./time.js";
import { GRACE_MINUTES, UNDO_WINDOW_SECONDS } from "./config.js";
import { initAuth, speciesMeta, validatePetForm } from "./auth.js";
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

let auth = null;
let session = null;          // identity only: {uid, email, name, lastSelectedPetId}
let pets = [];                // trimmed list from auth.myPets()
let currentPet = null;        // the pets[] entry that is open right now — carries .role
let selectedPetId = null;
let store = null;
let ctx = null;               // shared with caretakers.js / health.js; .store is swapped in place
let state = { pet: null, medications: [], logs: [], caretakers: [], vaccinations: [], weights: [], vets: [], trash: [], memories: [] };
let dash = null;

let epSpecies = null;         // edit-pet species grid controller
let epBreed = null;           // edit-pet breed select controller
let epFeeding = null;         // edit-pet feeding-schedule editor controller
let epPhoto = null;           // edit-pet photo picker controller

/* ------------------------------------------------------------------ */
boot();

async function boot() {
  auth = await initAuth();
  session = await auth.ready;

  /* Auth guard. Everything past this line assumes a signed-in person. */
  if (!session) {
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
  setInterval(paintDevClock, 1_000);
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
  timelineView.render(dash, { onTrash: trashLogEntry });
  caretakersView.render(dash, viewSession());
  healthView.render(dash, viewSession());
  binView.render();
  memoriesView.render(dash);
  kpiView.render(state);
}

function paintUser() {
  $("#userName").textContent    = session.name;
  $("#userInitial").textContent = (session.name || "?").charAt(0).toUpperCase();
  const role = $("#userRole");
  const r = currentPet?.role || "";
  role.textContent = r || "—";
  role.className = `role-chip ${r === "owner" ? "owner" : "caretaker"}`;
  /* Both owner and caretaker can edit pet details — only deleting a pet
     is owner-only, gated separately inside the edit modal itself. */
  $("#btnEditPet").hidden = !r;
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
}

function openPetMenu()  { renderPetMenu(); $("#petSwitcherMenu").hidden = false; $("#petSwitcherBtn").setAttribute("aria-expanded", "true"); }
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

function renderPetMenu() {
  const menu = $("#petSwitcherMenu");
  menu.innerHTML = "";

  for (const p of pets) {
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
    menu.appendChild(item);
  }

  const addItem = document.createElement("button");
  addItem.type = "button";
  addItem.className = "pet-switcher-item pet-switcher-add";
  addItem.textContent = "+ Add a pet";
  addItem.addEventListener("click", () => { window.location.href = "./onboarding.html?mode=add"; });
  menu.appendChild(addItem);
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
  $("#btnEmptyAddPet").addEventListener("click", () => { window.location.href = "./onboarding.html?mode=add"; });

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
      /* dailyTargets.feeding stays a mirror of the schedule's own length —
         the ring/KPI/streak math all reads dailyTargets, not the schedule
         itself, so this is the one place that has to stay in sync. */
      dailyTargets: { ...(pet.dailyTargets || {}), feeding: epFeeding.get().length },
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
  /* Owners and caretakers can both edit pet details — only deleting the
     pet (Remove this pet, wired separately below) stays owner-only, and
     that button is hidden/disabled per role right here. */
  if (!pet || !currentPet) return;

  $("#editPetError").hidden = true;
  $("#epName").value = pet.name || "";
  epSpecies.set(pet.species || "other");   // triggers epBreed.populate() via onSelect
  epBreed.set(pet.breed || "");
  $("#epAge").value = pet.ageYears ?? "";
  $("#epGender").value = pet.gender || "";
  $("#epWeight").value = pet.weightKg ?? "";
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
  $("#alertStrip").hidden = true;
  $("#emptyDash").hidden = false;
}

function hideEmptyState() {
  $("#emptyDash").hidden = true;
  $("#layout").hidden = false;
}

/* ------------------------------------------------------------------ */
function wireStaticUi() {
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

  /* demo panel: double-click the logo */
  $("#brand").addEventListener("dblclick", () => {
    const p = $("#devPanel");
    p.hidden = !p.hidden;
    paintDevClock();
  });
  $("#devClose").addEventListener("click", () => { $("#devPanel").hidden = true; });
  $$(".dev-shift button").forEach((btn) => {
    btn.addEventListener("click", () => jumpTo(btn.dataset.jump, btn));
  });
  $("#devReseed").addEventListener("click", async () => {
    try {
      await store.reseed();
      jumpTo("real");
      toast("Demo data reseeded", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  });
}

/* ------------------------------------------------------------------
   Demo clock. Jumps to a STATE rather than a fixed offset, so the same
   button lands correctly whether you rehearse at 10am or demo at 9pm.
   ------------------------------------------------------------------ */
function jumpTo(kind, btn) {
  setTimeOffsetMs(0);
  const real = realNow();
  let target = null;
  let message = "Clock reset to real time";

  if (kind !== "real") {
    const fresh = buildDashboard(state, real);
    const pending = fresh.medications.find((m) => m.status !== "COMPLETED");

    if (kind === "nextday") {
      target = new Date(istTimeToday("00:00", new Date(real.getTime() + 86_400_000)).getTime() + 30 * 60_000);
      message = "Jumped past IST midnight — checklist resets, history stays";
    } else if (!pending) {
      toast(
        state.medications?.length
          ? "Every dose is already logged — reseed to demo Due / Overdue"
          : "No medications to jump to — reseed first",
        "err"
      );
      return;
    } else if (kind === "due") {
      target = new Date(istTimeToday(pending.slot, real).getTime() + 5 * 60_000);
      message = `Clock set to ${fmtClock(target)} — ${pending.name} is due`;
    } else if (kind === "overdue") {
      target = new Date(istTimeToday(pending.slot, real).getTime() + (GRACE_MINUTES + 30) * 60_000);
      message = `Clock set to ${fmtClock(target)} — ${pending.name} is overdue`;
    }
    if (target) setTimeOffsetMs(target - real);
  }

  const active = btn || document.querySelector(`.dev-shift button[data-jump="${kind}"]`);
  $$(".dev-shift button").forEach((b) => b.classList.toggle("is-on", b === active));

  repaint();
  paintDevClock();
  toast(message);
}

/* ------------------------------------------------------------------ */
function setMode(mode, label) {
  const badge = $("#modeBadge");
  badge.dataset.mode = mode;
  $("#modeText").textContent = mode === "live" ? "Live · Firestore" : "Demo mode";
  $("#footMode").textContent = label;
  $("#devReseed").hidden = mode !== "demo";
  if (mode === "demo") {
    console.info("[PetCare] Demo mode. Add your Firebase config to js/config.js to go live.");
  }
}

function paintDevClock() {
  const el = $("#devClock");
  if (el) el.textContent = `${fmtClock(now())}, ${fmtDate(now())}`;
  const off = $("#devOffset");
  if (off) {
    const h = getTimeOffsetMs() / 3_600_000;
    off.textContent = Math.abs(h) < 0.01 ? "" : `(${h > 0 ? "+" : ""}${h.toFixed(1)}h)`;
  }
}
