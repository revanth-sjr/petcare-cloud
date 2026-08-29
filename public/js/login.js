/* =====================================================================
   login.js — the signup / login page.
   Pod A owns this file.
   ===================================================================== */

import { $, $$, toast, esc } from "./ui.js";
import {
  initAuth, validateSignup, validateLogin, authMessage, normaliseCode
} from "./auth.js";

let auth = null;
let signupPath = "owner";     // 'owner' | 'join'

boot();

async function boot() {
  auth = await initAuth();

  $("#authMode").innerHTML = auth.mode === "live"
    ? `<span class="mode-badge" data-mode="live"><i class="dot"></i>Firebase Authentication</span>`
    : `<span class="mode-badge" data-mode="demo"><i class="dot"></i>Demo accounts — stored in this browser</span>`;

  $("#authNote").textContent = auth.mode === "live"
    ? "Your password is handled by Firebase Authentication and never reaches this app."
    : "";
  $("#authNote").hidden = auth.mode !== "live";

  /* already signed in? send them wherever they left off */
  const existing = await auth.ready;
  if (existing) return finish();

  wireTabs();
  wireLogin();
  wireSignup();
}

/* ------------------------------------------------------------------ */
function wireTabs() {
  $$(".auth-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      $$(".auth-tabs button").forEach((b) => b.classList.toggle("is-on", b === btn));
      $("#loginForm").hidden  = tab !== "login";
      $("#signupForm").hidden = tab !== "signup";
      hideErrors();
    });
  });

  $$(".seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      signupPath = btn.dataset.path;
      $$(".seg button").forEach((b) => b.classList.toggle("is-on", b === btn));
      $("#ownerFields").hidden = signupPath !== "owner";
      $("#joinFields").hidden  = signupPath !== "join";
      $("#signupSubmit").textContent =
        signupPath === "owner" ? "Create account" : "Create account & join";
      hideErrors();
    });
  });
}

/* ------------------------------------------------------------------ */
function wireLogin() {
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const creds = {
      email:    $("#loginEmail").value,
      password: $("#loginPassword").value
    };
    const problem = validateLogin(creds);
    if (problem) return showError("#loginError", problem);

    await busy("#loginSubmit", "Logging in…", async () => {
      await auth.signIn(creds);
      await finish();
    }, "#loginError");
  });


}

/* ------------------------------------------------------------------ */
function wireSignup() {
  $("#signupForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const details = {
      firstName:  $("#suFirstName").value,
      middleName: $("#suMiddleName").value,
      lastName:   $("#suLastName").value,
      email:      $("#suEmail").value,
      password:   $("#suPassword").value
    };
    const problem = validateSignup(details);
    if (problem) return showError("#signupError", problem);

    const code = normaliseCode($("#suJoinCode").value);

    if (signupPath === "join" && !code) return showError("#signupError", "Enter the care code the owner gave you.");

    await busy("#signupSubmit", "Creating account…", async () => {
      /* the account may already exist from a half-finished attempt */
      let session = auth.current();
      if (!session || session.email !== details.email.trim().toLowerCase()) {
        session = await auth.signUp(details);
      }

      if (signupPath === "join") {
        await auth.joinWithCode(code);
      }
      /* owner path: no pet yet — finish() sends them to onboarding */
      await finish();
    }, "#signupError");
  });
}

/* ------------------------------------------------------------------
   Where next depends on whether this account has a pet yet — not on a
   flag, on the actual count, so it can never go stale. */
async function finish() {
  let hasPet = false;
  try { hasPet = (await auth.myPets()).length > 0; } catch { /* fail open to onboarding */ }
  window.location.replace(hasPet ? "./home.html" : "./onboarding.html?mode=first");
}

async function busy(sel, label, run, errorSel) {
  const btn = $(sel);
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  hideErrors();
  try {
    await run();
  } catch (err) {
    console.warn(err);
    showError(errorSel, authMessage(err));
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function showError(sel, message) {
  const el = $(sel);
  if (!el) return toast(message, "err");
  el.textContent = message;
  el.hidden = false;
}

const hideErrors = () => $$(".auth-error").forEach((e) => { e.hidden = true; });
