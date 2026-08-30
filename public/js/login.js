/* =====================================================================
   login.js — the signup / login page.
   Pod A owns this file.
   ===================================================================== */

import { $, $$, toast, esc } from "./ui.js";
import {
  initAuth, validateSignup, validateLogin, authMessage, normaliseCode
} from "./auth.js";
import { initTheme } from "./theme.js";

let auth = null;
let signupPath = "owner";     // 'owner' | 'join'

boot();

async function boot() {
  initTheme();
  auth = await initAuth();

  $("#authMode").innerHTML = `<span class="mode-badge" data-mode="live"><i class="dot"></i>Firebase Authentication</span>`;
  $("#authNote").textContent = "Your password is handled by Firebase Authentication and never reaches this app.";
  $("#authNote").hidden = false;

  wireTabs();
  wireLogin();
  wireSignup();
  wireVerifyModal();

  /* already signed in? send them wherever they left off */
  const existing = await auth.ready;
  if (existing) return finish();
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
      $("#signupSubmit").textContent =
        signupPath === "owner" ? "Create account" : "Create caretaker account";
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

    await busy("#signupSubmit", "Creating account…", async () => {
      let session = auth.current();
      if (!session || session.email !== details.email.trim().toLowerCase()) {
        session = await auth.signUp(details);
      }
      await finish();
    }, "#signupError");
  });
}

function wireVerifyModal() {
  $("#btnCheckVerify")?.addEventListener("click", async () => {
    const btn = $("#btnCheckVerify");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Checking…";
    $("#verifyError").hidden = true;
    try {
      const verified = await auth.checkEmailVerification();
      if (verified) {
        toast("Email verified successfully!", "ok");
        closeAllModals();
        await finish();
      } else {
        showError("#verifyError", "Email not verified yet. Please check your inbox and click the link.");
      }
    } catch (err) {
      showError("#verifyError", err.message || "Could not check verification status.");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  $("#btnResendVerify")?.addEventListener("click", async () => {
    const btn = $("#btnResendVerify");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending…";
    $("#verifyError").hidden = true;
    try {
      await auth.resendVerificationEmail();
      toast("Verification email resent!", "ok");
    } catch (err) {
      showError("#verifyError", err.message || "Could not resend verification email.");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  $("#btnSignOutVerify")?.addEventListener("click", async () => {
    await auth.signOut();
    closeAllModals();
    location.reload();
  });
}

function showVerifyModal(email) {
  $("#verifyEmailAddr").textContent = email || "your email";
  openModal("verifyEmailModal");
}

/* ------------------------------------------------------------------
   Where next depends on whether this account has a pet yet — not on a
   flag, on the actual count, so it can never go stale. */
async function finish() {
  const session = auth.current();
  if (auth.mode === "live" && session && session.emailVerified === false) {
    showVerifyModal(session.email);
    return;
  }

  let hasPet = false;
  try { hasPet = (await auth.myPets()).length > 0; } catch { /* fail open to onboarding */ }
  if (hasPet || signupPath === "join") {
    window.location.replace("./home.html");
  } else {
    window.location.replace("./onboarding.html?mode=first");
  }
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
