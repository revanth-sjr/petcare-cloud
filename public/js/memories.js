/* =====================================================================
   memories.js — a pet's Memories gallery: photos and milestones.
   ---------------------------------------------------------------------
   Any member can add a memory (a caretaker photographing a first walk
   shouldn't need the owner present to capture it) — mirrored by
   firestore.rules on /pets/{petId}/memories/{memoryId}. Editing or
   deleting one is scoped to whoever created it, or the pet's owner, the
   same split weights already use, so a caretaker cannot silently rewrite
   someone else's memory.

   Photos are stored as the same downscaled data-URL wirePhotoPicker
   already produces for a pet's own profile photo — this project has no
   Firebase Storage configured, and nothing here changes that. A memory
   with no photo is still a valid memory: a title, a date and a caption
   are enough to record a milestone.
   ===================================================================== */

import { $, esc, toast, openModal, closeModal } from "./ui.js";
import { fmtDate, todayKey } from "./time.js";
import { wirePhotoPicker } from "./pets-ui.js";

let ctx = null;       // { memories(), session(), addMemory, updateMemory, deleteMemory, repaint }
let photo = null;
let editingId = null; // null = add mode

export function init(context) {
  ctx = context;
  photo = wirePhotoPicker({
    input: $("#memPhoto"),
    preview: $("#memPhotoPreview"),
    clearBtn: $("#memPhotoClear"),
    onChange: (_, err) => { if (err) toast(err, "err"); }
  });
  wire();
}

export function render(dash) {
  const grid  = $("#memoryGallery");
  const empty = $("#memoryEmpty");
  if (!grid) return;

  const items = dash.memories || [];
  grid.innerHTML = "";
  if (!items.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const m of items) grid.appendChild(card(m));
}

function card(m) {
  const session = ctx.session();
  const canManage = session.role === "owner" || m.createdByUid === session.uid;

  const el = document.createElement("article");
  el.className = "memory-card";
  el.innerHTML = `
    <div class="memory-photo"${m.photoURL ? ` style="background-image:url(${esc(m.photoURL)})"` : ""}>${m.photoURL ? "" : "🐾"}</div>
    <div class="memory-body">
      <span class="memory-date">${esc(fmtDate(parseDate(m.date)))}</span>
      <h3 class="memory-title">${esc(m.title)}</h3>
      ${m.description ? `<p class="memory-desc">${esc(m.description)}</p>` : ""}
      <p class="memory-by">Added by ${esc(m.createdBy || "—")}</p>
    </div>`;

  if (canManage) {
    const actions = document.createElement("div");
    actions.className = "memory-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.type = "button";
    editBtn.title = "Edit this memory";
    editBtn.setAttribute("aria-label", "Edit this memory");
    editBtn.innerHTML = '<img src="https://img.icons8.com/ios-filled/50/pencil.png" alt="Edit" class="ui-icon-sm">';
    editBtn.addEventListener("click", () => openForm(m));

    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-crit-ghost btn-sm";
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      if (delBtn.dataset.armed === "1") {
        deleteMemory(m);
      } else {
        delBtn.dataset.armed = "1";
        delBtn.textContent = "Confirm?";
        setTimeout(() => { delBtn.dataset.armed = ""; delBtn.textContent = "Delete"; }, 3000);
      }
    });

    actions.append(editBtn, delBtn);
    el.appendChild(actions);
  }
  return el;
}

async function deleteMemory(m) {
  try {
    await ctx.deleteMemory(m.id);
    toast("Memory deleted", "ok");
    ctx.repaint();
  } catch (err) {
    toast(err.message || "Could not delete that memory.", "err");
  }
}

/* ------------------------------------------------------------------ */
function openForm(memory) {
  editingId = memory?.id || null;
  $("#memoryFormTitle").textContent = editingId ? "Edit memory" : "Add memory";
  $("#memTitle").value = memory?.title || "";
  $("#memDate").value = memory?.date || todayKey();
  $("#memDescription").value = memory?.description || "";
  photo.set(memory?.photoURL || "");
  hideFormError();
  openModal("memoryFormModal");
}

function wire() {
  $("#btnAddMemory").addEventListener("click", () => openForm(null));

  $("#memoryForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#memTitle").value.trim();
    const date  = $("#memDate").value;
    if (!title) return showFormError("Give this memory a title.");
    if (!date) return showFormError("Pick a date for this memory.");

    const payload = {
      title,
      date,
      description: $("#memDescription").value.trim(),
      photoURL: photo.get()
    };

    const btn = $("#memoryFormSubmit");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const session = ctx.session();
      if (editingId) {
        await ctx.updateMemory(editingId, payload);
        toast("Memory updated", "ok");
      } else {
        await ctx.addMemory({
          ...payload,
          createdBy: session.name,
          createdByRole: session.role,
          createdByUid: session.uid
        });
        toast("Memory added", "ok");
      }
      closeModal("memoryFormModal");
      ctx.repaint();
    } catch (err) {
      showFormError(err.message || "Could not save that memory.");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

function showFormError(msg) {
  const el = $("#memoryFormError");
  el.textContent = msg;
  el.hidden = false;
}
function hideFormError() { $("#memoryFormError").hidden = true; }

/* `date` is stored as a plain "YYYY-MM-DD" dayKey string, like every
   other date field in this app. Built via Date.UTC (never the browser's
   local timezone, per time.js's own rule) so it always round-trips
   through fmtDate()'s IST-anchored formatter as the same calendar day —
   the same technique calendar.js's fmtDayLabel()/weekdayLong() use. */
function parseDate(dayKey) {
  const [y, m, d] = String(dayKey).split("-").map(Number);
  return y && m && d ? new Date(Date.UTC(y, m - 1, d)) : new Date();
}
