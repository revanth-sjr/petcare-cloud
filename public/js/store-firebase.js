/* =====================================================================
   store-firebase.js — the live store.
   Pod A owns this file.
   ---------------------------------------------------------------------
   onSnapshot listeners are what make the owner/caretaker live-sync demo
   work: a write from one browser re-renders the other with no polling
   and no refresh.
   ===================================================================== */

import { firebaseConfig, PET_ID } from "./config.js";
import { dayKeyIST, now } from "./time.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.0";

export async function create(petId = PET_ID) {
  const [{ initializeApp, getApps }, fs, authMod] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-firestore.js`),
    import(`${SDK}/firebase-auth.js`)
  ]);

  const app  = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const db   = fs.getFirestore(app);
  const auth = authMod.getAuth(app);

  if (!auth.currentUser) throw new Error("Not signed in");

  const petRef = fs.doc(db, "pets", petId);
  const state = {
    pet: null, medications: [], logs: [],
    caretakers: [], vaccinations: [], weights: [], vets: [], trash: [], memories: []
  };
  const listeners = new Set();
  const emit = () => listeners.forEach((cb) => cb({
    ...state, logs: [...state.logs], trash: [...state.trash], memories: [...state.memories]
  }));

  /* vets are static — one read instead of an open listener */
  try {
    const vetSnap = await fs.getDocs(fs.collection(db, "vets"));
    state.vets = vetSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn("[PetCare] could not read the vet directory:", err);
  }

  const listen = (ref, key, opts) =>
    fs.onSnapshot(ref, (snap) => {
      state[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      emit();
    }, (err) => console.error(`[PetCare] ${key} listener failed:`, err));

  const unsubs = [
    fs.onSnapshot(petRef, (snap) => {
      state.pet = snap.exists() ? { id: snap.id, ...snap.data() } : null;
      emit();
    }),
    listen(fs.collection(petRef, "medications"), "medications"),
    listen(fs.collection(petRef, "caretakers"), "caretakers"),
    listen(fs.collection(petRef, "vaccinations"), "vaccinations"),
    listen(fs.query(fs.collection(petRef, "weights"), fs.orderBy("at", "asc")), "weights"),
    listen(fs.collection(petRef, "trash"), "trash"),
    listen(fs.collection(petRef, "memories"), "memories"),

    /* Last 8 days of care logs. Keeps the read count low and covers the
       KPI chart. Older history stays in Firestore for export — nothing is
       deleted at midnight. */
    fs.onSnapshot(
      fs.query(
        fs.collection(petRef, "careLogs"),
        fs.where("dayKey", ">=", dayKeyIST(new Date(Date.now() - 8 * 86_400_000))),
        fs.orderBy("dayKey", "asc")
      ),
      (snap) => { state.logs = snap.docs.map((d) => ({ id: d.id, ...d.data() })); emit(); },
      (err) => console.error("[PetCare] careLogs listener failed:", err)
    )
  ];

  return {
    mode: "live",
    modeLabel: "Live — Cloud Firestore",
    petId,

    subscribe(cb) {
      listeners.add(cb);
      if (state.pet) cb({ ...state, logs: [...state.logs] });
      return () => listeners.delete(cb);
    },

    /* ---------------- care logging ---------------- */
    async logCare(entry) {
      const at = now();
      const ref = await fs.addDoc(fs.collection(petRef, "careLogs"), {
        type:            entry.type,
        medicationId:    entry.medicationId ?? null,
        slot:            entry.slot ?? null,
        notes:           entry.notes ?? "",
        performedBy:     entry.performedBy,
        performedByRole: entry.performedByRole,
        performedByUid:  auth.currentUser.uid,
        at:              fs.Timestamp.fromDate(at),
        dayKey:          dayKeyIST(at)
      });
      /* no manual re-render: the open listener does it */
      return ref.id;
    },

    /** Undo — for the short "Feeding recorded • Undo" window right after
        logCare(). careLogs is append-only from the client for every OTHER
        path (`allow update, delete: if false` stays exactly that in
        firestore.rules); the one narrow exception is `selfUndo()`, which
        only lets the log's own creator delete it, and only within
        UNDO_WINDOW_SECONDS of `at` — enforced server-side, not just here.
        A stale attempt (timer already expired, or somehow a second
        device) simply gets a permission-denied from Firestore, which the
        caller treats as "too late, nothing to undo". */
    async undoLog(logId) {
      try {
        await fs.deleteDoc(fs.doc(petRef, "careLogs", logId));
        return true;
      } catch (err) {
        if (err?.code === "permission-denied") return false;
        throw err;
      }
    },

    /* ---------------- bin / trash ----------------
       Moving a record to the bin never touches the careLogs document —
       it stays exactly as append-only as `undoLog()`'s comment above
       describes. A trash doc is a full snapshot of the log plus who/when
       deleted it; data.js's buildDashboard() filters any log whose id
       has a live trash doc out of every app-facing view. Restoring
       deletes the marker; "delete permanently" only flips `permanent`
       (the one field firestore.rules allows updating on this
       collection) so the Bin itself stops listing it — the underlying
       careLog is never actually erased, preserving the audit trail. */
    async trashLog(logId, { deletedBy, deletedByRole } = {}) {
      const log = state.logs.find((l) => l.id === logId);
      if (!log) throw new Error("That record no longer exists.");
      if (state.trash.some((t) => t.originalId === logId)) return; // already in the bin
      await fs.addDoc(fs.collection(petRef, "trash"), {
        originalId: log.id,
        originalCollection: "careLogs",
        petId,
        type: log.type,
        medicationId: log.medicationId ?? null,
        slot: log.slot ?? null,
        notes: log.notes ?? "",
        performedBy: log.performedBy,
        performedByRole: log.performedByRole,
        at: log.at,
        dayKey: log.dayKey,
        deletedAt: fs.Timestamp.fromDate(now()),
        deletedBy: deletedBy || "",
        deletedByRole: deletedByRole || "",
        deletedByUid: auth.currentUser.uid,
        permanent: false
      });
    },

    async restoreLog(trashId) {
      await fs.deleteDoc(fs.doc(petRef, "trash", trashId));
    },

    async permanentlyDeleteLog(trashId) {
      await fs.updateDoc(fs.doc(petRef, "trash", trashId), { permanent: true });
    },

    /* ---------------- memories ----------------
       Rules mirror weights: any member can create one (createdByUid
       must be them), but only the creator or the pet's owner can update
       or delete it. Photos are the same downscaled data-URL
       wirePhotoPicker already produces for a pet's profile photo — no
       Firebase Storage required, and this never touches that project
       setting. */
    async addMemory({ title, description, date, photoURL, createdBy, createdByRole }) {
      const ref = await fs.addDoc(fs.collection(petRef, "memories"), {
        title: (title || "").trim(),
        description: (description || "").trim(),
        date: date || dayKeyIST(now()),
        photoURL: photoURL || "",
        createdBy: createdBy || "",
        createdByRole: createdByRole || "",
        createdByUid: auth.currentUser.uid,
        createdAt: fs.Timestamp.fromDate(now())
      });
      return ref.id;
    },

    async updateMemory(id, patch) {
      await fs.updateDoc(fs.doc(petRef, "memories", id), patch);
    },

    async deleteMemory(id) {
      await fs.deleteDoc(fs.doc(petRef, "memories", id));
    },

    /* ---------------- medications (owner only — rules enforce it) -----
       /pets/{petId}/medications/{medId} is `allow write: if isOwner()`
       in firestore.rules, unchanged by this feature — a caretaker can
       still view the schedule and log doses through logCare(), just not
       add, edit or remove the medication document itself. */
    async addMedication({ name, dosage, type, feedingRelation, frequency, scheduledTimes, startDate, endDate, instructions }) {
      const times = Array.isArray(scheduledTimes) && scheduledTimes.length
        ? [...scheduledTimes].sort() : ["09:00"];
      const ref = await fs.addDoc(fs.collection(petRef, "medications"), {
        name: (name || "").trim(),
        dosage: (dosage || "").trim(),
        /* type/feedingRelation are new, optional fields — a medication
           saved before they existed simply has "", exactly like a pet
           saved before specialInstructions/vet existed. Nothing here is
           hardcoded to any fixed medication list; these are just labels
           the owner picks per medication. */
        type: (type || "").trim(),
        feedingRelation: (feedingRelation || "").trim(),
        frequency: (frequency || "").trim(),
        scheduledTimes: times,
        startDate: startDate || "",
        endDate: endDate || "",
        instructions: (instructions || "").trim(),
        active: true
      });
      return ref.id;
    },

    async updateMedication(id, patch) {
      await fs.updateDoc(fs.doc(petRef, "medications", id), patch);
    },

    async deleteMedication(id) {
      await fs.deleteDoc(fs.doc(petRef, "medications", id));
    },

    /* ---------------- caretakers (owner only — rules enforce it) ------ */
    async addCaretaker({ name, email, note }) {
      const clean = (email || "").trim().toLowerCase();
      if (clean && state.caretakers.some((c) => c.email === clean)) {
        throw new Error(`${name || clean} is already on the care team.`);
      }
      await fs.addDoc(fs.collection(petRef, "caretakers"), {
        name: name.trim(),
        email: clean,
        note: (note || "").trim(),
        role: "caretaker",
        status: "active",
        uid: null,
        addedAt: fs.serverTimestamp()
      });
    },

    async updateCaretaker(id, patch) {
      await fs.updateDoc(fs.doc(petRef, "caretakers", id), patch);
    },

    /**
     * Removing a caretaker does two things: drops the roster entry and
     * revokes their access by pulling their uid out of memberUids. Doing
     * only the first would leave a "removed" person still able to write.
     */
    async removeCaretaker(id) {
      const ct = state.caretakers.find((c) => c.id === id);
      if (ct?.uid) {
        await fs.updateDoc(petRef, { memberUids: fs.arrayRemove(ct.uid) });
      }
      await fs.deleteDoc(fs.doc(petRef, "caretakers", id));
    },

    /* ---------------- health ---------------- */
    async logWeight({ valueKg, notes, recordedBy }) {
      const at = now();
      await fs.addDoc(fs.collection(petRef, "weights"), {
        valueKg: Number(valueKg),
        notes: notes || "",
        recordedBy,
        at: fs.Timestamp.fromDate(at),
        dayKey: dayKeyIST(at)
      });
      await fs.updateDoc(petRef, { weightKg: Number(valueKg) });
    },

    async markVaccinationGiven(vacId, { givenOn, nextDueOn }) {
      await fs.updateDoc(fs.doc(petRef, "vaccinations", vacId), {
        lastGivenOn: givenOn,
        nextDueOn
      });
    },

    async reseed() {
      throw new Error("Live mode: run `node scripts/seed.js --reset` in a terminal to reseed.");
    },

    /** A one-off read for the feeding/medication calendar — deliberately
        NOT an onSnapshot listener. The always-on careLogs listener above
        is capped at 8 days to keep reads (and cost) low; a full month
        view needs more history than that, but only while the calendar is
        actually open, so this fetches on demand instead of widening the
        permanent listener. All three clauses are on the same field
        (dayKey), so this needs no composite index. */
    async getLogsInRange(startDayKey, endDayKey) {
      const snap = await fs.getDocs(fs.query(
        fs.collection(petRef, "careLogs"),
        fs.where("dayKey", ">=", startDayKey),
        fs.where("dayKey", "<=", endDayKey),
        fs.orderBy("dayKey", "asc")
      ));
      const trashedIds = new Set(state.trash.map((t) => t.originalId));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((l) => !trashedIds.has(l.id));
    },

    dispose() { unsubs.forEach((u) => u()); }
  };
}
