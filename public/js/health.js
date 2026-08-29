/* =====================================================================
   health.js — weight trend and vaccination schedule.
   Pod B owns this file.
   ---------------------------------------------------------------------
   The project is a care log AND a health monitor. Feeding and walks are
   the daily half; this is the slow half — the numbers you only notice by
   keeping them.

   Vaccination status uses exactly the same idea as medication status:
   derived from a date and today, never stored. One mental model for the
   whole app.
   ===================================================================== */

import { $, esc, toast, openModal, closeAllModals } from "./ui.js";
import { fmtDate, toDate, todayKey, now } from "./time.js";
import { daysBetween } from "./data.js";

let ctx = null;

export function init(context) { ctx = context; wire(); }

const VAC_PILL = {
  UP_TO_DATE: "p-done",
  DUE_SOON:   "p-due",
  OVERDUE:    "p-over",
  UNKNOWN:    "p-up"
};
const VAC_LABEL = {
  UP_TO_DATE: "Up to date",
  DUE_SOON:   "Due soon",
  OVERDUE:    "Overdue",
  UNKNOWN:    "No date"
};

/* ------------------------------------------------------------------ */
export function render(dash, session) {
  renderWeight(dash);
  renderVaccinations(dash, session);
}

/* ---------------- weight ---------------- */
function renderWeight(dash) {
  const h = dash.health;
  const latest = h.latestWeight;

  $("#weightValue").textContent = latest ? `${latest.valueKg} kg` : "—";
  $("#weightWhen").textContent  = latest
    ? `${fmtDate(latest.at)} · by ${latest.recordedBy || "—"}`
    : "No readings yet";

  const delta = $("#weightDelta");
  if (h.weightChange === null || h.weightChange === undefined) {
    delta.hidden = true;
  } else {
    delta.hidden = false;
    const up = h.weightChange > 0;
    const flat = Math.abs(h.weightChange) < 0.05;
    delta.textContent = flat ? "no change" : `${up ? "▲" : "▼"} ${Math.abs(h.weightChange)} kg`;
    delta.className = `weight-delta ${flat ? "" : up ? "up" : "down"}`;
  }

  /* a 5% swing between readings is worth mentioning to a vet */
  const alert = $("#weightAlert");
  if (h.weightAlert) {
    alert.hidden = false;
    alert.textContent =
      `${h.weightAlert.pct}% ${h.weightAlert.direction === "up" ? "gain" : "loss"} since the previous reading — worth mentioning at the next vet visit.`;
  } else {
    alert.hidden = true;
  }

  $("#weightSpark").innerHTML = sparkline(h.weights);
  $("#weightCount").textContent = h.weights.length
    ? `${h.weights.length} readings over ${spanDays(h.weights)} days`
    : "";
}

