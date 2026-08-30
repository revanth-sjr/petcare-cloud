/* =====================================================================
   store-mock.js — in-memory demo store.
   Pod A owns this file.
   ---------------------------------------------------------------------
   Runs when config.js has no Firebase credentials, or when Firebase fails
   to load. Same interface as store-firebase.js, so nothing else in the app
   knows the difference. This is the Spark-plan escape hatch: the whole
   demo works with no billing account at all.
   ===================================================================== */

import { istTimeToday, dayKeyIST, dayKeyOffset, now } from "./time.js";
import { PET_ID, UNDO_WINDOW_SECONDS } from "./config.js";

const UNDO_WINDOW_MS = UNDO_WINDOW_SECONDS * 1000;

export async function create(petId = PET_ID, session = null) {
  const seed = await fetch("./data/seed.json").then((r) => r.json());

  /* An owner who signed up in demo mode gets an empty pet of their own,
     not Buddy's history. */
  const isSeededPet = petId === seed.pet.id || petId === PET_ID;
  const start = () => {
    let s;
    if (isSeededPet) {
      /* The seeded pet's rich logs/meds/vaccinations always come from
         seed.json, but its editable fields (name, species, photo…) may
         have been changed since via auth.updatePet() — pull those from
         the pets map auth-mock.js maintains so an edit actually sticks. */
      let override = null;
      try { override = JSON.parse(localStorage.getItem("petcare.demo.pets") || "{}")[petId] || null; } catch { /* ignore */ }
      s = buildSeededState(seed, override);
    } else {
      s = buildEmptyState(petId, session);
    }
    /* Someone who just redeemed a care code introduces themselves to the
       roster, the same way auth-firebase.js writes their caretaker doc. */
    if (session?.role === "caretaker" &&
        !s.caretakers.some((c) => c.email && c.email === session.email)) {
      s.caretakers.push({
        id: `ct-${session.uid}`,
        uid: session.uid,
        name: session.name,
        email: session.email,
        role: "caretaker",
        status: "active",
        note: "Joined with a care code"
      });
    }
    return s;
  };
  /* Persist across sign-out and across midnight so the owner can log a
     feeding, hand over to the caretaker account, and have it still be
     there tomorrow. `dayKey` is kept only as a label on the saved blob —
     it no longer gates whether the cache is used. It used to: a stale
     dayKey made this rebuild from seed instead of restoring, which reads
     fine for the seeded demo pet (its "history" is synthetic and gets
     regenerated fresh anyway) but silently deleted every real log for a
     pet a real signup created, exactly the midnight data-loss this app
     must not have. A deliberate full reset is still one click away via
     the existing "Reseed demo data" control (store.reseed()), which
     clears this same key on purpose. */
  const CACHE = `petcare.demo.state.${petId}`;

  const save = () => {
    try {
      localStorage.setItem(CACHE, JSON.stringify({
        dayKey: dayKeyIST(now()),
        logs: state.logs,
        medications: state.medications,
        caretakers: state.caretakers,
        vaccinations: state.vaccinations,
        weights: state.weights,
        trash: state.trash,
        memories: state.memories,
        pet: state.pet
      }));
    } catch { /* private window or blocked storage — memory only */ }
  };

  const restore = () => {
    try {
      const raw = localStorage.getItem(CACHE);
      if (!raw) return null;
      const blob = JSON.parse(raw);
      return {
        ...start(),
        pet: blob.pet,
        logs: blob.logs.map((l) => ({ ...l, at: new Date(l.at) })),
        /* medications is a newer field — a blob saved before it existed
           simply has none, and start()'s baseline (seed meds for the
           demo pet, [] for a real one) is kept instead of an empty list. */
        medications: Array.isArray(blob.medications) ? blob.medications : start().medications,
        caretakers: blob.caretakers,
        vaccinations: blob.vaccinations,
        weights: blob.weights.map((w) => ({ ...w, at: new Date(w.at) })),
        /* trash is newer still — a blob saved before the Bin existed
           simply has none, exactly the same backward-compatible default
           medications got above. */
        trash: Array.isArray(blob.trash)
          ? blob.trash.map((t) => ({ ...t, at: new Date(t.at), deletedAt: new Date(t.deletedAt) }))
          : [],
        /* memories is newer still — same backward-compatible default. */
        memories: Array.isArray(blob.memories)
          ? blob.memories.map((m) => ({ ...m, createdAt: new Date(m.createdAt) }))
          : []
      };
    } catch { return null; }
  };

  let state = restore() || start();

  const listeners = new Set();
  const snapshot = () => ({
    pet:          state.pet,
    medications:  [...state.medications],
    logs:         [...state.logs],
    caretakers:   [...state.caretakers],
    vaccinations: [...state.vaccinations],
    weights:      [...state.weights],
    vets:         [...state.vets],
    trash:        [...state.trash],
    memories:     [...state.memories]
  });
  const emit = () => { save(); listeners.forEach((cb) => cb(snapshot())); };

  const newId = (p) => `${p}-${Math.random().toString(36).slice(2, 9)}`;

  return {
    mode: "demo",
    modeLabel: "Demo mode — data is in this browser only",
    petId,

    subscribe(cb) {
      listeners.add(cb);
      cb(snapshot());
      return () => listeners.delete(cb);
    },

    /* ---------------- care logging ---------------- */
    async logCare(entry) {
      const at = now();
      const id = newId("log");
      state.logs.push({
        id,
        type:            entry.type,
        medicationId:    entry.medicationId ?? null,
        slot:            entry.slot ?? null,
        notes:           entry.notes ?? "",
        performedBy:     entry.performedBy,
        performedByRole: entry.performedByRole,
        at,
        dayKey:          dayKeyIST(at)
      });
      emit();
      return id;
    },

    /** Undo — for the short "Feeding recorded • Undo" window right after
        logCare(). Mirrors store-firebase.js's time-boxed self-delete rule:
        only removes a log this same session just created, and only within
        UNDO_WINDOW_MS of it. This is the one place a careLog can ever be
        removed — every other path treats the log list as append-only. */
    async undoLog(logId) {
      const log = state.logs.find((l) => l.id === logId);
      if (!log) return false;
      if (now() - log.at > UNDO_WINDOW_MS) return false;
      state.logs = state.logs.filter((l) => l.id !== logId);
      emit();
      return true;
    },

    /* ---------------- bin / trash ----------------
       Moving a record to the bin never removes it from state.logs — the
       careLogs collection this mirrors is append-only in Firestore, and
       demo mode keeps the same guarantee. A trash entry is a full
       snapshot of the log plus who/when deleted it; data.js's
       buildDashboard() filters any log whose id shows up here out of
       every app-facing view. Restoring just removes the marker;
       "delete permanently" only flips `permanent` so the Bin itself
       stops listing it — the underlying log is never actually erased. */
    async trashLog(logId, { deletedBy, deletedByRole, deletedByUid } = {}) {
      const log = state.logs.find((l) => l.id === logId);
      if (!log) throw new Error("That record no longer exists.");
      if (state.trash.some((t) => t.originalId === logId)) return; // already in the bin
      state.trash.push({
        id: newId("trash"),
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
        deletedAt: now(),
        deletedBy: deletedBy || "",
        deletedByRole: deletedByRole || "",
        deletedByUid: deletedByUid || "",
        permanent: false
      });
      emit();
    },

    async restoreLog(trashId) {
      const before = state.trash.length;
      state.trash = state.trash.filter((t) => t.id !== trashId);
      if (state.trash.length === before) throw new Error("That record is no longer in the bin.");
      emit();
    },

    async permanentlyDeleteLog(trashId) {
      const t = state.trash.find((x) => x.id === trashId);
      if (!t) throw new Error("That record is no longer in the bin.");
      t.permanent = true;
      emit();
    },

    /* ---------------- memories ----------------
       Photos, growth and milestones — any member can add one (a
       caretaker photographing a first walk shouldn't need the owner
       present), but editing or deleting one is scoped to whoever
       created it, or the owner, the same split weights already use.
       Photos are stored as the same downscaled data-URL wirePhotoPicker
       already produces for a pet's profile photo — no Firebase Storage
       required, and nothing here changes that project setting. */
    async addMemory({ title, description, date, photoURL, createdBy, createdByRole, createdByUid }) {
      const memory = {
        id: newId("mem"),
        title: (title || "").trim(),
        description: (description || "").trim(),
        date: date || dayKeyIST(now()),
        photoURL: photoURL || "",
        createdBy: createdBy || "",
        createdByRole: createdByRole || "",
        createdByUid: createdByUid || "",
        createdAt: now()
      };
      state.memories.push(memory);
      emit();
      return memory.id;
    },

    async updateMemory(id, patch) {
      const m = state.memories.find((x) => x.id === id);
      if (!m) throw new Error("Memory not found.");
      Object.assign(m, patch);
      emit();
    },

    async deleteMemory(id) {
      state.memories = state.memories.filter((m) => m.id !== id);
      emit();
    },

    /* ---------------- medications (owner only) ----------------
       Owner-only mirrors the Firestore rule (`allow write: if isOwner()`
       on /pets/{petId}/medications/{medId}) — a caretaker can view the
       schedule and log doses, but adding/editing/removing the medication
       itself stays with the owner, the same split Section 8 draws for
       every other owner-vs-caretaker boundary in this app. */
    async addMedication({ name, dosage, type, feedingRelation, frequency, scheduledTimes, startDate, endDate, instructions }) {
      const med = {
        id: newId("med"),
        name: (name || "").trim(),
        dosage: (dosage || "").trim(),
        /* type/feedingRelation are new, optional fields — mirrors
           store-firebase.js's addMedication exactly, so demo and live mode
           save the same shape. */
        type: (type || "").trim(),
        feedingRelation: (feedingRelation || "").trim(),
        frequency: (frequency || "").trim(),
        scheduledTimes: Array.isArray(scheduledTimes) && scheduledTimes.length
          ? [...scheduledTimes].sort() : ["09:00"],
        startDate: startDate || "",
        endDate: endDate || "",
        instructions: (instructions || "").trim(),
        active: true
      };
      state.medications.push(med);
      emit();
      return med.id;
    },

    async updateMedication(id, patch) {
      const med = state.medications.find((m) => m.id === id);
      if (!med) throw new Error("Medication not found.");
      Object.assign(med, patch);
      emit();
    },

    async deleteMedication(id) {
      state.medications = state.medications.filter((m) => m.id !== id);
      emit();
    },

    /* ---------------- caretakers (owner only) ---------------- */
    async addCaretaker({ name, email, note }) {
      if (state.caretakers.some((c) => c.email && c.email === email?.toLowerCase())) {
        throw new Error(`${name || email} is already on the care team.`);
      }
      state.caretakers.push({
        id: newId("ct"),
        name: name.trim(),
        email: (email || "").trim().toLowerCase(),
        note: (note || "").trim(),
        role: "caretaker",
        status: "active",
        addedAt: now()
      });
      emit();
    },

    async updateCaretaker(id, patch) {
      const ct = state.caretakers.find((c) => c.id === id);
      if (!ct) throw new Error("Caretaker not found.");
      Object.assign(ct, patch);
      emit();
    },

    async removeCaretaker(id) {
      const ct = state.caretakers.find((c) => c.id === id);
      if (ct?.uid) {
        try {
          let storedPets = JSON.parse(localStorage.getItem("petcare.demo.pets") || "{}");
          if (storedPets[petId]) {
            storedPets[petId].memberUids = (storedPets[petId].memberUids || []).filter((u) => u !== ct.uid);
            localStorage.setItem("petcare.demo.pets", JSON.stringify(storedPets));
          }
        } catch { /* storage fallback */ }
      }
      state.caretakers = state.caretakers.filter((c) => c.id !== id);
      emit();
    },

    /* ---------------- health ---------------- */
    async logWeight({ valueKg, notes, recordedBy }) {
      const at = now();
      state.weights.push({
        id: newId("wt"),
        valueKg: Number(valueKg),
        notes: notes || "",
        recordedBy,
        at,
        dayKey: dayKeyIST(at)
      });
      state.pet = { ...state.pet, weightKg: Number(valueKg) };
      emit();
    },

    async markVaccinationGiven(vacId, { givenOn, nextDueOn }) {
      const v = state.vaccinations.find((x) => x.id === vacId);
      if (!v) throw new Error("Vaccination not found.");
      v.lastGivenOn = givenOn;
      v.nextDueOn   = nextDueOn;
      emit();
    },

    async reseed() {
      try { localStorage.removeItem(CACHE); } catch { /* ignore */ }
      state = start();
      emit();
    },

    /** Demo-mode equivalent of the Firestore range read used by the
        feeding/medication calendar — everything already lives in memory,
        so this is just a filter, but the interface matches store-firebase.js
        exactly so calendar.js never needs to know which store it has. */
    async getLogsInRange(startDayKey, endDayKey) {
      const trashedIds = new Set(state.trash.map((t) => t.originalId));
      return state.logs
        .filter((l) => l.dayKey >= startDayKey && l.dayKey <= endDayKey && !trashedIds.has(l.id))
        .map((l) => ({ ...l }));
    },

    /** No open connections to tear down in demo mode — kept for interface
        parity with store-firebase.js so app.js can call it unconditionally
        on every pet switch. */
    dispose() { listeners.clear(); }
  };
}

