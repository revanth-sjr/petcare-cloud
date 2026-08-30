/* =====================================================================
   caretakers.js — the care team panel.
   Pod B owns this file.
   ---------------------------------------------------------------------
   The owner adds, deactivates and removes caretakers. A caretaker sees
   the same roster read-only. Nothing here decides permissions — the
   Firestore rules do, and this UI just stops offering actions the rules
   would refuse.
   ===================================================================== */

import { $, $$, esc, toast, openModal, closeAllModals } from "./ui.js";
import { isEmail } from "./auth.js";

let ctx = null;

export function init(context) { ctx = context; wire(); }

/* ------------------------------------------------------------------ */
export function render(dash, session) {
  const isOwner = session?.role === "owner";
  const team    = dash.caretakers || [];

  /* the join code is how a caretaker links their own account */
  const codeBox = $("#joinCodeBox");
  if (dash.pet?.joinCode && isOwner) {
    codeBox.hidden = false;
    $("#joinCodeValue").textContent = dash.pet.joinCode;
  } else {
    codeBox.hidden = true;
  }

  if ($("#btnAddCaretaker")) $("#btnAddCaretaker").hidden = !isOwner;
  $("#ctReadonlyNote").hidden  = isOwner;

  const list = $("#caretakerList");
  list.innerHTML = "";

  if (!team.length) {
    list.innerHTML = `<p class="empty">${isOwner
      ? "No caretakers yet. Add whoever helps with Buddy and every log will show who did it."
      : "No other caretakers on this pet."}</p>`;
    return;
  }

  for (const ct of team) list.appendChild(row(ct, isOwner, session));
}

function row(ct, isOwner, session) {
  const li = document.createElement("li");
  const isMe = session && (ct.uid === session.uid || ct.email === session.email);
  li.className = `ct-item${ct.status !== "active" ? " is-paused" : ""}`;

  li.innerHTML = `
    <div class="ct-avatar">${esc((ct.name || "?").charAt(0).toUpperCase())}</div>
    <div class="ct-info">
      <b>${esc(ct.name || "Unnamed")}${isMe ? ' <span class="role-chip caretaker">you</span>' : ""}</b>
      <p>${esc(ct.email || "no email on file")}</p>
      ${ct.note ? `<p class="ct-note">${esc(ct.note)}</p>` : ""}
    </div>
    <div class="ct-actions">
      <span class="pill ${ct.status === "active" ? "p-done" : "p-up"}">${esc(ct.status || "unknown")}</span>
    </div>`;

  if (!isOwner) return li;

  const actions = li.querySelector(".ct-actions");

  const pause = document.createElement("button");
  pause.className = "icon-btn";
  pause.title = ct.status === "active" ? "Pause access" : "Reactivate";
  pause.textContent = ct.status === "active" ? "⏸" : "▶";
  pause.addEventListener("click", async () => {
    try {
      await ctx.store.updateCaretaker(ct.id, {
        status: ct.status === "active" ? "paused" : "active"
      });
      toast(ct.status === "active" ? `${ct.name} paused` : `${ct.name} reactivated`, "ok");
      ctx.repaint();
    } catch (err) { toast(err.message, "err"); }
  });

  const remove = document.createElement("button");
  remove.className = "icon-btn danger";
  remove.title = "Remove from the care team";
  remove.textContent = "🗑";
  remove.addEventListener("click", () => confirmRemove(ct));

  actions.append(pause, remove);
  return li;
}

/* ------------------------------------------------------------------
   Removal is destructive and revokes access, so it gets a confirm step
   that names the person and says what actually happens.
   ------------------------------------------------------------------ */
function confirmRemove(ct) {
  $("#removeName").textContent = ct.name || ct.email || "this caretaker";
  const btn = $("#removeConfirm");
  btn.onclick = async () => {
    try {
      await ctx.store.removeCaretaker(ct.id);
      closeAllModals();
      toast(`${ct.name} removed from the care team`, "ok");
      ctx.repaint();
    } catch (err) { toast(err.message, "err"); }
  };
  openModal("removeModal");
}

/* ------------------------------------------------------------------ */
function wire() {
  $("#btnAddCaretaker")?.addEventListener("click", () => {
    openModal("caretakerModal");
  });

  $("#btnCopyCode").addEventListener("click", async () => {
    const code = $("#joinCodeValue").textContent;
    try {
      await navigator.clipboard.writeText(code);
      toast("Care code copied", "ok");
    } catch {
      /* clipboard is blocked in some contexts — select it instead */
      const r = document.createRange();
      r.selectNodeContents($("#joinCodeValue"));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      toast("Press ⌘/Ctrl+C to copy");
    }
  });
}

function fail(message) {
  const el = $("#addCtError");
  el.textContent = message;
  el.hidden = false;
}
