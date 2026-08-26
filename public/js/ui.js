/* =====================================================================
   ui.js — tiny DOM helpers. No framework, no dependencies.
   ===================================================================== */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const setText = (sel, text) => { const n = $(sel); if (n) n.textContent = text; };

/** Escape anything that came from data before putting it in innerHTML. */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

export function toast(message, kind = "") {
  const wrap = $("#toasts");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s ease";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 320);
  }, 2600);
}

/** Same visual family as toast() above, but with one action button and a
    countdown — "Feeding recorded • Undo (8s)". Reusable for any accidental,
    reversible one-tap action, not just feeding: pass the message, the
    button label, what to run if it's pressed, and how long the window
    stays open. Returns a `cancel()` the caller can invoke to dismiss the
    toast early without treating it as "the user pressed the button" (e.g.
    if the underlying record is removed for some other reason first). */
export function showActionToast(message, actionLabel, onAction, { seconds = 8 } = {}) {
  const wrap = $("#toasts");
  if (!wrap) { onAction?.(); return { cancel() {} }; }

  const el = document.createElement("div");
  el.className = "toast toast-action";
  let remaining = seconds;
  let done = false;
  let timer = null;

  const msgEl = document.createElement("span");
  msgEl.className = "toast-msg";
  msgEl.textContent = message;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-undo";
  const setLabel = () => { btn.textContent = `${actionLabel} (${remaining}s)`; };
  setLabel();

  el.append(msgEl, btn);
  wrap.appendChild(el);

  const dismiss = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    el.style.transition = "opacity .25s ease";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 260);
  };

  timer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) { dismiss(); return; }
    setLabel();
  }, 1000);

  btn.addEventListener("click", () => {
    if (done) return;
    dismiss();
    onAction?.();
  });

  return { cancel: dismiss };
}

export function openModal(id) {
  const m = document.getElementById(id);
  if (m) { m.hidden = false; document.body.style.overflow = "hidden"; }
}

export function closeModal(id) {
  const m = document.getElementById(id);
  if (m) { m.hidden = true; document.body.style.overflow = ""; }
}

export function closeAllModals() {
  $$(".modal").forEach((m) => { m.hidden = true; });
  document.body.style.overflow = "";
}

export const STATUS_LABEL = {
  UPCOMING:  "Upcoming",
  DUE_NOW:   "Due now",
  OVERDUE:   "Overdue",
  COMPLETED: "Completed",
  MISSED:    "Missed"          // a past day's slot with nothing logged — the calendar's word for it
};

export const STATUS_PILL = {
  UPCOMING:  "p-up",
  DUE_NOW:   "p-due",
  OVERDUE:   "p-over",
  COMPLETED: "p-done",
  MISSED:    "p-over"
};
