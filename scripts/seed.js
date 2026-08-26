#!/usr/bin/env node
/* =====================================================================
   scripts/seed.js — writes the demo data into Cloud Firestore.
   Pod A owns this file.
   ---------------------------------------------------------------------
   Reads the same public/data/seed.json the demo store uses, so the live
   app and the offline demo show identical data.

   Auth (either one):
     · put serviceAccount.json in the project root  (it is gitignored), or
     · export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json

   Usage:
     node scripts/seed.js            # add today's data, keep history
     node scripts/seed.js --reset    # wipe careLogs first, then reseed
   ===================================================================== */

const fs   = require("node:fs");
const path = require("node:path");
const admin = require("firebase-admin");

const ROOT = path.join(__dirname, "..");
const SEED = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/seed.json"), "utf8"));
const TZ   = "Asia/Kolkata";
const RESET = process.argv.includes("--reset");

/* ---------------- auth ---------------- */
const keyPath = path.join(ROOT, "serviceAccount.json");
if (fs.existsSync(keyPath)) {
  admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
} else {
  console.error(
    "\n  No credentials found.\n" +
    "  Firebase console → Project settings → Service accounts → Generate new private key,\n" +
    "  save it as serviceAccount.json in the project root, then run this again.\n"
  );
  process.exit(1);
}

const db     = admin.firestore();
const petRef = db.collection("pets").doc(SEED.pet.id);

/* ---------------- IST helpers (same rules as public/js/time.js) ------ */
const dayKeyIST = (d) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

function tzOffsetMinutes(date) {
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const loc = new Date(date.toLocaleString("en-US", { timeZone: TZ }));
  return (loc - utc) / 60000;
}

function istTimeOn(dayOffset, hhmm) {
  const base = new Date(Date.now() + dayOffset * 86400000);
  const [h, m] = hhmm.split(":").map(Number);
  const [Y, M, D] = dayKeyIST(base).split("-").map(Number);
  return new Date(Date.UTC(Y, M - 1, D, h, m, 0) - tzOffsetMinutes(base) * 60000);
}

