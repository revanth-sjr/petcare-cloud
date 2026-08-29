/* =====================================================================
   export.js — care log CSV and the printable caretaker handoff.
   Pod B owns this file.
   ---------------------------------------------------------------------
   Nothing is deleted at midnight. The checklist resets; the record does
   not — which is exactly what makes the export worth having.
   ===================================================================== */

import { esc, toast, STATUS_LABEL } from "./ui.js";
import { fmtClock, fmtDate, toDate, toIsoIST, dayKeyIST, now } from "./time.js";
import { TASK_META } from "./data.js";

/* ------------------------------------------------------------------
   CSV — full history, not just today
   ------------------------------------------------------------------ */
export function exportCsv(state, dash) {
  const medById = (id) => state.medications.find((m) => m.id === id) || null;

  const rows = [...state.logs]
    .sort((a, b) => toDate(a.at) - toDate(b.at))
    .map((l) => {
      const med = l.medicationId ? medById(l.medicationId) : null;
      return [
        l.dayKey,
        fmtClock(l.at),
        TASK_META[l.type]?.label || l.type,
        med?.name || "",
        med?.type || "",
        med?.dosage || "",
        l.slot || "",
        l.performedBy || "",
        l.performedByRole || "",
        l.notes || "",
        toIsoIST(l.at)
      ];
    });

  const header = ["Date", "Time", "Task", "Medication", "Medication type", "Dosage", "Scheduled slot",
                  "Performed by", "Role", "Notes", "Timestamp (IST)"];

  const csv = [header, ...rows]
    .map((r) => r.map(csvCell).join(","))
    .join("\r\n");

  const pet = (dash.pet?.name || "pet").toLowerCase();
  download(`petcare-log-${pet}-${dayKeyIST(now())}.csv`,
           "﻿" + csv, "text/csv;charset=utf-8");
  toast(`Exported ${rows.length} care records`, "ok");
}

/* ------------------------------------------------------------------
   Plain-text export — a simple, readable line-per-entry log meant to be
   copy/pasted into a message to a vet or pet sitter, not a "reporting
   system": no charts, no tables, just what happened and when. Complements
   exportCsv() (a spreadsheet-friendly full dump) and exportHandoff() (a
   printable today-only care plan) — this is the third, deliberately
   simplest option, for someone who just wants to read or forward it.
   ------------------------------------------------------------------ */
export function exportTxt(state, dash) {
  const pet = dash.pet || {};
  const medById = (id) => state.medications.find((m) => m.id === id) || null;

  const sorted = [...state.logs].sort((a, b) => toDate(a.at) - toDate(b.at));
  const byDay = new Map();
  for (const l of sorted) {
    if (!byDay.has(l.dayKey)) byDay.set(l.dayKey, []);
    byDay.get(l.dayKey).push(l);
  }

  const lines = [];
  lines.push(`${pet.name || "Pet"} — Care Log Export`);
  if (pet.breed || pet.species) lines.push(`${pet.breed || pet.species}`);
  lines.push(`Generated ${fmtDate(now())} at ${fmtClock(now())} IST`);
  lines.push("=".repeat(48));
  lines.push("");

  if (!sorted.length) {
    lines.push("No care activity logged yet.");
  } else {
    for (const [, dayLogs] of byDay) {
      lines.push(fmtDate(dayLogs[0].at));
      for (const l of dayLogs) {
        const action = TASK_META[l.type]?.label || l.type;
        const med = l.medicationId ? medById(l.medicationId) : null;
        const medPart = med ? ` (${[med.name, med.dosage].filter(Boolean).join(", ")})` : "";
        const who = l.performedBy
          ? `${l.performedBy}${l.performedByRole ? ` (${l.performedByRole})` : ""}`
          : "unknown";
        let line = `  ${fmtClock(l.at)}  ${action}${medPart} — by ${who}`;
        if (l.notes) line += `  [Notes: ${l.notes}]`;
        lines.push(line);
      }
      lines.push("");
    }
  }

  lines.push("-".repeat(48));
  lines.push("Nothing is deleted when the daily checklist resets at midnight —");
  lines.push("this export reflects this pet's complete recorded care history.");

  const petSlug = (pet.name || "pet").toLowerCase();
  download(`petcare-log-${petSlug}-${dayKeyIST(now())}.txt`,
           lines.join("\r\n"), "text/plain;charset=utf-8");
  toast(`Exported ${sorted.length} care record${sorted.length === 1 ? "" : "s"} as text`, "ok");
}

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------
   Caretaker handoff — opens a print-ready page.
   window.print() gives a PDF through the browser's own dialog: no
   library, no server, about forty minutes of work total.
   ------------------------------------------------------------------ */
