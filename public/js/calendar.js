/* =====================================================================
   calendar.js — feeding tracker calendar (month + week views).
   ---------------------------------------------------------------------
   Opened from the Feeding schedule card, always scoped to whichever pet
   is currently open — app.js calls open() fresh every time the modal is
   shown and passes the pet/store/callback for THAT pet, so switching
   pets and reopening always shows that pet's own schedule and history;
   nothing here is cached across pets.

   Unlike the dashboard, this does NOT ride the always-on 8-day careLogs
   listener — a month view needs more history than that "keep reads low"
   cap allows, so every render does its own one-off store.getLogsInRange()
   read instead of widening the permanent listener (see store-firebase.js
   for why that stays a plain query with no new composite index needed).
   ===================================================================== */

import { $, esc, STATUS_LABEL as LABEL, STATUS_PILL as PILL } from "./ui.js";
import {
  now, todayKey, fmtClock, istTimeToday, splitDayKey,
  monthGridDayKeys, weekDayKeys, shiftMonth, shiftDayKey, monthLabel
} from "./time.js";
import {
  buildDayFeedingRows, summarizeFeedingDay,
  buildDayMedicationRows, summarizeMedicationDay
} from "./data.js";

const DAY_STATUS_DOT = {
  completed: "cal-dot-ok",
  partial:   "cal-dot-warn",
  missed:    "cal-dot-crit",
  today:     "cal-dot-today",
  upcoming:  "cal-dot-upcoming",
  "no-data": "cal-dot-none"
};
const DAY_STATUS_TEXT = {
  feeding: {
    completed: "All feedings logged",
    partial:   "Some feedings logged",
    missed:    "Feeding not logged",
    today:     "Today — still open",
    upcoming:  "Upcoming",
    "no-data": "No record for this day"
  },
  medication: {
    completed: "All doses given",
    partial:   "Some doses given",
    missed:    "Dose(s) not logged",
    today:     "Today — still open",
    upcoming:  "Upcoming",
    "no-data": "No medication scheduled"
  }
};
const SLOT_LABEL = (i) => ["Breakfast", "Lunch", "Dinner"][i] || `Feed ${i + 1}`;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let ctx = null;             // { pet, store, onGiveFeeding, medications, onGiveMedication }
let view = "month";         // "month" | "week"
let dataType = "feeding";   // "feeding" | "medication" — which schedule the grid reflects
let cursorYear, cursorMonth;
let cursorWeekAnchor;       // any dayKey inside the week currently shown
let wired = false;

/** Opens the calendar for whichever pet is passed in `newCtx`. Always
    resets to the current month/week — a stale cursor left over from a
    different pet's session would be confusing, not convenient. Also
    always resets to the Feeding tab, for the same reason. */
export async function open(newCtx) {
  ctx = newCtx;
  const t = splitDayKey(todayKey());
  cursorYear = t.year;
  cursorMonth = t.month;
  cursorWeekAnchor = todayKey();
  view = "month";
  dataType = "feeding";
  wireOnce();
  setTab();
  setDataTab();
  $("#calendarModal").hidden = false;
  await render();
}

function wireOnce() {
  if (wired) return;
  wired = true;
  $("#calTabMonth").addEventListener("click", () => { view = "month"; setTab(); render(); });
  $("#calTabWeek").addEventListener("click", () => { view = "week"; setTab(); render(); });
  $("#calPrev").addEventListener("click", () => nav(-1));
  $("#calNext").addEventListener("click", () => nav(1));
  $("#calToday").addEventListener("click", () => {
    const t = splitDayKey(todayKey());
    cursorYear = t.year; cursorMonth = t.month; cursorWeekAnchor = todayKey();
    render();
  });
  $("#calDataFeeding").addEventListener("click", () => { dataType = "feeding"; setDataTab(); render(); });
  $("#calDataMedication").addEventListener("click", () => { dataType = "medication"; setDataTab(); render(); });
}

function setTab() {
  $("#calTabMonth").classList.toggle("is-on", view === "month");
  $("#calTabWeek").classList.toggle("is-on", view === "week");
  $("#calWeekBody").hidden = view !== "week";
  $("#calMonthBody").hidden = view !== "month";
}

function setDataTab() {
  $("#calDataFeeding").classList.toggle("is-on", dataType === "feeding");
  $("#calDataMedication").classList.toggle("is-on", dataType === "medication");
}

function nav(dir) {
  if (view === "month") {
    const s = shiftMonth(cursorYear, cursorMonth, dir);
    cursorYear = s.year; cursorMonth = s.month;
  } else {
    cursorWeekAnchor = shiftDayKey(cursorWeekAnchor, dir * 7);
  }
  render();
}

async function render() {
  if (!ctx?.pet) return;
  const pet = ctx.pet;
  const today = todayKey();
  const at = now();

  if (view === "month") {
    const gridDays = monthGridDayKeys(cursorYear, cursorMonth);
    const logs = await ctx.store.getLogsInRange(gridDays[0], gridDays[gridDays.length - 1]);
    const byDay = groupByDay(logs);

    $("#calTitle").textContent = monthLabel(cursorYear, cursorMonth);
    renderMonthGrid(pet, gridDays, byDay, today, at);
  } else {
    const week = weekDayKeys(cursorWeekAnchor);
    const logs = await ctx.store.getLogsInRange(week[0], week[week.length - 1]);
    const byDay = groupByDay(logs);

    $("#calTitle").textContent = `${fmtDayLabel(week[0])} – ${fmtDayLabel(week[6])}`;
    renderWeek(pet, week, byDay, today, at);
  }
}

