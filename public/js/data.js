/* =====================================================================
   data.js — the model. Pure functions plus the store facade.
   Pod A owns this.
   ---------------------------------------------------------------------
   Nothing in here touches the DOM. Everything the UI renders comes out of
   buildDashboard() in exactly the shape frozen in the blueprint (§05), so
   Pod B could build the whole dashboard against mock-dashboard.json.
   ===================================================================== */

import { GRACE_MINUTES, isFirebaseConfigured } from "./config.js";
import { istTimeToday, now, todayKey, toDate, dayKeyOffset, dayKeyIST } from "./time.js";

export const TASK_TYPES = ["feeding", "walk", "medication"];

export const TASK_META = {
  feeding:    { label: "Feeding",    icon: "🍖", verb: "Log Feeding"    },
  walk:       { label: "Walk",       icon: "🚶", verb: "Log Walk"       },
  medication: { label: "Medication", icon: "💊", verb: "Log Medication" }
};

/* ---------------------------------------------------------------------
   Slot status — computed, never stored.
   This is the whole reminder engine. There is no cron job, no scheduler
   and no background worker: a dose (or a feeding) becomes OVERDUE because
   time passed, not because something ran. Medication and feeding both
   reduce to "was this exact slot logged today, and if not, where does
   `at` sit relative to it" — slotStatus() is that shared rule so the two
   features can never quietly drift apart.
   ------------------------------------------------------------------ */
function slotStatus(logged, slot, at) {
  if (logged) {
    return {
      state: "COMPLETED",
      loggedBy: logged.performedBy,
      loggedAt: toDate(logged.at),
      minutes: 0
    };
  }

  const due  = istTimeToday(slot, at);
  const mins = Math.round((at - due) / 60_000);

  if (mins < 0)                return { state: "UPCOMING", minutes: -mins, due };
  if (mins <= GRACE_MINUTES)   return { state: "DUE_NOW",  minutes: mins,  due };
  return { state: "OVERDUE", minutes: mins, due };
}

export function statusFor(med, slot, logsToday, at = now()) {
  const logged = logsToday.find(
    (l) => l.type === "medication" && l.medicationId === med.id && l.slot === slot
  );
  return slotStatus(logged, slot, at);
}

/** Same rule as statusFor(), for a pet's own feeding times instead of a
    medication's doses — feeding has one schedule per pet, not one per
    medication, so there is no id to match, just the slot itself. */
export function feedingStatusFor(slot, logsToday, at = now()) {
  const logged = logsToday.find((l) => l.type === "feeding" && l.slot === slot);
  return slotStatus(logged, slot, at);
}

/* ---------------------------------------------------------------------
   Per-pet feeding schedule. Never a hard-coded "3 times a day" — a pet's
   own feedingSchedule.times (set during onboarding or the edit-pet form)
   is always what actually drives the dashboard, reminders and calendar.
   A pet saved before this feature existed has no feedingSchedule at all;
   dailyTargets.feeding (which every pet has always had) tells us how
   many times a day without inventing a number, and a fixed set of sane
   default clock times fills in the rest — no migration, nothing
   overwritten, existing pets just work. ------------------------------ */
const DEFAULT_FEEDING_TIMES = ["08:00", "13:00", "19:00", "07:00", "21:00"];

export function feedingTimes(pet) {
  const custom = pet?.feedingSchedule?.times;
  if (Array.isArray(custom) && custom.length) return [...custom].sort();
  const n = pet?.dailyTargets?.feeding ?? 3;
  return DEFAULT_FEEDING_TIMES.slice(0, Math.max(1, n));
}

/** Matches a day's feeding logs to the pet's configured feeding times. An
    exact `slot` match wins; a feeding logged without one — the one-click
    "Log Feeding" action, or history recorded before per-slot tracking
    existed — fills the earliest still-open time in chronological order.
    Without this, every feeding logged before this feature shipped would
    wrongly show as a missed/overdue slot on the calendar and dashboard,
    which is exactly the kind of existing-data breakage the schedule
    feature must not cause. */