/* ---------------- run ---------------- */
(async () => {
  const project = process.env.GOOGLE_CLOUD_PROJECT
    || (fs.existsSync(keyPath) && require(keyPath).project_id)
    || "(default credentials)";
  console.log(`\n  Seeding project "${project}"…\n`);

  if (RESET) {
    const snap = await petRef.collection("careLogs").get();
    let n = 0;
    for (const chunk of chunks(snap.docs, 400)) {
      const batch = db.batch();
      chunk.forEach((d) => { batch.delete(d.ref); n++; });
      await batch.commit();
    }
    console.log(`  · cleared ${n} existing care logs`);
  }

  /* demo auth accounts — so the login page has something to log into */
  const uids = {};
  for (const a of SEED.demoAccounts) {
    try {
      const existing = await admin.auth().getUserByEmail(a.email);
      await admin.auth().updateUser(existing.uid, { password: a.password, displayName: a.name });
      uids[a.role] = existing.uid;
      console.log(`  · account (updated): ${a.email}`);
    } catch (err) {
      if (err.code !== "auth/user-not-found") throw err;
      const created = await admin.auth().createUser({
        email: a.email, password: a.password, displayName: a.name, emailVerified: true
      });
      uids[a.role] = created.uid;
      console.log(`  · account (created): ${a.email}`);
    }
    await db.collection("users").doc(uids[a.role]).set({
      name: a.name, email: a.email, petId: SEED.pet.id, role: a.role
    }, { merge: true });
  }

  /* pet — owned by the demo owner, with the caretaker already a member */
  const { id, ...petData } = SEED.pet;
  await petRef.set({
    ...petData,
    ownerUid: uids.owner,
    memberUids: [uids.owner, uids.caretaker].filter(Boolean)
  }, { merge: true });
  await db.collection("joinCodes").doc(SEED.pet.joinCode).set({
    petId: SEED.pet.id, ownerUid: uids.owner
  });
  console.log(`  · pet: ${SEED.pet.name}  (care code ${SEED.pet.joinCode})`);

  /* medications */
  for (const med of SEED.medications) {
    const { id: mid, ...data } = med;
    await petRef.collection("medications").doc(mid).set(data);
  }
  console.log(`  · medications: ${SEED.medications.length}`);

  /* caretakers */
  for (const ct of SEED.caretakers) {
    const { id: cid, ...data } = ct;
    const uid = uids[ct.role] || null;
    await petRef.collection("caretakers").doc(uid || cid).set({ ...data, uid });
  }
  console.log(`  · caretakers: ${SEED.caretakers.length}`);

  /* vets — top level, shared */
  for (const v of SEED.vets) {
    const { id: vid, ...data } = v;
    await db.collection("vets").doc(vid).set(data);
  }
  console.log(`  · vets: ${SEED.vets.length}`);

  /* vaccinations */
  for (const v of (SEED.vaccinations || [])) {
    const { id: vid, ...data } = v;
    await petRef.collection("vaccinations").doc(vid).set(data);
  }
  console.log(`  · vaccinations: ${(SEED.vaccinations || []).length}`);

  /* weight history */
  for (const [i, w] of (SEED.weightHistory || []).entries()) {
    const at = new Date(Date.now() + w.dayOffset * 86400000);
    await petRef.collection("weights").doc(`wt-${String(i).padStart(2, "0")}`).set({
      valueKg: w.valueKg,
      notes: w.notes || "",
      recordedBy: w.recordedBy,
      at: admin.firestore.Timestamp.fromDate(at),
      dayKey: dayKeyIST(at)
    });
  }
  console.log(`  · weight readings: ${(SEED.weightHistory || []).length}`);

  Object.assign(SEED_UIDS, uids);

  /* today's activity — deterministic ids so re-running does not duplicate */
  let logs = 0;
  for (const l of SEED.todayLogs) {
    const at = istTimeOn(0, l.time);
    await putLog(`today-${l.type}-${l.time}`, {
      type: l.type,
      medicationId: l.medicationId ?? null,
      slot: l.slot ?? null,
      notes: l.notes ?? "",
      performedBy: l.performedBy,
      performedByRole: l.role,
      at, dayKey: dayKeyIST(at)
    });
    logs++;
  }

  /* six days of history for the KPI chart and the export */
  for (const day of SEED.historyPlan) {
    const feeds = ["08:00", "13:00", "19:30"].slice(0, day.feeding);
    const walks = ["07:00", "18:00"].slice(0, day.walk);

    for (const t of feeds)          { await histLog(day.dayOffset, "feeding", t); logs++; }
    for (const t of walks)          { await histLog(day.dayOffset, "walk", t); logs++; }
    for (const s of day.medSlots)   {
      await histLog(day.dayOffset, "medication", s, s === "09:00" ? "med-joint" : "med-amox");
      logs++;
    }
  }
  console.log(`  · care logs: ${logs}`);

  console.log(`
  Done. Sign in at your app URL with either demo account:

     owner@petcare.demo / petcare123   (Revanth — can manage the care team)
     arun@petcare.demo  / petcare123   (Arun — caretaker)

  Care code for new caretakers: ${SEED.pet.joinCode}
`);
  process.exit(0);
})().catch((err) => {
  console.error("\n  Seed failed:", err.message, "\n");
  process.exit(1);
});

/* ---------------- helpers ---------------- */
async function putLog(docId, data) {
  await petRef.collection("careLogs").doc(docId).set({
    ...data,
    performedByUid: SEED_UIDS[data.performedByRole] || null,
    at: admin.firestore.Timestamp.fromDate(data.at)
  });
}

/* filled in once the demo accounts exist, so seeded logs carry the same
   performedByUid the security rules require of live writes */
const SEED_UIDS = {};

async function histLog(dayOffset, type, time, medicationId = null) {
  const at = istTimeOn(dayOffset, time);
  const byCaretaker = time === "13:00" || time === "18:00";
  await putLog(`hist-${dayKeyIST(at)}-${type}-${time}`, {
    type,
    medicationId,
    slot: medicationId ? time : null,
    notes: "",
    performedBy:     byCaretaker ? "Arun" : "Revanth",
    performedByRole: byCaretaker ? "caretaker" : "owner",
    at, dayKey: dayKeyIST(at)
  });
}

function* chunks(arr, size) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}
