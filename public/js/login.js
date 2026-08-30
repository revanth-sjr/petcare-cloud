/* =====================================================================
   login.js — the signup / login page.
   Pod A owns this file.
   ===================================================================== */

import { $, $$, toast, esc, openModal, closeModal, closeAllModals } from "./ui.js";
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
  $("#btnSendLoginOtp")?.addEventListener("click", async () => {
    const email = $("#loginEmail").value.trim();
    if (!email || !email.includes("@")) return showError("#loginError", "Enter your email address first.");

    const btn = $("#btnSendLoginOtp");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending…";
    hideErrors();
    try {
      await auth.sendOtpForEmail(email);
      toast(`6-digit OTP code sent to ${email}! Check your Gmail inbox & Spam folder.`, "ok");
      setTimeout(() => $("#loginOtpCode")?.focus(), 80);
    } catch (err) {
      showError("#loginError", err.message || "Could not send OTP email.");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const creds = {
      email:    $("#loginEmail").value,
      password: $("#loginPassword").value,
      otpCode:  $("#loginOtpCode").value.trim()
    };
    const problem = validateLogin(creds);
    if (problem) return showError("#loginError", problem);

    if (!creds.otpCode || creds.otpCode.length !== 6) {
      return showError("#loginError", "Enter the 6-digit OTP code received in your Gmail inbox.");
    }

    await busy("#loginSubmit", "Logging in…", async () => {
      await auth.signInWithOtp(creds);
      await finish();
    }, "#loginError");
  });
}

/* ------------------------------------------------------------------ */
function wireSignup() {
  $("#btnSendSignupOtp")?.addEventListener("click", async () => {
    const email = $("#suEmail").value.trim();
    const firstName = $("#suFirstName").value.trim();
    if (!email || !email.includes("@")) return showError("#signupError", "Enter your email address first.");

    const btn = $("#btnSendSignupOtp");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending…";
    hideErrors();
    try {
      await auth.sendOtpForEmail(email, firstName);
      toast(`6-digit OTP code sent to ${email}! Check your Gmail inbox & Spam folder.`, "ok");
      setTimeout(() => $("#suOtpCode")?.focus(), 80);
    } catch (err) {
      showError("#signupError", err.message || "Could not send OTP email.");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  $("#signupForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const details = {
      firstName:  $("#suFirstName").value,
      middleName: $("#suMiddleName").value,
      lastName:   $("#suLastName").value,
      email:      $("#suEmail").value,
      password:   $("#suPassword").value,
      otpCode:    $("#suOtpCode").value.trim()
    };
    const problem = validateSignup(details);
    if (problem) return showError("#signupError", problem);

    if (!details.otpCode || details.otpCode.length !== 6) {
      return showError("#signupError", "Enter the 6-digit OTP code received in your Gmail inbox.");
    }

    await busy("#signupSubmit", "Creating account…", async () => {
      await auth.signUpWithOtp(details);
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
  if (hasPet || signupPath === "join") {
    window.location.replace("./home.html");
  } else {
    window.location.replace("./onboarding.html?mode=first");
  }
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