export function matchFeedingSlots(feedingSlots, logsForDay) {
  const bySlot = new Map();
  const unslotted = [];
  for (const l of logsForDay) {
    if (l.type !== "feeding") continue;
    if (l.slot && feedingSlots.includes(l.slot) && !bySlot.has(l.slot)) bySlot.set(l.slot, l);
    else unslotted.push(l);
  }
  unslotted.sort((a, b) => toDate(a.at) - toDate(b.at));

  let i = 0;
  const result = new Map();
  for (const slot of [...feedingSlots].sort()) {
    if (bySlot.has(slot))          result.set(slot, bySlot.get(slot));
    else if (i < unslotted.length) result.set(slot, unslotted[i++]);
  }
  return result;
}

/* ---------------------------------------------------------------------
   Feeding calendar — per-day status for an arbitrary date, not just
   today. Reuses feedingTimes()/matchFeedingSlots() so a custom schedule
   (Section 1/2) drives the calendar exactly the way it drives the
   dashboard; nothing here is a second source of truth.
   ------------------------------------------------------------------ */

/** This one day's feeding rows. A future day is always UPCOMING (nothing
    to log yet); today reuses the live OVERDUE/DUE_NOW/UPCOMING/COMPLETED
    logic; a past day collapses to COMPLETED or MISSED — there is no
    "overdue by 3 days", the day is simply over. */
export function buildDayFeedingRows(pet, dayKey, dayLogs, todayKeyStr, at = now()) {
  const slots  = feedingTimes(pet);
  const bySlot = matchFeedingSlots(slots, dayLogs);
  const isFuture = dayKey > todayKeyStr;
  const isToday  = dayKey === todayKeyStr;

  return slots.map((slot) => {
    const log = bySlot.get(slot) || null;
    if (log) {
      return { slot, status: "COMPLETED", loggedBy: log.performedBy, loggedAt: toDate(log.at) };
    }
    if (isFuture) return { slot, status: "UPCOMING" };
    if (isToday)  { const st = slotStatus(null, slot, at); return { slot, status: st.state, minutes: st.minutes }; }
    return { slot, status: "MISSED" };
  });
}

/** One label per day for the month grid: "completed" (every feeding
    logged), "partial" (some but not all), "missed" (a past day with
    activity but no feeding logged at all), "today" (today, still open),
    "upcoming" (a future day), or "no-data" — a past day with zero logs
    of ANY kind. That last one deliberately does not claim "missed": the
    app has no record of when this pet's history actually starts, so a
    silent day before that point must read as unknown, not as a failure. */
export function summarizeFeedingDay(pet, dayKey, dayLogs, todayKeyStr, at = now()) {
  if (dayKey > todayKeyStr) return "upcoming";

  const rows = buildDayFeedingRows(pet, dayKey, dayLogs, todayKeyStr, at);
  const done = rows.filter((r) => r.status === "COMPLETED").length;

  if (dayKey === todayKeyStr) {
    if (!dayLogs.length && !done) return "today";
    if (done === rows.length && rows.length > 0) return "completed";
    return done > 0 ? "partial" : "today";
  }

  if (!dayLogs.length) return "no-data";
  if (done === rows.length && rows.length > 0) return "completed";
  return done > 0 ? "partial" : "missed";
}

/* ---------------------------------------------------------------------
   Medication calendar — the same day-by-day shape as
   buildDayFeedingRows()/summarizeFeedingDay() above, so the calendar's
   month/week grid rendering is shared code, just fed a different rows
   builder. One row per medication per scheduled time that was active
   that day (respecting each medication's own startDate/endDate window,
   exactly like the live dashboard). Unlike feeding, a medication log
   always carries an explicit medicationId + slot, so this is a direct
   lookup rather than matchFeedingSlots()'s proximity matching. ------ */
