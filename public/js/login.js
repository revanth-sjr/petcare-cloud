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
      if ($("#loginOtpGroup")) $("#loginOtpGroup").hidden = true;
      if ($("#suOtpGroup")) $("#suOtpGroup").hidden = true;
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

let loginCurrentOtp = "";
let signupCurrentOtp = "";

/* ------------------------------------------------------------------ */
function wireLogin() {
  $("#btnSendLoginOtp")?.addEventListener("click", async () => {
    const creds = {
      email:    $("#loginEmail").value,
      password: $("#loginPassword").value
    };
    const problem = validateLogin(creds);
    if (problem) return showError("#loginError", problem);

    const btn = $("#btnSendLoginOtp");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending OTP…";
    hideErrors();
    try {
      const otpCode = await auth.sendOtpForEmail(creds.email);
      loginCurrentOtp = otpCode;
      $("#loginOtpGroup").hidden = false;
      if ($("#loginOtpStatus")) {
        $("#loginOtpStatus").innerHTML = `
          <p style="margin:0 0 4px 0;font-size:0.9rem;font-weight:700;">🔐 Your 6-Digit OTP Code is: <b style="font-size:1.3rem;color:var(--accent-strong,#10b981);letter-spacing:4px;font-family:monospace;">${otpCode}</b></p>
          <p style="margin:0;font-size:0.8rem;color:var(--text-muted);">Enter the 6-digit numeric code <b>${otpCode}</b> below or click Auto-Fill:</p>
        `;
      }
      toast(`Your 6-digit OTP code is ${otpCode}!`, "ok");
      setTimeout(() => $("#loginOtpCode")?.focus(), 80);
    } catch (err) {
      showError("#loginError", err.message || "Could not send OTP email.");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  $("#btnFillLoginOtp")?.addEventListener("click", () => {
    if (loginCurrentOtp) {
      $("#loginOtpCode").value = loginCurrentOtp;
      toast(`Auto-filled 6-digit OTP: ${loginCurrentOtp}`, "ok");
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

    if (!creds.otpCode || creds.otpCode.length !== 6 || !/^[0-9]{6}$/.test(creds.otpCode)) {
      return showError("#loginError", "Enter the 6-digit numeric OTP code (e.g. " + (loginCurrentOtp || "392328") + "). Do not enter hex letters.");
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
    const details = {
      firstName:  $("#suFirstName").value,
      middleName: $("#suMiddleName").value,
      lastName:   $("#suLastName").value,
      email:      $("#suEmail").value,
      password:   $("#suPassword").value
    };
    const problem = validateSignup(details);
    if (problem) return showError("#signupError", problem);

    const btn = $("#btnSendSignupOtp");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending OTP…";
    hideErrors();
    try {
      const otpCode = await auth.sendOtpForEmail(details.email, details.firstName);
      signupCurrentOtp = otpCode;
      $("#suOtpGroup").hidden = false;
      if ($("#suOtpStatus")) {
        $("#suOtpStatus").innerHTML = `
          <p style="margin:0 0 4px 0;font-size:0.9rem;font-weight:700;">🔐 Your 6-Digit OTP Code is: <b style="font-size:1.3rem;color:var(--accent-strong,#10b981);letter-spacing:4px;font-family:monospace;">${otpCode}</b></p>
          <p style="margin:0;font-size:0.8rem;color:var(--text-muted);">Enter the 6-digit numeric code <b>${otpCode}</b> below or click Auto-Fill:</p>
        `;
      }
      toast(`Your 6-digit OTP code is ${otpCode}!`, "ok");
      setTimeout(() => $("#suOtpCode")?.focus(), 80);
    } catch (err) {
      showError("#signupError", err.message || "Could not send OTP email.");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  $("#btnFillSignupOtp")?.addEventListener("click", () => {
    if (signupCurrentOtp) {
      $("#suOtpCode").value = signupCurrentOtp;
      toast(`Auto-filled 6-digit OTP: ${signupCurrentOtp}`, "ok");
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

    if (!details.otpCode || details.otpCode.length !== 6 || !/^[0-9]{6}$/.test(details.otpCode)) {
      return showError("#signupError", "Enter the 6-digit numeric OTP code (e.g. " + (signupCurrentOtp || "392328") + "). Do not enter hex letters.");
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
  const session = auth.current();
  if (auth.mode === "live" && session && session.otpVerified !== true) {
    if ($("#loginEmail")) $("#loginEmail").value = session.email || "";
    if ($("#loginOtpGroup")) $("#loginOtpGroup").hidden = false;
    showError("#loginError", "Please click 'Verify Email & Send OTP' and enter your 6-digit OTP code to complete login.");
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
