/* =====================================================================
   medications.js — add / edit / delete a pet's medications.
   ---------------------------------------------------------------------
   Owner-only, mirrored by firestore.rules (`allow write: if isOwner()`
   on /pets/{petId}/medications/{medId}) — a caretaker can still view the
   list and log doses from the dashboard's Medication schedule card, just
   not change the medication documents themselves. Same split as
   caretakers.js: the UI just stops offering actions the rules would
   refuse, and nothing here is itself the source of truth on permission.

   This is deliberately separate from dashboard.js's medication list —
   that one is dash.medications, the FLATTENED per-slot rows used for
   "mark as given"; this one manages the underlying documents (name,
   dosage, schedule, dates), which is a different shape and a different
   job. Reusing one for the other would tangle two features that should
   be able to change independently.
   ===================================================================== */

import { $, esc, toast, openModal, closeModal } from "./ui.js";
import { fmtClock, istTimeToday } from "./time.js";
import { wireFeedingScheduleEditor } from "./pets-ui.js";

let ctx = null;          // { medications(), addMedication, updateMedication, deleteMedication, repaint }
let timesCtl = null;
let editingId = null;    // null = add mode
let session = null;

const FREQUENCY_OPTIONS = ["Once daily", "Twice daily", "Three times daily", "Custom schedule"];

export function init(context) {
  ctx = context;
  timesCtl = wireFeedingScheduleEditor($("#medTimesEditor"), {
    defaultTimes: ["09:00"],
    labelFn: (i) => `Dose ${i + 1}`,
    addLabel: "+ Add a dose time"
  });
  /* Same "known option, else free text" reveal used for breed's "Other" —
     picking "Custom schedule" opens a plain-text field instead of forcing
     a schedule (e.g. "Mon/Wed/Fri only") into one of the three fixed
     options. */
  $("#medFrequency").addEventListener("change", () => {
    $("#medFrequencyCustomWrap").hidden = $("#medFrequency").value !== "Custom schedule";
  });
  wire();
}

/** Opens the manage list for whichever pet's dashboard is currently
    open. Called fresh every time the modal opens, so it always reflects
    the pet and role active right now — never a stale one from before a
    pet switch. */
export function openManage(newSession) {
  session = newSession;
  const isOwner = session?.role === "owner";
  $("#btnAddMed").hidden = !isOwner;
  $("#medManageReadonlyNote").hidden = isOwner;
  renderList(isOwner);
  openModal("medManageModal");
}

function renderList(isOwner) {
  const meds = ctx.medications() || [];
  const list = $("#medManageList");
  list.innerHTML = "";

  if (!meds.length) {
    list.innerHTML = `<p class="med-manage-empty">No medications yet.${isOwner ? " Add the first one below." : ""}</p>`;
    return;
  }
  for (const med of meds) list.appendChild(row(med, isOwner));
}

function row(med, isOwner) {
  const li = document.createElement("li");
  li.className = `med-manage-item${med.active === false ? " is-inactive" : ""}`;

  const times = (med.scheduledTimes || []).map((t) => fmtClock(istTimeToday(t))).join(" · ");
  const dateRange = [med.startDate, med.endDate].filter(Boolean).join(" – ");
  const metaParts = [med.type, med.frequency, med.feedingRelation, times, dateRange].filter(Boolean);

  const isActive = med.active !== false;
  li.innerHTML = `
    <div class="med-manage-info">
      <b>${esc(med.name)} · ${esc(med.dosage)}</b>
      ${!isActive ? `<span class="pill p-up">Stopped</span>` : ""}
      <p>${esc(metaParts.join(" · ") || "No schedule set")}</p>
      ${med.instructions ? `<p>${esc(med.instructions)}</p>` : ""}
    </div>`;

  if (!isOwner) return li;

  const actions = document.createElement("div");
  actions.className = "med-manage-actions";

  const editBtn = document.createElement("button");
  editBtn.className = "icon-btn";
  editBtn.title = "Edit this medication";
  editBtn.textContent = "✎";
  editBtn.addEventListener("click", () => openForm(med));

  /* Stop/Resume — mirrors caretakers.js's pause/reactivate icon-button
     pattern exactly. This toggles the existing `active` flag that
     buildDashboard() already respects (a stopped medication simply drops
     out of the daily checklist), so nothing new has to be taught to the
     checklist or the calendar. Unlike Delete below, this never touches a
     single administration record — every dose already logged for this
     medication stays in history and in the calendar/export forever,
     which is exactly what "stop, don't erase" means for a medication a
     vet has discontinued. */
  const stopBtn = document.createElement("button");
  stopBtn.className = "icon-btn";
  stopBtn.title = isActive ? "Stop this medication" : "Resume this medication";
  stopBtn.textContent = isActive ? "⏸" : "▶";
  stopBtn.addEventListener("click", async () => {
    try {
      await ctx.updateMedication(med.id, { active: !isActive });
      toast(isActive ? `${med.name} stopped` : `${med.name} resumed`, "ok");
      renderList(true);
      ctx.repaint();
    } catch (err) {
      toast(err.message || "Could not update that medication.", "err");
    }
  });

  const delBtn = document.createElement("button");
  delBtn.className = "btn btn-crit-ghost";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", () => {
    if (delBtn.dataset.armed === "1") {
      deleteMed(med);
    } else {
      delBtn.dataset.armed = "1";
      delBtn.textContent = "Confirm?";
      setTimeout(() => { delBtn.dataset.armed = ""; delBtn.textContent = "Delete"; }, 3000);
    }
  });

  actions.append(editBtn, stopBtn, delBtn);
  li.appendChild(actions);
  return li;
}

