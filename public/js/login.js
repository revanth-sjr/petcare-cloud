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
  wireOtpForm();

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

function wireOtpForm() {
  $("#otpForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("#otpCodeInput")?.value?.trim() || "";

    if (!code || code.length !== 6) {
      return showError("#otpError", "Please enter the complete 6-digit OTP code received in your Gmail inbox.");
    }

    await busy("#btnVerifyOtp", "Verifying OTP…", async () => {
      const verified = await auth.verifyOtp(code);
      if (verified) {
        toast("OTP verified successfully!", "ok");
        await finish();
      } else {
        showError("#otpError", "Incorrect OTP code. Please check your Gmail inbox and enter the 6-digit code.");
      }
    }, "#otpError");
  });

  $("#btnResendOtp")?.addEventListener("click", async () => {
    const btn = $("#btnResendOtp");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending…";
    $("#otpError").hidden = true;
    try {
      await auth.resendVerificationEmail();
      toast("A new 6-digit OTP code has been sent to your Gmail inbox!", "ok");
    } catch (err) {
      showError("#otpError", err.message || "Could not resend OTP email.");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  $("#btnBackToLogin")?.addEventListener("click", async () => {
    try { await auth.signOut(); } catch { /* ignore */ }
    $("#otpForm").hidden = true;
    $$(".auth-tabs").forEach(e => e.hidden = false);
    const activeTab = $$(".auth-tabs button").find(b => b.classList.contains("is-on"))?.dataset?.tab || "login";
    $("#loginForm").hidden = activeTab !== "login";
    $("#signupForm").hidden = activeTab !== "signup";
    hideErrors();
  });
}

function showOtpSection(email) {
  $$(".auth-tabs").forEach(e => e.hidden = true);
  $("#loginForm").hidden = true;
  $("#signupForm").hidden = true;

  $("#otpForm").hidden = false;
  $("#otpEmailTarget").textContent = email || "your Gmail address";
  if ($("#otpCodeInput")) $("#otpCodeInput").value = "";
  $("#otpError").hidden = true;

  toast(`6-digit OTP sent to ${email}. Check your Gmail inbox & Spam folder!`, "ok");
  setTimeout(() => $("#otpCodeInput")?.focus(), 80);
}

/* ------------------------------------------------------------------
   Where next depends on whether this account has a pet yet — not on a
   flag, on the actual count, so it can never go stale. */
async function finish() {
  const session = auth.current();
  if (auth.mode === "live" && session && session.otpVerified !== true) {
    showOtpSection(session.email);
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
