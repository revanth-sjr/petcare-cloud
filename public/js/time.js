/* =====================================================================
   time.js — every date decision in the app goes through this file.
   Pod A owns this.
   ---------------------------------------------------------------------
   WHY THIS EXISTS: Cloud Functions and most servers run in UTC. The demo
   runs in IST. Without one shared helper, "today's checklist" and the
   midnight reset are wrong by 5.5 hours and you find out at 9pm.
   Rule for the whole team: never call new Date().getDate() anywhere else.
   ===================================================================== */

import { TZ } from "./config.js";

/* --- dev time-shift -------------------------------------------------
   The demo panel offsets "now" so you can show DUE and OVERDUE on stage
   without waiting for 8pm. Always read the clock through now().        */
let _offsetMs = 0;

export const setTimeOffsetMs    = (ms) => { _offsetMs = ms; };
export const setTimeOffsetHours = (h)  => { _offsetMs = h * 3600_000; };
export const getTimeOffsetMs    = ()   => _offsetMs;
export const getTimeOffsetHours = ()   => _offsetMs / 3600_000;

/** The app clock. Always read time through this, never Date.now(). */
export const now = () => new Date(Date.now() + _offsetMs);

/** The real wall clock, ignoring any demo shift. */
export const realNow = () => new Date();

/* --- IST-anchored day bucket ---------------------------------------- */

const dtfDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
});

/** "2026-08-25" for the given instant, in IST. This is the dayKey. */
export function dayKeyIST(date = now()) {
  return dtfDay.format(date);            // en-CA formats as YYYY-MM-DD
}

/** Today's dayKey. */
export const todayKey = () => dayKeyIST(now());

/** dayKey N days before today, for the KPI history chart. */
export function dayKeyOffset(days, base = now()) {
  return dayKeyIST(new Date(base.getTime() + days * 86_400_000));
}

/** Minutes IST is ahead of UTC. Fixed +5:30, but derived so it stays honest. */
function tzOffsetMinutes(date) {
  const asUTC = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const asTZ  = new Date(date.toLocaleString("en-US", { timeZone: TZ }));
  return (asTZ - asUTC) / 60_000;
}

/**
 * Turn a slot string ("20:00") into a real Date for today in IST.
 * Used by statusFor to decide UPCOMING / DUE NOW / OVERDUE.
 */
export function istTimeToday(slot, base = now()) {
  const [h, m] = slot.split(":").map(Number);
  const key = dayKeyIST(base);
  const [Y, M, D] = key.split("-").map(Number);
  const utcMs = Date.UTC(Y, M - 1, D, h, m, 0, 0) - tzOffsetMinutes(base) * 60_000;
  return new Date(utcMs);
}

/* --- display helpers ------------------------------------------------ */

const dtfClock = new Intl.DateTimeFormat("en-IN", {
  timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: true
});

/** "08:00 AM" */
export const fmtClock = (date) => dtfClock.format(toDate(date)).toUpperCase();

/** "25 Aug 2026" */
export const fmtDate = (date) => new Intl.DateTimeFormat("en-IN", {
  timeZone: TZ, day: "2-digit", month: "short", year: "numeric"
}).format(toDate(date));

const dtfHour = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false });

/** "morning" / "afternoon" / "evening" for the Home page's "Good morning,
    {name}" welcome line — always read through IST (dtfHour above), never
    the browser's own timezone, same rule as every other clock decision
    in this file. */