async function deleteMed(med) {
  try {
    await ctx.deleteMedication(med.id);
    toast(`${med.name} removed`, "ok");
    renderList(true);
    ctx.repaint();
  } catch (err) {
    toast(err.message || "Could not remove that medication.", "err");
  }
}

/* ------------------------------------------------------------------
   Add / edit form — one modal, one form, driven by `editingId`. Closing
   the manage list underneath is deliberate: two full-screen modals never
   stack in this app (see calendar.js's comment on the same choice) — the
   form modal takes over, and saving returns to a freshly re-rendered
   manage list rather than leaving it open and stale behind the form.
   ------------------------------------------------------------------ */
function openForm(med) {
  editingId = med?.id || null;
  $("#medFormTitle").textContent = editingId ? "Edit medication" : "Add medication";
  $("#medFormError").hidden = true;
  $("#medName").value = med?.name || "";
  $("#medDosage").value = med?.dosage || "";
  $("#medType").value = med?.type || "";
  $("#medFeedingRelation").value = med?.feedingRelation || "";

  /* A medication saved before "frequency" was a fixed dropdown (or one
     whose free-text value doesn't match any of the four known options,
     e.g. seed data's "daily") falls back to "Custom schedule" with its
     original text preserved in the free-text field — the same "unknown
     value -> Other + free text" fallback wireBreedSelect() uses, so
     editing an old medication never silently rewrites its schedule. */
  const freq = med?.frequency || "";
  if (freq && !FREQUENCY_OPTIONS.includes(freq)) {
    $("#medFrequency").value = "Custom schedule";
    $("#medFrequencyCustom").value = freq;
    $("#medFrequencyCustomWrap").hidden = false;
  } else {
    $("#medFrequency").value = freq || "Once daily";
    $("#medFrequencyCustom").value = freq === "Custom schedule" ? (med?.frequency || "") : "";
    $("#medFrequencyCustomWrap").hidden = $("#medFrequency").value !== "Custom schedule";
  }

  $("#medStartDate").value = med?.startDate || "";
  $("#medEndDate").value = med?.endDate || "";
  $("#medInstructions").value = med?.instructions || "";
  timesCtl.set(med?.scheduledTimes);

  closeModal("medManageModal");
  openModal("medFormModal");
  setTimeout(() => $("#medName").focus(), 60);
}

function wire() {
  $("#btnAddMed").addEventListener("click", () => openForm(null));

  $("#medForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const freqChoice = $("#medFrequency").value;
    const payload = {
      name: $("#medName").value.trim(),
      dosage: $("#medDosage").value.trim(),
      type: $("#medType").value || "",
      feedingRelation: $("#medFeedingRelation").value || "",
      frequency: freqChoice === "Custom schedule"
        ? ($("#medFrequencyCustom").value.trim() || "Custom schedule")
        : freqChoice,
      scheduledTimes: timesCtl.get(),
      startDate: $("#medStartDate").value || "",
      endDate: $("#medEndDate").value || "",
      instructions: $("#medInstructions").value.trim()
    };

    if (!payload.name)   return fail("Give the medication a name.");
    if (!payload.dosage) return fail("Enter the dosage.");
    if (freqChoice === "Custom schedule" && !$("#medFrequencyCustom").value.trim()) {
      return fail("Describe the custom schedule, or pick one of the fixed frequencies.");
    }
    if (payload.startDate && payload.endDate && payload.endDate < payload.startDate) {
      return fail("The end date can't be before the start date.");
    }

    const btn = $("#medFormSubmit");
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      if (editingId) await ctx.updateMedication(editingId, payload);
      else           await ctx.addMedication(payload);
      closeModal("medFormModal");
      toast(editingId ? "Medication updated" : "Medication added", "ok");
      ctx.repaint();
      openManage(session);
    } catch (err) {
      fail(err.message || "Could not save that medication.");
    } finally {
      btn.disabled = false; btn.textContent = original;
    }
  });
}

function fail(msg) {
  const el = $("#medFormError");
  el.textContent = msg;
  el.hidden = false;
}