export function buildDayMedicationRows(medications, dayKey, dayLogs, todayKeyStr, at = now()) {
  const isFuture = dayKey > todayKeyStr;
  const isToday  = dayKey === todayKeyStr;
  const rows = [];

  for (const med of medications || []) {
    if (med.active === false) continue;
    if (med.startDate && med.startDate > dayKey) continue;
    if (med.endDate && med.endDate < dayKey) continue;

    for (const slot of med.scheduledTimes || []) {
      const base = { medicationId: med.id, name: med.name, dosage: med.dosage, slot };
      const log = dayLogs.find(
        (l) => l.type === "medication" && l.medicationId === med.id && l.slot === slot
      ) || null;

      if (log) {
        rows.push({ ...base, status: "COMPLETED", loggedBy: log.performedBy, loggedAt: toDate(log.at) });
      } else if (isFuture) {
        rows.push({ ...base, status: "UPCOMING" });
      } else if (isToday) {
        const st = slotStatus(null, slot, at);
        rows.push({ ...base, status: st.state, minutes: st.minutes });
      } else {
        rows.push({ ...base, status: "MISSED" });
      }
    }
  }
  return rows.sort((a, b) => a.slot.localeCompare(b.slot));
}

/** Same categories as summarizeFeedingDay(), for medication adherence.
    A day with no rows at all means this pet had no active medication
    scheduled that day — "no-data", not "missed": there was nothing to
    miss. */
export function summarizeMedicationDay(medications, dayKey, dayLogs, todayKeyStr, at = now()) {
  if (dayKey > todayKeyStr) return "upcoming";

  const rows = buildDayMedicationRows(medications, dayKey, dayLogs, todayKeyStr, at);
  if (!rows.length) return "no-data";
  const done = rows.filter((r) => r.status === "COMPLETED").length;

  if (dayKey === todayKeyStr) {
    if (done === rows.length) return "completed";
    return done > 0 ? "partial" : "today";
  }

  if (done === rows.length) return "completed";
  return done > 0 ? "partial" : "missed";
}

/* ---------------------------------------------------------------------
   buildDashboard — raw collections in, the frozen contract out.
   ------------------------------------------------------------------ */
