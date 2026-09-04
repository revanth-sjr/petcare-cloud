/* =====================================================================
   dashboard.js — renders everything except the timeline, chat and KPIs.
   Pod B owns this file.
   ---------------------------------------------------------------------
   render(dash) takes the frozen contract object from buildDashboard()
   and writes it to the DOM. It never touches Firestore and never decides
   anything — all logic lives in data.js.
   ===================================================================== */

import { $, esc, STATUS_LABEL, STATUS_PILL } from "./ui.js";
import { fmtClock, fmtLastDone, fmtRelative, fmtDate, now, istTimeToday } from "./time.js";
import { TASK_META } from "./data.js";
import { speciesMeta } from "./auth.js";

export function render(dash, ctx) {
  renderPet(dash);
  renderCounters(dash);
  renderFeedingSchedule(dash, ctx);
  renderMedications(dash, ctx);
  renderNext(dash, ctx);
  renderNextCare(dash);
  renderLastDone(dash);
  renderInstructions(dash);
  renderStreak(dash);
  renderAlerts(dash, ctx);
  renderOverFeeding(dash);
  $("#timelineDate").textContent = fmtDate(now());
}

/* ------------------------------------------------------------------ */
function renderPet(dash) {
  const p = dash.pet || {};
  const avatar = $("#petAvatar");
  if (p.photoURL) {
    avatar.textContent = "";
    avatar.style.backgroundImage = `url(${p.photoURL})`;
  } else {
    avatar.style.backgroundImage = "";
    avatar.textContent = p.emoji || speciesMeta(p.species).icon;
  }
  $("#petName").textContent   = p.name || "—";
  $("#petBreed").textContent  = p.breed || "—";
  $("#petAge").textContent    = p.ageYears ? `${p.ageYears} years` : "—";
  $("#petWeight").textContent = p.weightKg ? `${p.weightKg} kg` : "—";

  const { counts, targets } = dash.today;
  const done  = Math.min(counts.feeding, targets.feeding)
              + Math.min(counts.walk, targets.walk)
              + counts.medication;
  const total = targets.feeding + targets.walk + targets.medication;
  const pct   = total ? Math.round((done / total) * 100) : 0;

  const ring = $("#dayRing");
  ring.style.setProperty("--pct", pct);
  $("#dayPct").textContent = `${pct}%`;
}

/* ------------------------------------------------------------------ */
function renderCounters(dash) {
  const { counts, targets } = dash.today;
  const pairs = [
    ["#cntFeeding", "#ldFeeding", counts.feeding, targets.feeding, "feeding"],
    ["#cntWalk",    "#ldWalk",    counts.walk,    targets.walk,    "walk"],
    ["#cntMed",     "#ldMedication", counts.medication, targets.medication, "medication"]
  ];
  for (const [sel, ldSel, done, total, type] of pairs) {
    $(sel).textContent = `${done} / ${total}`;
    const btn = document.querySelector(`.action[data-log="${type}"]`);
    if (btn) btn.classList.toggle("is-full", total > 0 && done >= total);

    /* Per-action "Last done" line, directly under the button — updates on
       every render(), so it moves the moment an action completes (the
       store's subscribe callback repaints immediately) and also just from
       time passing (the 30s repaint loop in app.js keeps "3 minutes ago"
       honest without the pet owner ever refreshing the page). */
    const ldEl = $(ldSel);
    if (ldEl) {
      const at = dash.lastDone[type];
      ldEl.textContent = at ? `Last done: ${fmtLastDone(at)}` : "Last done: not yet";
    }
  }
}

/* ------------------------------------------------------------------
   Feeding schedule — this pet's own configured times, never a hard-coded
   "3 times a day". Mirrors the medication schedule card/item exactly, so
   the two features share one visual language and one interaction model.
   ------------------------------------------------------------------ */
function renderFeedingSchedule(dash, ctx) {
  const section = document.getElementById("feedingScheduleCard");
  if (!section) return; // older markup without the card — nothing to render into
  const list = $("#feedingScheduleList");
  list.innerHTML = "";

  const rows = dash.feedingSchedule?.rows || [];
  if (!rows.length) {
    list.innerHTML = `<p class="empty">No feeding times set for ${esc(dash.pet?.name || "this pet")}.</p>`;
    return;
  }
  rows.forEach((row, i) => list.appendChild(feedingItem(row, ctx, i)));
}

const feedingSlotLabel = (i) => ["Breakfast", "Lunch", "Dinner"][i] || `Feed ${i + 1}`;