export function dayPeriod(date = now()) {
  const hour = Number(dtfHour.format(toDate(date)));
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

/** "3 hours ago" / "just now" / "in 45 min" */
export function fmtRelative(date, from = now()) {
  if (!date) return "—";
  const diffMin = Math.round((from - toDate(date)) / 60_000);
  const ago = diffMin >= 0;
  const n = Math.abs(diffMin);
  let text;
  if (n < 1)        text = "just now";
  else if (n < 60)  text = `${n} min`;
  else if (n < 1440) {
    const h = Math.floor(n / 60);
    text = `${h} hour${h > 1 ? "s" : ""}`;
  } else {
    const d = Math.floor(n / 1440);
    text = `${d} day${d > 1 ? "s" : ""}`;
  }
  if (text === "just now") return text;
  return ago ? `${text} ago` : `in ${text}`;
}

/** "Last done" phrasing for the per-action indicators under each Log
    button: "3 hours ago", "25 minutes ago", "Yesterday at 7:30 PM" — the
    exact examples the feature was specced against. Kept separate from
    fmtRelative() above (used for KPIs/streaks elsewhere) so this display
    can spell out full words and switch to a clock time once the action
    was not today, without changing the shape other callers rely on.
    Anchored to dayKeyIST like every other date decision in this app, so
    "yesterday" means the IST calendar day, not a raw 24-hour window. */
export function fmtLastDone(date, from = now()) {
  if (!date) return null;
  const d = toDate(date);
  const diffMin = Math.round((from - d) / 60_000);
  if (diffMin < 1) return "just now";

  const dKey = dayKeyIST(d);
  const fromKey = dayKeyIST(from);
  if (dKey === fromKey) {
    if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
    const h = Math.floor(diffMin / 60);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }

  const yesterdayKey = dayKeyIST(new Date(from.getTime() - 86_400_000));
  if (dKey === yesterdayKey) return `Yesterday at ${fmtClock(d)}`;
  return `${fmtDate(d)} at ${fmtClock(d)}`;
}

/* --- pure calendar math for the feeding/medication calendar ---------
   These never read the clock and never touch a real time-of-day — a
   dayKey is just a "YYYY-MM-DD" label, so this is calendar arithmetic
   done in UTC as scratch space, the same trick daysBetween() in data.js
   already uses. Nothing here needs istTimeToday()'s timezone math. --- */
const pad2 = (n) => String(n).padStart(2, "0");
const dayKeyFromUTC = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};

/** Every dayKey from `startKey` to `endKey`, inclusive, ascending. */
export function dayKeyRange(startKey, endKey) {
  const [sy, sm, sd] = startKey.split("-").map(Number);
  const [ey, em, ed] = endKey.split("-").map(Number);
  const start = Date.UTC(sy, sm - 1, sd);
  const end   = Date.UTC(ey, em - 1, ed);
  const out = [];
  for (let t = start; t <= end; t += 86_400_000) out.push(dayKeyFromUTC(t));
  return out;
}

/** The Sunday-start 7-column grid of dayKeys needed to render `month`
    (1-12) of `year` as a calendar page — including the leading/trailing
    days borrowed from adjacent months to fill the first and last week. */
export function monthGridDayKeys(year, month) {
  const first = Date.UTC(year, month - 1, 1);
  const last  = Date.UTC(year, month, 0);              // day 0 of next month
  const gridStart = first - new Date(first).getUTCDay() * 86_400_000;
  const gridEnd   = last + (6 - new Date(last).getUTCDay()) * 86_400_000;
  return dayKeyRange(dayKeyFromUTC(gridStart), dayKeyFromUTC(gridEnd));
}

/** All 7 dayKeys (Sun..Sat) of the week containing `dayKey`. */
export function weekDayKeys(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const start = t - new Date(t).getUTCDay() * 86_400_000;
  return dayKeyRange(dayKeyFromUTC(start), dayKeyFromUTC(start + 6 * 86_400_000));
}

/** dayKey shifted by a whole number of days — crosses month/year
    boundaries cleanly. Used to page the calendar's week view. */
export function shiftDayKey(dayKey, days) {
  const [y, m, d] = dayKey.split("-").map(Number);
  return dayKeyFromUTC(Date.UTC(y, m - 1, d) + days * 86_400_000);
}

/** {year, month} shifted by whole calendar months — crosses year
    boundaries cleanly, e.g. shiftMonth(2026, 1, -1) → {year:2025, month:12}. */
export function shiftMonth(year, month, delta) {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 + 1 };
}

/** "January 2026" */
export function monthLabel(year, month) {
  return new Date(Date.UTC(year, month - 1, 1))
    .toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** {year, month, day} for a dayKey — handy for calendar cell labels. */
export function splitDayKey(dayKey) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return { year, month, day };
}

/** Accepts Date, ISO string, or a Firestore Timestamp. */
export function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v?.toDate === "function") return v.toDate();   // Firestore Timestamp
  return new Date(v);
}

/** ISO string with the IST offset, for CSV export. */
export function toIsoIST(v) {
  const d = toDate(v);
  if (!d) return "";
  const off = tzOffsetMinutes(d);
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
}