/** Single switch point between the two data types this calendar can show —
    everything downstream (grid dots, week rows) calls through these two
    functions rather than branching on dataType itself. */
function summarizeDay(pet, dayKey, dayLogs, today, at) {
  return dataType === "medication"
    ? summarizeMedicationDay(ctx.medications?.() || [], dayKey, dayLogs, today, at)
    : summarizeFeedingDay(pet, dayKey, dayLogs, today, at);
}

function dayRows(pet, dayKey, dayLogs, today, at) {
  return dataType === "medication"
    ? buildDayMedicationRows(ctx.medications?.() || [], dayKey, dayLogs, today, at)
    : buildDayFeedingRows(pet, dayKey, dayLogs, today, at);
}

function groupByDay(logs) {
  const map = new Map();
  for (const l of logs) {
    if (!map.has(l.dayKey)) map.set(l.dayKey, []);
    map.get(l.dayKey).push(l);
  }
  return map;
}

function fmtDayLabel(dayKey) {
  const { month, day } = splitDayKey(dayKey);
  return new Date(Date.UTC(2000, month - 1, day))
    .toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/* ------------------------------------------------------------------ */
function renderMonthGrid(pet, gridDays, byDay, today, at) {
  const wrap = $("#calMonthGrid");
  wrap.innerHTML = "";

  for (const wd of WEEKDAYS) {
    const h = document.createElement("div");
    h.className = "cal-weekday";
    h.textContent = wd;
    wrap.appendChild(h);
  }

  for (const dayKey of gridDays) {
    const { month, day } = splitDayKey(dayKey);
    const dayLogs = byDay.get(dayKey) || [];
    const summary = summarizeDay(pet, dayKey, dayLogs, today, at);

    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "cal-cell";
    if (month !== cursorMonth) cell.classList.add("is-outside");
    if (dayKey === today) cell.classList.add("is-today");
    cell.title = DAY_STATUS_TEXT[dataType][summary];
    cell.innerHTML = `
      <span class="cal-daynum">${day}</span>
      <span class="cal-dot ${DAY_STATUS_DOT[summary]}"></span>`;
    cell.addEventListener("click", () => { view = "week"; cursorWeekAnchor = dayKey; setTab(); render(); });
    wrap.appendChild(cell);
  }
}

/* ------------------------------------------------------------------ */
function renderWeek(pet, week, byDay, today, at) {
  const wrap = $("#calWeekList");
  wrap.innerHTML = "";

  for (const dayKey of week) {
    const dayLogs = byDay.get(dayKey) || [];
    const rows = dayRows(pet, dayKey, dayLogs, today, at);
    const isToday = dayKey === today;

    const card = document.createElement("div");
    card.className = `cal-day-card${isToday ? " is-today" : ""}`;
    card.innerHTML = `<div class="cal-day-head">${esc(weekdayLong(dayKey))}, ${esc(fmtDayLabel(dayKey))}${isToday ? ' <span class="tag-today">Today</span>' : ""}</div>`;

    const list = document.createElement("ul");
    list.className = "med-list";
    if (!rows.length) {
      list.innerHTML = dataType === "medication"
        ? `<p class="empty">No medications scheduled this day.</p>`
        : `<p class="empty">No feeding times configured.</p>`;
    } else {
      rows.forEach((row, i) => list.appendChild(weekSlotItem(row, i, isToday)));
    }
    card.appendChild(list);
    wrap.appendChild(card);
  }
}

function weekdayLong(dayKey) {
  const { year, month, day } = splitDayKey(dayKey);
  return new Date(Date.UTC(year, month - 1, day))
    .toLocaleString("en-US", { weekday: "long", timeZone: "UTC" });
}

function weekSlotItem(row, index, isToday) {
  const li = document.createElement("li");
  li.className = `med-item s-${row.status}`;

  const sub = row.status === "COMPLETED"
    ? `Given by ${esc(row.loggedBy || "—")}${row.loggedAt ? ` at ${fmtClock(row.loggedAt)}` : ""}`
    : row.status === "MISSED" ? "Not logged"
      : row.status === "OVERDUE" ? "Overdue"
        : row.status === "DUE_NOW" ? "Due now"
          : "Upcoming";

  /* Feeding rows have no name of their own (Breakfast/Lunch/Dinner by
     slot order); medication rows show the medication's own name and
     dosage — this is the one place the two data types actually look
     different, everything else (status pill, "mark as given") is shared. */
  const title = dataType === "medication"
    ? `${esc(row.name)} · ${esc(row.dosage)}`
    : esc(SLOT_LABEL(index));

  li.innerHTML = `
    <div class="med-slot">${esc(fmtClock(istTimeTodayForSlot(row.slot)))}</div>
    <div>
      <div class="med-name">${title}</div>
      <p class="med-meta">${sub}</p>
    </div>
    <div class="med-right">
      <span class="pill ${PILL[row.status] || "p-up"}">${LABEL[row.status] || row.status}</span>
    </div>`;

  const onGive = dataType === "medication" ? ctx?.onGiveMedication : ctx?.onGiveFeeding;
  if (isToday && row.status !== "COMPLETED" && onGive) {
    const btn = document.createElement("button");
    btn.className = "btn btn-primary btn-sm";
    btn.textContent = "Mark as given";
    btn.addEventListener("click", async () => {
      await onGive(row);
      render();
    });
    li.querySelector(".med-right").appendChild(btn);
  }
  return li;
}

/* A slot is just a clock time ("08:00") — istTimeToday() resolves it
   against today's date regardless of which calendar day the row is
   being rendered for, which is fine: only the hour:minute is shown. */
const istTimeTodayForSlot = (slot) => istTimeToday(slot);