export function exportHandoff(dash) {
  const pet = dash.pet || {};
  const si  = pet.specialInstructions || {};
  const { counts, targets } = dash.today;

  const box = (done) => (done ? "☑" : "☐");
  const taskRows = [
    ["🍖 Feeding", counts.feeding, targets.feeding],
    ["🚶 Walk",    counts.walk,    targets.walk]
  ].map(([label, done, total]) => `
      <tr>
        <td>${label}</td>
        <td class="slots">${Array.from({ length: total }, (_, i) => box(i < done)).join(" ")}</td>
        <td class="count">${done} of ${total}</td>
      </tr>`).join("");

  const medRows = dash.medications.map((m) => `
      <tr>
        <td>💊 ${esc(m.name)} <span class="dim">${esc(m.dosage)}</span></td>
        <td class="slots">${box(m.status === "COMPLETED")} ${esc(m.slot)}</td>
        <td class="count ${m.status === "OVERDUE" ? "bad" : m.status === "COMPLETED" ? "good" : ""}">
          ${STATUS_LABEL[m.status]}${m.loggedBy ? ` · ${esc(m.loggedBy)}` : ""}
        </td>
      </tr>`).join("");

  const timelineRows = dash.timeline.map((t) => `
      <tr>
        <td class="mono">${esc(fmtClock(t.at))}</td>
        <td>${TASK_META[t.type]?.icon || ""} ${esc(TASK_META[t.type]?.label || t.type)}</td>
        <td>${esc(t.performedBy || "")}</td>
        <td class="dim">${esc(t.notes || "")}</td>
      </tr>`).join("") || `<tr><td colspan="4" class="dim">Nothing logged yet today.</td></tr>`;

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(pet.name || "Pet")} — Care Plan ${esc(fmtDate(now()))}</title>
<style>
  *{box-sizing:border-box}
  body{font:14px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif;color:#16211E;
       max-width:720px;margin:32px auto;padding:0 28px}
  h1{font-size:24px;margin:0 0 2px;letter-spacing:-.02em}
  .sub{color:#5B6C67;margin:0 0 22px;font-size:13px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#7B8D87;
     margin:26px 0 8px;border-bottom:1px solid #DFE7E4;padding-bottom:5px}
  table{width:100%;border-collapse:collapse}
  td{padding:7px 0;border-bottom:1px solid #EDF2F0;vertical-align:top}
  .slots{font-size:16px;letter-spacing:2px;white-space:nowrap;width:130px}
  .count{text-align:right;font-size:12.5px;color:#5B6C67;white-space:nowrap}
  .count.good{color:#2B7A54;font-weight:600}
  .count.bad{color:#AF382F;font-weight:600}
  .dim{color:#7B8D87}
  .mono{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;width:80px}
  .instr{background:#FBEEE0;border-left:3px solid #B4692A;padding:12px 15px;border-radius:0 6px 6px 0}
  .instr p{margin:0 0 6px}.instr p:last-child{margin:0}
  .vet{background:#E1F0EE;border-left:3px solid #14706B;padding:12px 15px;border-radius:0 6px 6px 0}
  .foot{margin-top:30px;font-size:11px;color:#9AABA5;border-top:1px solid #DFE7E4;padding-top:10px}
  @media print{body{margin:0;padding:16px}.noprint{display:none}}
  .noprint{margin:22px 0 0;display:flex;gap:8px}
  button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #C6D4CF;
         background:#fff;cursor:pointer}
  button.pri{background:#14706B;color:#fff;border-color:#14706B}
</style></head><body>
  <h1>🐾 ${esc(pet.name || "Pet")} — Today's Care Plan</h1>
  <p class="sub">${esc(fmtDate(now()))} · ${esc(pet.breed || "")}${pet.ageYears ? `, ${pet.ageYears} years` : ""}
     · prepared by ${esc(pet.ownerName || "owner")}</p>

  <h2>Daily tasks</h2>
  <table>${taskRows}</table>

  <h2>Medication</h2>
  <table>${medRows || `<tr><td class="dim">No active medications.</td></tr>`}</table>

  <h2>Special instructions</h2>
  <div class="instr">
    ${si.allergy    ? `<p><b>Food allergy:</b> ${esc(si.allergy)}</p>` : ""}
    ${si.medication ? `<p><b>Medication:</b> ${esc(si.medication)}</p>` : ""}
    ${si.notes      ? `<p><b>Notes:</b> ${esc(si.notes)}</p>` : ""}
    ${!si.allergy && !si.medication && !si.notes ? `<p class="dim">None recorded.</p>` : ""}
  </div>

  <h2>Veterinarian</h2>
  <div class="vet">
    <p><b>${esc(pet.vet?.name || "—")}</b><br>${esc(pet.vet?.phone || "")}</p>
    ${pet.vet?.emergencyPhone ? `<p><b>Emergency:</b> ${esc(pet.vet.emergencyPhone)}</p>` : ""}
  </div>

  <h2>Logged so far today</h2>
  <table>${timelineRows}</table>

  <p class="foot">Generated by PetCare · ${esc(fmtDate(now()))} at ${esc(fmtClock(now()))} IST<br>
     Nothing is deleted at midnight — the full care history is available as a CSV export.</p>

  <div class="noprint">
    <button class="pri" onclick="window.print()">Print / Save as PDF</button>
    <button onclick="window.close()">Close</button>
  </div>
</body></html>`;

  const w = window.open("", "_blank", "width=760,height=900");
  if (!w) { toast("Allow pop-ups to open the care plan", "err"); return; }
  w.document.write(html);
  w.document.close();
  toast("Care plan ready — print or save as PDF", "ok");
}