/** Hand-drawn sparkline. No chart library for eight points. */
function sparkline(readings) {
  if (readings.length < 2) return "";
  const W = 260, H = 56, PAD = 4;
  const vals = readings.map((r) => r.valueKg);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;

  const pts = readings.map((r, i) => {
    const x = PAD + (i / (readings.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((r.valueKg - min) / range) * (H - PAD * 2);
    return [round(x), round(y)];
  });

  const line = pts.map((p) => p.join(",")).join(" ");
  const area = `${PAD},${H - PAD} ${line} ${round(W - PAD)},${H - PAD}`;
  const [lx, ly] = pts[pts.length - 1];

  return `
    <svg viewBox="0 0 ${W} ${H}" role="img"
         aria-label="Weight trend across ${readings.length} readings, from ${min} to ${max} kilograms">
      <polygon class="spark-area" points="${area}"></polygon>
      <polyline class="spark-line" points="${line}"></polyline>
      <circle class="spark-dot" cx="${lx}" cy="${ly}" r="3.5"></circle>
    </svg>
    <div class="spark-scale"><span>${min} kg</span><span>${max} kg</span></div>`;
}

const round = (n) => Math.round(n * 10) / 10;

function spanDays(readings) {
  const a = toDate(readings[0].at), b = toDate(readings[readings.length - 1].at);
  return Math.max(1, Math.round((b - a) / 86_400_000));
}

/* ---------------- vaccinations ---------------- */
function renderVaccinations(dash, session) {
  const list = $("#vacList");
  const isOwner = session?.role === "owner";
  list.innerHTML = "";

  const vacs = dash.health.vaccinations;
  if (!vacs.length) {
    list.innerHTML = `<p class="empty">No vaccination records yet.</p>`;
    return;
  }

  for (const v of vacs) {
    const li = document.createElement("li");
    li.className = `vac-item s-${v.state}`;

    const when = v.state === "OVERDUE"
      ? `${v.days} day${v.days === 1 ? "" : "s"} overdue`
      : v.state === "DUE_SOON"
        ? `due in ${v.days} day${v.days === 1 ? "" : "s"}`
        : `due ${fmtYmd(v.nextDueOn)}`;

    li.innerHTML = `
      <div class="vac-main">
        <b>${esc(v.name)}</b>
        <p>${esc(when)}${v.lastGivenOn ? ` · last given ${esc(fmtYmd(v.lastGivenOn))}` : ""}</p>
      </div>
      <span class="pill ${VAC_PILL[v.state]}">${VAC_LABEL[v.state]}</span>`;

    if (isOwner && v.state !== "UP_TO_DATE") {
      const btn = document.createElement("button");
      btn.className = "btn btn-ghost btn-sm";
      btn.textContent = "Record";
      btn.addEventListener("click", () => openRecord(v));
      li.appendChild(btn);
    }
    list.appendChild(li);
  }
}

const fmtYmd = (ymd) => {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN",
    { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
};

/* ------------------------------------------------------------------ */
function openRecord(vac) {
  $("#vacRecordName").textContent = vac.name;
  $("#vacGivenOn").value = todayKey();
  $("#vacNextDue").value = addDays(todayKey(), guessInterval(vac));
  $("#vacRecordSave").onclick = async () => {
    const givenOn   = $("#vacGivenOn").value;
    const nextDueOn = $("#vacNextDue").value;
    if (!givenOn || !nextDueOn) return toast("Both dates are needed", "err");
    if (daysBetween(givenOn, nextDueOn) <= 0) return toast("The next due date must be after the date given", "err");
    try {
      await ctx.store.markVaccinationGiven(vac.id, { givenOn, nextDueOn });
      closeAllModals();
      toast(`${vac.name} recorded`, "ok");
      ctx.repaint();
    } catch (err) { toast(err.message, "err"); }
  };
  openModal("vacModal");
}

/** Reuse the previous interval so the default date is usually right. */
function guessInterval(vac) {
  if (vac.lastGivenOn && vac.nextDueOn) {
    const d = daysBetween(vac.lastGivenOn, vac.nextDueOn);
    if (d > 0) return d;
  }
  return 365;
}

function addDays(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return t.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
function wire() {
  $("#btnLogWeight").addEventListener("click", () => {
    $("#weightForm").reset();
    $("#weightInput").value = ctx.latestWeight() ?? "";
    openModal("weightModal");
    setTimeout(() => $("#weightInput").select(), 60);
  });

  $("#weightForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const valueKg = Number($("#weightInput").value);
    if (!valueKg || valueKg <= 0 || valueKg > 150) {
      return toast("Enter a weight between 0 and 150 kg", "err");
    }
    try {
      await ctx.store.logWeight({
        valueKg,
        notes: $("#weightNotes").value.trim(),
        recordedBy: ctx.userName()
      });
      closeAllModals();
      toast(`Weight recorded: ${valueKg} kg`, "ok");
      ctx.repaint();
    } catch (err) { toast(err.message, "err"); }
  });
}