export function buildDashboard(state, at = now()) {
  const { pet, medications = [], logs: allLogs = [], caretakers = [],
          vaccinations = [], weights = [], trash = [], memories = [] } = state;

  /* A trashed care log is never actually removed from the store — the
     careLogs collection this mirrors stays exactly as append-only as it
     always was (see the `selfUndo()`/trash comments in firestore.rules).
     A `trash` marker just means every app-facing view should treat that
     one log as gone. Filtering it out here, in the single place every
     downstream view (timeline, counts, calendar) reads logs from, is
     the whole implementation — restoring a record is simply removing
     its marker, and nothing else has to know the Bin exists. */
  const trashedIds = new Set(trash.map((t) => t.originalId));
  const logs = allLogs.filter((l) => !trashedIds.has(l.id));

  const dayKey    = todayKey();
  const logsToday = logs
    .filter((l) => l.dayKey === dayKey)
    .sort((a, b) => toDate(a.at) - toDate(b.at));

  /* one row per medication per scheduled slot — the flattening that lets
     the UI render the panel as a flat list with no nested loops */
  const medRows = [];
  for (const med of medications) {
    if (med.active === false) continue;
    /* startDate/endDate are optional — a medication saved before this
       field existed has neither, and simply has no date restriction at
       all, exactly as it always behaved. */
    if (med.startDate && med.startDate > dayKey) continue;
    if (med.endDate && med.endDate < dayKey) continue;
    for (const slot of med.scheduledTimes || []) {
      const st = statusFor(med, slot, logsToday, at);
      medRows.push({
        kind:         "medication",
        medicationId: med.id,
        name:         med.name,
        dosage:       med.dosage,
        type:         med.type || "",
        feedingRelation: med.feedingRelation || "",
        instructions: med.instructions,
        slot,
        status:       st.state,
        minutes:      st.minutes,
        due:          st.due || null,
        loggedBy:     st.loggedBy || null,
        loggedAt:     st.loggedAt || null
      });
    }
  }
  medRows.sort((a, b) => a.slot.localeCompare(b.slot));

  /* one row per configured feeding time — purely additive: it does not
     change `counts.feeding` / `targets.feeding` below, so the existing
     ring, KPI and streak math is untouched. It is what lets the
     dashboard and calendar show *which* feeding is done, not just how
     many. */
  const feedingSlots = feedingTimes(pet);
  const feedingLogBySlot = matchFeedingSlots(feedingSlots, logsToday);
  const feedingRows = feedingSlots.map((slot) => {
    const st = slotStatus(feedingLogBySlot.get(slot) || null, slot, at);
    return {
      kind:     "feeding",
      slot,
      status:   st.state,
      minutes:  st.minutes,
      due:      st.due || null,
      loggedBy: st.loggedBy || null,
      loggedAt: st.loggedAt || null
    };
  }).sort((a, b) => a.slot.localeCompare(b.slot));

  const walkSlots = ["07:00", "18:00"].slice(0, Math.max(0, pet?.dailyTargets?.walk ?? 2));
  const walkCount = logsToday.filter((l) => l.type === "walk").length;
  const walkRows = walkSlots.map((slot, i) => {
    if (i < walkCount) return { kind: "walk", slot, status: "COMPLETED" };
    const st = slotStatus(null, slot, at);
    return { kind: "walk", slot, status: st.state, minutes: st.minutes, due: st.due || null };
  });

  const counts = {
    feeding:    logsToday.filter((l) => l.type === "feeding").length,
    walk:       logsToday.filter((l) => l.type === "walk").length,
    medication: medRows.filter((r) => r.status === "COMPLETED").length
  };

  const targets = {
    feeding:    pet?.dailyTargets?.feeding ?? 3,
    walk:       pet?.dailyTargets?.walk ?? 2,
    medication: medRows.length
  };

  /* Over-feeding warning — driven entirely by THIS pet's own configured
     schedule (targets.feeding above, which is itself never a hard-coded
     "3" — see feedingTimes()/dailyTargets), never a global rule. True the
     moment today's feeding count runs past however many feedings this
     pet is actually scheduled for. Nothing is persisted, so it resets on
     its own at the next local day: `counts`/`logsToday` are recomputed
     from today's dayKey on every render. */
  const overFeeding   = counts.feeding > targets.feeding;
  const overFeedingBy = Math.max(0, counts.feeding - targets.feeding);

  /* Looks across ALL available logs, not just today's — a pet that had
     its last walk yesterday evening must still show "Yesterday at 7:30 PM"
     the next morning instead of "not yet", which is exactly what a
     today-only search would produce the moment the calendar day rolls
     over. `logs` already excludes nothing the store handed us (demo mode
     keeps everything; live mode's listener is the existing 8-day window),
     so this is a strictly better answer with no new read. */
  const lastDone = {};
  for (const type of TASK_TYPES) {
    const last = logs
      .filter((l) => l.type === type)
      .sort((a, b) => toDate(b.at) - toDate(a.at))[0];
    lastDone[type] = last ? toDate(last.at) : null;
  }

  /* the next dose the owner should care about: the earliest thing that is
     overdue, then due, then upcoming */
  const rank = { OVERDUE: 0, DUE_NOW: 1, UPCOMING: 2, COMPLETED: 3 };
  const nextMedication =
    [...medRows].sort((a, b) => rank[a.status] - rank[b.status] || a.slot.localeCompare(b.slot))[0] || null;

  return {
    pet,
    today: { dayKey, counts, targets, overFeeding, overFeedingBy },
    lastDone,
    timeline: logsToday.map((l) => ({
      id:          l.id,
      type:        l.type,
      at:          toDate(l.at),
      performedBy: l.performedBy,
      role:        l.performedByRole,
      notes:       l.notes || "",
      medicationId: l.medicationId || null,
      slot:        l.slot || null
    })),
    medications: medRows,
    feedingSchedule: {
      times: feedingSlots,
      notes: pet?.feedingSchedule?.notes || "",
      rows: feedingRows
    },
    nextMedication,
    /* Bin contents — newest deletion first. `permanent` markers are
       excluded: they exist only so the log stays hidden from the main
       app forever (see the filter above), they never come back to a
       list the person can act on again. */
    trash: [...trash]
      .filter((t) => !t.permanent)
      .sort((a, b) => toDate(b.deletedAt) - toDate(a.deletedAt)),
    /* Memories — newest milestone first. `date` is the milestone's own
       date (a first birthday photographed and added weeks later still
       sorts by when it happened); `createdAt` breaks ties for same-day
       entries. */
    memories: [...memories].sort((a, b) =>
      String(b.date).localeCompare(String(a.date)) || toDate(b.createdAt) - toDate(a.createdAt)),
    caretaker: caretakers.find((c) => c.status === "active") || caretakers[0] || null,
    caretakers: [...caretakers].sort(byStatusThenName),
    health: buildHealth(vaccinations, weights, at),
    streak: computeStreak(state, at),
    /* Reminders (this alert strip) always come from the pet's OWN
       configured schedule — feedingRows above is built from
       feedingTimes(pet), never a hard-coded "3 times a day" — and are
       recomputed from scratch on every render, so editing a schedule can
       never leave a stale/duplicate reminder behind. */
    alerts: {
      overdue: [...medRows, ...feedingRows, ...walkRows].filter((r) => r.status === "OVERDUE"),
      dueNow:  [...medRows, ...feedingRows, ...walkRows].filter((r) => r.status === "DUE_NOW")
    }
  };
}