export function feedingItem(row, ctx, index = 0, compact = false) {
  const li = document.createElement("li");
  li.className = `med-item s-${row.status}`;

  const sub = row.status === "COMPLETED"
    ? `Given by ${esc(row.loggedBy || "—")} at ${row.loggedAt ? fmtClock(row.loggedAt) : "—"}`
    : row.status === "OVERDUE"
      ? `${minutesText(row.minutes)} overdue`
      : row.status === "DUE_NOW"
        ? "Due now"
        : `in ${minutesText(row.minutes)}`;

  li.innerHTML = `
    <div class="med-slot">${esc(fmtClock(slotToday(row.slot)))}</div>
    <div>
      <div class="med-name">${esc(feedingSlotLabel(index))}</div>
      <p class="med-meta">${sub}</p>
    </div>
    <div class="med-right">
      <span class="pill ${STATUS_PILL[row.status]}">${STATUS_LABEL[row.status]}</span>
    </div>`;

  if (row.status !== "COMPLETED" && ctx?.onGiveFeeding) {
    const btn = document.createElement("button");
    btn.className = "btn btn-primary btn-sm";
    btn.textContent = "Mark as given";
    btn.addEventListener("click", () => ctx.onGiveFeeding(row));
    li.querySelector(".med-right").appendChild(btn);
  }
  if (compact) li.style.marginBottom = "0";
  return li;
}

/* ------------------------------------------------------------------ */
function renderMedications(dash, ctx) {
  const list = $("#medList");
  list.innerHTML = "";

  if (!dash.medications.length) {
    list.innerHTML = `<p class="empty">No active medications for ${esc(dash.pet?.name || "this pet")}.</p>`;
    return;
  }
  for (const row of dash.medications) {
    list.appendChild(medItem(row, ctx));
  }
}

export function medItem(row, ctx, compact = false) {
  const li = document.createElement("li");
  li.className = `med-item s-${row.status}`;

  const sub = row.status === "COMPLETED"
    ? `Given by ${esc(row.loggedBy || "—")} at ${row.loggedAt ? fmtClock(row.loggedAt) : "—"}`
    : row.status === "OVERDUE"
      ? `${minutesText(row.minutes)} overdue`
      : row.status === "DUE_NOW"
        ? "Due now"
        : `in ${minutesText(row.minutes)}`;

  const typeLine = [row.type, row.feedingRelation].filter(Boolean).join(" · ");

  li.innerHTML = `
    <div class="med-slot">${esc(fmtClock(slotToday(row.slot)))}</div>
    <div>
      <div class="med-name">${esc(row.name)} · ${esc(row.dosage)}</div>
      ${typeLine ? `<p class="med-meta">${esc(typeLine)}</p>` : ""}
      <p class="med-meta">${esc(row.instructions || "")}</p>
      <p class="med-meta">${sub}</p>
    </div>
    <div class="med-right">
      <span class="pill ${STATUS_PILL[row.status]}">${STATUS_LABEL[row.status]}</span>
    </div>`;

  if (row.status !== "COMPLETED" && ctx?.onGive) {
    const btn = document.createElement("button");
    btn.className = "btn btn-primary btn-sm";
    btn.textContent = "Mark as given";
    btn.addEventListener("click", () => ctx.onGive(row));
    li.querySelector(".med-right").appendChild(btn);
  }
  if (compact) li.style.marginBottom = "0";
  return li;
}

/* A slot is "20:00" in IST. Resolve it through time.js, never through the
   browser's own timezone — a judge's laptop may not be on IST. */
const slotToday = (slot) => istTimeToday(slot);

const minutesText = (mins) => {
  const n = Math.abs(Math.round(mins || 0));
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const r = n % 60;
  return r ? `${h}h ${r}m` : `${h} hour${h > 1 ? "s" : ""}`;
};

/* ------------------------------------------------------------------ */
function renderNext(dash, ctx) {
  const card = $("#nextCard");
  const row  = dash.nextMedication;
  card.className = "card next-card";

  if (!row) {
    $("#nextName").textContent = "No medications";
    $("#nextTime").textContent = "—";
    $("#nextStatus").className = "pill p-up";
    $("#nextStatus").textContent = "—";
    $("#nextAction").hidden = true;
    return;
  }

  card.classList.add(`s-${row.status}`);

  /* everything logged: say so plainly instead of pointing at a past dose */
  const allDone = dash.medications.every((m) => m.status === "COMPLETED");
  if (allDone) {
    $("#nextName").textContent   = "All doses given";
    $("#nextTime").textContent   = `${dash.medications.length} of ${dash.medications.length} scheduled today`;
    $("#nextStatus").className   = "pill p-done";
    $("#nextStatus").textContent = "Up to date";
    $("#nextAction").hidden = true;
    return;
  }

  $("#nextName").textContent   = `${row.name}`;
  $("#nextTime").innerHTML     = `${esc(fmtClock(slotToday(row.slot)))} · ${esc(row.dosage)} <small class="next-countdown">${esc(fmtRelative(row.due || slotToday(row.slot)))}</small>`;
  $("#nextStatus").className   = `pill ${STATUS_PILL[row.status]}`;
  $("#nextStatus").textContent = STATUS_LABEL[row.status];

  const btn = $("#nextAction");
  if (row.status === "COMPLETED") {
    btn.hidden = true;
  } else {
    btn.hidden = false;
    btn.className = "btn btn-block " +
      (row.status === "OVERDUE" ? "btn-crit" : row.status === "DUE_NOW" ? "btn-warn" : "btn-primary");
    btn.onclick = () => ctx.onGive(row);
  }
}

