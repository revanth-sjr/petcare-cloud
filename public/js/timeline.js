/* =====================================================================
   timeline.js — today's activity, newest last.
   Pod B owns this file.
   ---------------------------------------------------------------------
   Every row carries who did it. That single field is the whole caretaker
   story: the owner can see at a glance that Arun did the 10am walk.
   ===================================================================== */

import { $, esc } from "./ui.js";
import { fmtClock } from "./time.js";
import { TASK_META } from "./data.js";

export function render(dash, ctx) {
  const list  = $("#timeline");
  const empty = $("#timelineEmpty");
  list.innerHTML = "";

  if (!dash.timeline.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const medName = (id) =>
    dash.medications.find((m) => m.medicationId === id)?.name || "Medication";

  for (const item of dash.timeline) {
    const meta = TASK_META[item.type] || { label: item.type, icon: "•" };
    const title = item.type === "medication"
      ? `${meta.label} — ${medName(item.medicationId)}`
      : meta.label;

    const li = document.createElement("li");
    li.className = "tl-item";
    li.dataset.type = item.type;
    li.innerHTML = `
      <div class="tl-time">${esc(fmtClock(item.at))}</div>
      <div class="tl-dot">${meta.icon}</div>
      <div class="tl-body">
        <b>${esc(title)}</b>
        <p class="tl-by">Completed by <span class="who">${esc(item.performedBy || "—")}</span>
          <span class="role-chip ${item.role === "caretaker" ? "caretaker" : "owner"}">${esc(item.role || "owner")}</span>
        </p>
        ${item.notes ? `<p class="tl-notes">${esc(item.notes)}</p>` : ""}
      </div>`;

    /* Move to bin — never a hard delete from here. Any member can undo
       their own or someone else's mistaken entry; the Bin is where it's
       actually recoverable from, and the confirm step below is the same
       "are you sure" every other destructive-looking action in this app
       uses before touching a record at all. */
    if (ctx?.onTrash) {
      const trashBtn = document.createElement("button");
      trashBtn.className = "icon-btn tl-trash";
      trashBtn.type = "button";
      trashBtn.title = "Move to bin";
      trashBtn.setAttribute("aria-label", `Move this ${meta.label.toLowerCase()} entry to the bin`);
      trashBtn.innerHTML = '<img src="https://img.icons8.com/ios-filled/50/trash.png" alt="Bin" class="ui-icon">';
      trashBtn.addEventListener("click", () => ctx.onTrash(item));
      li.appendChild(trashBtn);
    }

    list.appendChild(li);
  }
}