const byStatusThenName = (a, b) =>
  (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) ||
  String(a.name || "").localeCompare(String(b.name || ""));

/* ---------------------------------------------------------------------
   Health: vaccinations and weight.
   Vaccination status reuses the same idea as medication status — derive
   it from a date and today, never store it — so there is one mental model
   in the whole app instead of two.
   ------------------------------------------------------------------ */
export const VACCINE_SOON_DAYS = 30;

export function vaccinationStatus(vac, at = now()) {
  if (!vac?.nextDueOn) return { state: "UNKNOWN", days: null };
  const today = todayKeyAt(at);
  const days  = daysBetween(today, vac.nextDueOn);

  if (days < 0)                    return { state: "OVERDUE",  days: Math.abs(days) };
  if (days <= VACCINE_SOON_DAYS)   return { state: "DUE_SOON", days };
  return { state: "UP_TO_DATE", days };
}

function buildHealth(vaccinations, weights, at) {
  const vacs = vaccinations
    .map((v) => ({ ...v, ...vaccinationStatus(v, at) }))
    .sort((a, b) => String(a.nextDueOn).localeCompare(String(b.nextDueOn)));

  const readings = [...weights]
    .map((w) => ({ ...w, at: toDate(w.at) }))
    .sort((a, b) => a.at - b.at);

  const latest = readings[readings.length - 1] || null;
  const prev   = readings[readings.length - 2] || null;
  const change = latest && prev ? round1(latest.valueKg - prev.valueKg) : null;

  /* flag a change big enough to mention to a vet — 5% between readings */
  const pctChange = latest && prev ? ((latest.valueKg - prev.valueKg) / prev.valueKg) * 100 : 0;

  return {
    vaccinations: vacs,
    nextVaccination: vacs.find((v) => v.state !== "UP_TO_DATE") || vacs[0] || null,
    overdueVaccinations: vacs.filter((v) => v.state === "OVERDUE"),
    weights: readings,
    latestWeight: latest,
    weightChange: change,
    weightAlert: Math.abs(pctChange) >= 5
      ? { direction: pctChange > 0 ? "up" : "down", pct: Math.abs(round1(pctChange)) }
      : null
  };
}

/* ---------------------------------------------------------------------
   Medication adherence streak: consecutive days, counting back from the
   most recent complete day, where every scheduled dose was logged.
   Today only breaks the streak once its own doses are actually overdue,
   so a morning check-in doesn't wrongly show "0 days".
   ------------------------------------------------------------------ */