/* ------------------------------------------------------------------ */
/**
 * A pet created through demo-mode signup. Its record was written by
 * auth-mock.js; read it back from the same place so a refresh keeps the
 * pet's name and care code. Care logs stay in memory — demo mode is a
 * stand-in for Firestore, not a database.
 */
function buildEmptyState(petId, session) {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem("petcare.demo.pets") || "{}")[petId] || null;
  } catch { /* private window or blocked storage */ }

  return {
    pet: stored || {
      id: petId,
      name: "Your pet",
      species: "other",
      breed: "",
      ageYears: null,
      gender: "",
      weightKg: null,
      emoji: "🐾",
      photoURL: "",
      status: "active",
      ownerName: session?.name || "",
      joinCode: "",
      dailyTargets: { feeding: 3, walk: 2 },
      specialInstructions: { allergy: "", medication: "", notes: "" },
      vet: { name: "", phone: "", emergencyPhone: "" }
    },
    medications: [], logs: [], caretakers: [], vaccinations: [], weights: [], vets: [], trash: [], memories: []
  };
}

function buildSeededState(seed, petOverride) {
  const logs = [];

  for (const l of seed.todayLogs) {
    const at = istTimeToday(l.time);
    logs.push({
      id: `seed-${l.type}-${l.time}`,
      type: l.type,
      medicationId: l.medicationId ?? null,
      slot: l.slot ?? null,
      notes: l.notes ?? "",
      performedBy: l.performedBy,
      performedByRole: l.role,
      at,
      dayKey: dayKeyIST(at)
    });
  }

  for (const day of seed.historyPlan) {
    const dayKey = dayKeyOffset(day.dayOffset);
    const stamp = (time) =>
      istTimeToday(time, new Date(now().getTime() + day.dayOffset * 86_400_000));

    ["08:00", "13:00", "19:30"].slice(0, day.feeding)
      .forEach((t, i) => logs.push(histLog("feeding", t, dayKey, stamp(t), i)));
    ["07:00", "18:00"].slice(0, day.walk)
      .forEach((t, i) => logs.push(histLog("walk", t, dayKey, stamp(t), i)));
    (day.medSlots || []).forEach((slot, i) => {
      const l = histLog("medication", slot, dayKey, stamp(slot), i);
      l.medicationId = slot === "09:00" ? "med-joint" : "med-amox";
      l.slot = slot;
      logs.push(l);
    });
  }

  const weights = (seed.weightHistory || []).map((w, i) => {
    const at = new Date(now().getTime() + w.dayOffset * 86_400_000);
    return {
      id: `wt-${i}`,
      valueKg: w.valueKg,
      notes: w.notes || "",
      recordedBy: w.recordedBy,
      at,
      dayKey: dayKeyIST(at)
    };
  });

  return {
    pet:          petOverride ? { ...seed.pet, ...petOverride } : { ...seed.pet },
    medications:  seed.medications.map((m) => ({ ...m })),
    caretakers:   seed.caretakers.map((c) => ({ ...c })),
    vaccinations: (seed.vaccinations || []).map((v) => ({ ...v })),
    vets:         seed.vets.map((v) => ({ ...v })),
    weights,
    logs,
    trash: [],
    memories: []
  };
}

function histLog(type, time, dayKey, at, i) {
  const byCaretaker = (time === "13:00" || time === "18:00");
  return {
    id: `hist-${dayKey}-${type}-${time}-${i}`,
    type,
    medicationId: null,
    slot: null,
    notes: "",
    performedBy:     byCaretaker ? "Arun" : "Revanth",
    performedByRole: byCaretaker ? "caretaker" : "owner",
    at,
    dayKey
  };
}
