/* =====================================================================
   config.js — the only file you edit to go live.
   Pod A owns this.
   ---------------------------------------------------------------------
   Until firebaseConfig.apiKey is filled in, the app runs in DEMO MODE:
   an in-memory store seeded with the same data as scripts/seed.js.
   Everything works — logging, timeline, status, AI fallback, export —
   it just doesn't persist or sync between browsers.
   ===================================================================== */

// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCyIqrrW99hs380lO3cdRhK90tstCbMDGA",
  authDomain: "petcare-cloud-cts.firebaseapp.com",
  projectId: "petcare-cloud-cts",
  storageBucket: "petcare-cloud-cts.firebasestorage.app",
  messagingSenderId: "382963240353",
  appId: "1:382963240353:web:c772532f180730039c8fe0"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

/* The seeded demo pet's id. Real accounts hold as many pets as they like —
   see auth.myPets() — this is only the id scripts/seed.js writes to and
   the id store-mock.js falls back to for the two built-in demo accounts. */
export const PET_ID = "buddy";

/* Cloud Function URL. Get it from the output of `firebase deploy --only functions`.
   Leave it empty to run the rule-based responder client-side (Spark-plan mode). */
export const AI_ENDPOINT = "";

/* How long after a scheduled dose before it counts as OVERDUE. */
export const GRACE_MINUTES = 60;

/* How long the "Feeding recorded • Undo" toast (and its equivalents for
   walk/medication) stays live after a one-click log. One number drives
   both the client's countdown and the server-side self-delete window in
   firestore.rules, so they can never drift apart. Keep this between 5 and
   10 seconds — long enough to catch a mistouch, short enough that it never
   reads as "did that actually save?" */
export const UNDO_WINDOW_SECONDS = 8;

/* Everything is bucketed by this timezone. Do not read the browser's zone —
   a judge's laptop may be on a different one than the demo assumes. */
export const TZ = "Asia/Kolkata";

export const isFirebaseConfigured = () =>
  typeof firebaseConfig.apiKey === "string" &&
  firebaseConfig.apiKey.length > 0 &&
  !firebaseConfig.apiKey.startsWith("PASTE_");

export const isAiConfigured = () => AI_ENDPOINT.length > 0;