export function computeStreak(state, at = now()) {
  const slots = (state.medications || [])
    .filter((m) => m.active !== false)
    .flatMap((m) => (m.scheduledTimes || []).map((s) => `${m.id}@${s}`));

  if (!slots.length) return { days: 0, perfectToday: false, slotsPerDay: 0 };

  const loggedOn = (dayKey) => {
    const set = new Set(
      (state.logs || [])
        .filter((l) => l.dayKey === dayKey && l.type === "medication" && l.medicationId)
        .map((l) => `${l.medicationId}@${l.slot}`)
    );
    return slots.every((s) => set.has(s));
  };

  const todayComplete = loggedOn(todayKeyAt(at));
  let days = todayComplete ? 1 : 0;

  for (let back = 1; back <= 365; back++) {
    if (!loggedOn(dayKeyOffset(-back, at))) break;
    days++;
  }

  return { days, perfectToday: todayComplete, slotsPerDay: slots.length };
}

/* ------------------------------------------------------------------ */
const todayKeyAt = (at) => dayKeyIST(at);
const round1 = (n) => Math.round(n * 10) / 10;

/** Whole days from dayKey a to dayKey b, both "YYYY-MM-DD". */
export function daysBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/* ---------------------------------------------------------------------
   KPIs — computed from real logs, not asserted on a slide.
   ------------------------------------------------------------------ */
export function computeKpis(state, at = now()) {
  const dash = buildDashboard(state, at);
  const { counts, targets } = dash.today;

  const scheduled = targets.feeding + targets.walk + targets.medication;
  const completed = Math.min(counts.feeding, targets.feeding)
                  + Math.min(counts.walk, targets.walk)
                  + counts.medication;

  const medDone   = dash.medications.filter((r) => r.status === "COMPLETED");
  const medOnTime = medDone.filter((r) => {
    if (!r.loggedAt) return false;
    const due = istTimeToday(r.slot, at);
    return (r.loggedAt - due) / 60_000 <= GRACE_MINUTES;
  });

  const todayLogs   = state.logs.filter((l) => l.dayKey === dash.today.dayKey);
  const byCaretaker = todayLogs.filter((l) => l.performedByRole === "caretaker");

  return {
    completionRate:   pct(completed, scheduled),
    medicationAdherence: pct(medOnTime.length, targets.medication),
    missedTasks:      dash.alerts.overdue.length + Math.max(0, targets.feeding - counts.feeding)
                                                 + Math.max(0, targets.walk - counts.walk),
    caretakerShare:   pct(byCaretaker.length, todayLogs.length),
    totalLogsToday:   todayLogs.length,
    history:          weeklyHistory(state, at)
  };
}

/** Seven-day completion rate for the KPI chart. */
export function weeklyHistory(state, at = now()) {
  const out = [];
  const medSlotCount = (state.medications || [])
    .filter((m) => m.active !== false)
    .reduce((n, m) => n + (m.scheduledTimes || []).length, 0);
  const target = (state.pet?.dailyTargets?.feeding ?? 3)
               + (state.pet?.dailyTargets?.walk ?? 2)
               + medSlotCount;

  for (let d = -6; d <= 0; d++) {
    const key  = dayKeyOffset(d, at);
    const logs = state.logs.filter((l) => l.dayKey === key);
    out.push({ dayKey: key, rate: pct(logs.length, target), logs: logs.length });
  }
  return out;
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);

/* ---------------------------------------------------------------------
   Store facade — picks the live Firestore store or the demo store.
   The two modules expose the identical interface:
       store.mode                'live' | 'demo'
       store.subscribe(cb)       cb({ pet, medications, logs, caretakers, vets })
       store.logCare(entry)      Promise
       store.reseed()            Promise
   ------------------------------------------------------------------ */
export async function createStore(petId, session) {
  if (isFirebaseConfigured()) {
    try {
      const mod = await import("./store-firebase.js");
      return await mod.create(petId);
    } catch (err) {
      console.warn("[PetCare] Firebase unavailable, falling back to demo store.", err);
    }
  }
  const mod = await import("./store-mock.js");
  return await mod.create(petId, session);
}
