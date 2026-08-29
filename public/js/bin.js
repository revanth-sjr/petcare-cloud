/* =====================================================================
   bin.js — the Bin: soft-deleted tracking/history records.
   ---------------------------------------------------------------------
   Nothing in this file ever deletes a careLogs document. Moving an
   entry here creates a `trash` marker (data.js already filters any log
   with a live marker out of the timeline, counts and calendar);
   restoring removes that marker; "Delete permanently" only flips the
   marker's own `permanent` flag so it drops out of this list — the
   underlying record stays forever, exactly like Stop vs Delete already
   does for medications, and for the same reason: the audit trail this
   app is built around is never actually erased.
   ===================================================================== */

import { $, esc, toast, openModal } from "./ui.js";
import { fmtClock, fmtDate, toDate } from "./time.js";
import { TASK_META } from "./data.js";

let ctx = null; // { trash: () => dash.trash, medName(id), restore(id), permanentlyDelete(id), repaint }

export function init(context) {
  ctx = context;
}

/** Opens the Bin for whichever pet's dashboard is currently open —
    called fresh every time, so a stale list from before a pet switch
    can never show. */
export function openManage() {
  render();
  openModal("binModal");
}

export function render(dash) {
  /* Called two ways: from app.js's repaint() (dash may not be open in
     the modal at all — harmless no-op refresh) and from openManage()
     right before showing the modal. Either way it always reads the
     latest dash.trash through ctx, never a snapshot passed in once. */
  const list = $("#binList");
  if (!list) return;
  const items = ctx.trash();
  $("#binCount").textContent = items.length ? String(items.length) : "";

  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = `<p class="med-manage-empty">Bin is empty. Deleted entries from the timeline show up here.</p>`;
    return;
  }
  for (const item of items) list.appendChild(row(item));
}

function row(item) {
  const li = document.createElement("li");
  li.className = "med-manage-item";

  const meta  = TASK_META[item.type] || { label: item.type, icon: "•" };
  const title = item.type === "medication" ? `${meta.label} — ${ctx.medName(item.medicationId)}` : meta.label;

  li.innerHTML = `
    <div class="med-manage-info">
      <b>${meta.icon} ${esc(title)}</b>
      <p>Logged by ${esc(item.performedBy || "—")} · ${esc(fmtClock(toDate(item.at)))} on ${esc(fmtDate(toDate(item.at)))}</p>
      <p>Deleted by ${esc(item.deletedBy || "—")} · ${esc(fmtClock(toDate(item.deletedAt)))} on ${esc(fmtDate(toDate(item.deletedAt)))}</p>
    </div>`;

  const actions = document.createElement("div");
  actions.className = "med-manage-actions";

  const restoreBtn = document.createElement("button");
  restoreBtn.className = "icon-btn";
  restoreBtn.title = "Restore to the timeline";
  restoreBtn.setAttribute("aria-label", "Restore to the timeline");
  restoreBtn.textContent = "↩";
  restoreBtn.addEventListener("click", async () => {
    try {
      await ctx.restore(item.id);
      toast("Restored to the timeline", "ok");
      render();
      ctx.repaint();
    } catch (err) {
      toast(err.message || "Could not restore that record.", "err");
    }
  });

  const delBtn = document.createElement("button");
  delBtn.className = "btn btn-crit-ghost";
  delBtn.textContent = "Delete permanently";
  delBtn.addEventListener("click", async () => {
    if (delBtn.dataset.armed === "1") {
      try {
        await ctx.permanentlyDelete(item.id);
        toast("Removed from the bin", "ok");
        render();
      } catch (err) {
        toast(err.message || "Could not delete that record.", "err");
      }
    } else {
      delBtn.dataset.armed = "1";
      delBtn.textContent = "Confirm?";
      setTimeout(() => { delBtn.dataset.armed = ""; delBtn.textContent = "Delete permanently"; }, 3000);
    }
  });

  actions.append(restoreBtn, delBtn);
  li.appendChild(actions);
  return li;
}