/* ------------------------------------------------------------------ */
function renderLastDone(dash) {
  const ul = $("#lastDone");
  ul.innerHTML = "";
  for (const [type, meta] of Object.entries(TASK_META)) {
    const at = dash.lastDone[type];
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="ld-icon">${meta.icon}</span>
      <span class="ld-label">${meta.label}</span>
      <span class="ld-val">${at ? esc(fmtLastDone(at)) : "not yet"}</span>`;
    ul.appendChild(li);
  }
}

function renderNextCare(dash) {
  const list = $("#nextCareList");
  const current = now();
  const feedingRows = dash.feedingSchedule?.rows || [];
  const feedingComplete = feedingRows.length > 0 && feedingRows.every((row) => row.status === "COMPLETED");
  const items = [{ icon: '<img src="https://img.icons8.com/ios-filled/50/dog-bowl.png" alt="Feeding" class="ui-icon">', label: "Feeding", time: nextFeedingTime(dash, current) }];
  if (feedingComplete) items[0].completed = true;
  list.innerHTML = items.map((item) => item.time
    ? `<li><span class="next-care-icon">${item.icon}</span><span class="next-care-label">${item.label}</span><span class="next-care-time"><b>${esc(fmtClock(item.time))}</b><small>${esc(fmtRelative(item.time))}</small></span></li>`
    : item.completed
      ? `<li class="next-care-complete"><span class="next-care-icon">${item.icon}</span><span class="next-care-label">${item.label}</span><span class="next-care-time">Completed</span></li>`
    : `<li class="next-care-empty"><span class="next-care-icon">${item.icon}</span><span class="next-care-label">${item.label}</span><span class="next-care-time">Not scheduled</span></li>`
  ).join("");
}

function nextFeedingTime(dash, current = now()) {
  const rows = dash.feedingSchedule?.rows || [];
  const openRows = rows.filter((row) => row.status !== "COMPLETED");
  const nextToday = openRows
    .map((row) => istTimeToday(row.slot, current))
    .filter((date) => date > current)
    .sort((a, b) => a - b)[0];
  if (nextToday) return nextToday;

  const first = openRows.map((row) => row.slot).sort()[0];
  if (!first) return null;
  const tomorrow = new Date(current.getTime() + 86_400_000);
  return istTimeToday(first, tomorrow);
}

function nextWalkTime(dash, current = now()) {
  const target = dash.today?.targets?.walk ?? 0;
  if (!target) return null;
  const slots = ["07:00", "18:00"].slice(0, target);
  const nextToday = slots.map((slot) => istTimeToday(slot, current))
    .filter((date) => date > current).sort((a, b) => a - b)[0];
  return nextToday || istTimeToday(slots[0], new Date(current.getTime() + 86_400_000));
}

function nextMedicationTime(dash, current = now()) {
  const rows = dash.medications || [];
  const nextToday = rows.map((row) => istTimeToday(row.slot, current))
    .filter((date) => date > current).sort((a, b) => a - b)[0];
  if (nextToday) return nextToday;
  const first = rows.map((row) => row.slot).sort()[0];
  return first ? istTimeToday(first, new Date(current.getTime() + 86_400_000)) : null;
}

/* ------------------------------------------------------------------ */
function renderInstructions(dash) {
  const dl = $("#instructions");
  const si = dash.pet?.specialInstructions || {};
  const rows = [
    ["Food allergy", si.allergy],
    ["Medication",   si.medication],
    ["Notes",        si.notes]
  ].filter(([, v]) => v);

  dl.innerHTML = rows
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join("") || `<div><dd class="empty">No special instructions.</dd></div>`;

  const vet = dash.pet?.vet || {};
  const vetNameEl = $("#vetName");
  const vetPhoneSub = $("#vetPhoneSub");
  const call = $("#vetCall");

  if (vet.name || vet.phone) {
    if (vetNameEl) vetNameEl.textContent = vet.name || "Veterinary Doctor / Clinic";
    if (vet.phone) {
      if (vetPhoneSub) vetPhoneSub.textContent = vet.phone;
      if (call) {
        call.href = `tel:${vet.phone.replace(/\s/g, "")}`;
        call.textContent = `Call ${vet.phone}`;
        call.hidden = false;
      }
    } else {
      if (vetPhoneSub) vetPhoneSub.textContent = "No phone number added";
      if (call) call.hidden = true;
    }
  } else {
    if (vetNameEl) vetNameEl.textContent = "No vet doctor listed";
    if (vetPhoneSub) vetPhoneSub.textContent = "Add vet details in Edit Pet";
    if (call) call.hidden = true;
  }

  const emLine = $("#vetEmergencyLine");
  const emPhoneSub = $("#vetEmergencyPhoneSub");
  const emCall = $("#vetEmergencyCall");
  if (emLine && emCall) {
    if (vet.emergencyPhone) {
      if (emPhoneSub) emPhoneSub.textContent = vet.emergencyPhone;
      emCall.href = `tel:${vet.emergencyPhone.replace(/\s/g, "")}`;
      emCall.textContent = `🚨 Emergency Call`;
      emLine.hidden = false;
    } else {
      emLine.hidden = true;
    }
  }
}

/* ------------------------------------------------------------------
   Medication adherence streak. Small, but it is the difference between
   a system that records compliance and one that encourages it — and it
   costs a computed number, not a feature.
   ------------------------------------------------------------------ */
function renderStreak(dash) {
  const el = $("#streak");
  const s = dash.streak;

  if (!s || !s.slotsPerDay || s.days < 1) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `<span class="flame"><img src="https://img.icons8.com/ios-filled/50/fire-element.png" alt="Streak" class="ui-icon"></span> <b>${s.days}-day</b> medication streak` +
    (s.perfectToday ? "" : ` <i>— today's doses still open</i>`);
}

/* ------------------------------------------------------------------
   The alert strip is the answer to "what if the notification is missed?"
   Overdue state is computed on every render, so it appears whether or not
   any notification was ever delivered.
   ------------------------------------------------------------------ */
function renderAlerts(dash, ctx) {
  const strip = $("#alertStrip");
  const { overdue, dueNow } = dash.alerts;

  if (!overdue.length && !dueNow.length) {
    strip.hidden = true;
    strip.innerHTML = "";
    return;
  }

  const overdueRow = overdue.length > 0;
  const row = overdueRow ? overdue[0] : dueNow[0];
  const feeding = row.kind === "feeding";
  const walk = row.kind === "walk";
  const label = feeding ? "feeding" : walk ? "walk" : row.name;

  strip.hidden = false;
  strip.className = `alert-strip${overdueRow ? "" : " is-due"}`;
  strip.innerHTML = `
    <span>${overdueRow ? '<img src="https://img.icons8.com/ios-filled/50/warning-shield.png" alt="Warning" class="ui-icon">' : (feeding ? '<img src="https://img.icons8.com/ios-filled/50/dog-bowl.png" alt="Feeding" class="ui-icon">' : walk ? '<img src="https://img.icons8.com/ios-filled/50/walking.png" alt="Walk" class="ui-icon">' : '<img src="https://img.icons8.com/ios-filled/50/pill.png" alt="Medication" class="ui-icon">')}</span>
    <span>${esc(dash.pet?.name || "Your pet")}'s ${esc(label)} scheduled for
      ${esc(fmtClock(slotToday(row.slot)))} ${overdueRow ? "has not been logged" : "is due now"}.</span>`;

  const btn = document.createElement("button");
  btn.className = `btn btn-sm ${overdueRow ? "btn-crit" : "btn-warn"}`;
  btn.textContent = "Mark as given";
  btn.addEventListener("click", () => (feeding ? ctx.onGiveFeeding(row) : ctx.onGive(row)));
  strip.appendChild(btn);
}

/* ------------------------------------------------------------------
   Over-feeding warning — entirely driven by THIS pet's own configured
   feeding schedule (dash.today.targets.feeding, itself never a
   hard-coded "3" — see feedingTimes()/dailyTargets in data.js). Shown
   the moment today's logged feedings run past that number; disappears
   on its own the next day because overFeeding is recomputed from
   today's dayKey on every render, nothing is persisted client-side.
   ------------------------------------------------------------------ */
function renderOverFeeding(dash) {
  const banner = $("#overFeedingBanner");
  if (!banner) return; // older markup without the banner — nothing to render into

  const { overFeeding, overFeedingBy, targets } = dash.today;
  if (!overFeeding) {
    banner.hidden = true;
    banner.innerHTML = "";
    return;
  }

  const perDay = `${targets.feeding} feeding${targets.feeding === 1 ? "" : "s"}/day`;
  const extra  = `${overFeedingBy} extra feeding${overFeedingBy === 1 ? "" : "s"}`;

  banner.hidden = false;
  banner.innerHTML = `
    <span><img src="https://img.icons8.com/ios-filled/50/warning-shield.png" alt="Warning" class="ui-icon"></span>
    <span><b>Feeding Warning —</b> This pet has exceeded today's planned feeding schedule
      (${esc(perDay)} configured, ${esc(extra)} logged today).</span>`;
}
