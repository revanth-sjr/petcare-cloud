/* =====================================================================
   vets.js — the veterinary directory and the emergency escalation.
   Pod C owns this file.
   ---------------------------------------------------------------------
   Sample data, deliberately. A real clinic directory via Google Places is
   on the roadmap; on stage, five seeded clinics with distances read
   identically and cost none of the day.
   ===================================================================== */

import { $, esc, openModal } from "./ui.js";

let VETS = [];

export function setVets(list) { VETS = list || []; }
export function getVets() { return VETS; }

/**
 * @param {"emergency"|"general"|null} filter
 * @param {string} note  message shown above the list
 * @param {boolean} urgent  render the note as an emergency banner
 */
export function showVets(filter = null, note = "", urgent = false) {
  const list = $("#vetList");
  const noteEl = $("#vetModalNote");

  let rows = [...VETS];
  if (filter === "emergency") rows = rows.filter((v) => v.emergency24x7);
  if (filter === "general")   rows = rows.filter((v) => !v.emergency24x7);
  if (!rows.length) rows = [...VETS];

  /* emergency hospitals first, then by distance */
  rows.sort((a, b) =>
    (b.emergency24x7 === true) - (a.emergency24x7 === true) ||
    (a.distanceKm ?? 99) - (b.distanceKm ?? 99));

  $("#vetModalTitle").textContent = filter === "emergency"
    ? "Emergency veterinary hospitals"
    : "Nearby veterinary care";

  noteEl.textContent = note || "";
  noteEl.hidden = !note;
  noteEl.className = `modal-note${urgent ? " is-emergency" : ""}`;

  list.innerHTML = "";
  for (const v of rows) list.appendChild(vetItem(v));

  openModal("vetModal");
}

function vetItem(v) {
  const li = document.createElement("li");
  li.className = `vet-item${v.emergency24x7 ? " is-emergency" : ""}`;
  li.innerHTML = `
    <div>
      <h4>${v.emergency24x7 ? "🏥" : "🐾"} ${esc(v.name)}</h4>
      <p class="vet-meta">${esc(v.location)} · ${esc(String(v.distanceKm ?? "—"))} km · ${esc(v.hours || "")}</p>
      <div class="vet-tags">
        ${v.emergency24x7 ? `<span class="pill p-over">24/7 emergency</span>` : `<span class="pill p-up">By appointment</span>`}
        ${v.specialty ? `<span class="pill">${esc(v.specialty)}</span>` : ""}
      </div>
    </div>
    <a class="btn ${v.emergency24x7 ? "btn-crit" : "btn-primary"} btn-sm"
       href="tel:${esc((v.phone || "").replace(/\s/g, ""))}">📞 Call</a>`;
  return li;
}
