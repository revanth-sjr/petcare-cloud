/* =====================================================================
   auth-mock.js — accounts without a Firebase project.
   Pod A owns this file.
   ---------------------------------------------------------------------
   Real signup and login semantics (duplicate emails rejected, wrong
   password rejected, session survives a refresh) backed by localStorage.
   This is what makes `npm run dev` a complete demo, and it is the Spark
   plan fallback if Blaze billing never happens.

   Multi-pet model: a session identifies a PERSON, not a pet. Which pets
   they can see comes from `pets[id].memberUids`, exactly mirroring how
   store-firebase.js and firestore.rules decide access for the live app —
   so a scenario that works here works there too, and vice versa.

   Obviously not secure — passwords are not hashed and never leave the
   browser. It is a stand-in for Firebase Auth, not a substitute for it.
   Say so if a judge asks.
   ===================================================================== */

import { makeJoinCode, composeName } from "./auth.js";
import { PET_ID } from "./config.js";

const KEY_USERS   = "petcare.demo.users";
const KEY_SESSION = "petcare.demo.session";
const KEY_PETS    = "petcare.demo.pets";

export async function create() {
  const seed = await fetch("./data/seed.json").then((r) => r.json());

  let users = read(KEY_USERS, null);
  let pets  = read(KEY_PETS, null);

  /* first run: create the two demo accounts and link them to Buddy.
     The pets map carries full display fields (not just an id) so the
     pet selector can list every pet without opening each one's store. */
  if (!users || !pets) {
    users = {};
    for (const a of seed.demoAccounts) {
      users[a.email.toLowerCase()] = {
        uid: `demo-${a.role}`,
        name: a.name,
        email: a.email.toLowerCase(),
        password: a.password,
        lastSelectedPetId: PET_ID
      };
    }
    pets = {
      [PET_ID]: {
        id: PET_ID,
        name: seed.pet.name,
        species: seed.pet.species || "dog",
        breed: seed.pet.breed || "",
        ageYears: seed.pet.ageYears ?? null,
        emoji: seed.pet.emoji || "🐶",
        photoURL: seed.pet.photoURL || "",
        joinCode: seed.pet.joinCode,
        ownerUid: "demo-owner",
        memberUids: ["demo-owner", "demo-caretaker"],
        status: "active"
      }
    };
    write(KEY_USERS, users);
    write(KEY_PETS, pets);
  }

  const listeners = new Set();
  let session = read(KEY_SESSION, null);

  const emit = () => listeners.forEach((cb) => cb(session));

  const sessionFor = (u) => ({
    uid: u.uid, email: u.email, name: u.name,
    firstName: u.firstName || "", middleName: u.middleName || "", lastName: u.lastName || "",
    lastSelectedPetId: u.lastSelectedPetId || null
  });

  const api = {
    mode: "demo",
    ready: Promise.resolve(session),

    current: () => session,

    onChange(cb) {
      listeners.add(cb);
      cb(session);
      return () => listeners.delete(cb);
    },

    async signUp({ firstName, middleName, lastName, email, password }) {
      const key = email.trim().toLowerCase();
      if (users[key]) { const e = new Error("in use"); e.code = "auth/email-already-in-use"; throw e; }
      users[key] = {
        uid: `u-${Math.random().toString(36).slice(2, 10)}`,
        /* `name` stays the single composed string every existing consumer
           reads (performedBy, ownerName, chat context, …) — firstName/
           middleName/lastName are additional fields, kept alongside it so
           nothing downstream had to change for this split. */
        name: composeName({ firstName, middleName, lastName }),
        firstName: (firstName || "").trim(),
        middleName: (middleName || "").trim(),
        lastName: (lastName || "").trim(),
        email: key,
        password,
        lastSelectedPetId: null
      };
      write(KEY_USERS, users);
      session = sessionFor(users[key]);
      write(KEY_SESSION, session);
      emit();
      return session;
    },

    async signIn({ email, password }) {
      const u = users[email.trim().toLowerCase()];
      if (!u)                    { const e = new Error("no user"); e.code = "auth/user-not-found"; throw e; }
      if (u.password !== password) { const e = new Error("bad pw"); e.code = "auth/wrong-password"; throw e; }
      session = sessionFor(u);
      write(KEY_SESSION, session);
      emit();
      return session;
    },

    async signOut() {
      session = null;
      remove(KEY_SESSION);
      emit();
    },

    /* ---------------- pets (multi-pet) ---------------- */

    /** Every pet this account owns or has been added to as a caretaker. */
    async myPets() {
      if (!session) return [];
      return Object.values(pets)
        .filter((p) => (p.memberUids || []).includes(session.uid) && p.status !== "archived")
        .map((p) => ({
          id: p.id, name: p.name, species: p.species || "other", breed: p.breed || "",
          ageYears: p.ageYears ?? null, emoji: p.emoji || "🐾", photoURL: p.photoURL || "",
          status: p.status || "active",
          role: p.ownerUid === session.uid ? "owner" : "caretaker"
        }));
    },

    async createPet({ name, species, breed, ageYears, gender, weightKg, photoURL, feedingSchedule, specialInstructions }) {
      const petId = `pet-${Math.random().toString(36).slice(2, 8)}`;
      const times = Array.isArray(feedingSchedule?.times) && feedingSchedule.times.length
        ? [...feedingSchedule.times].sort() : ["08:00", "13:00", "19:00"];

      pets[petId] = {
        id: petId,
        name: name.trim(),
        species: species || "other",
        breed: (breed || "").trim(),
        ageYears: Number(ageYears) || null,
        gender: gender || "",
        weightKg: Number(weightKg) || null,
        emoji: "🐾",
        photoURL: photoURL || "",
        ownerUid: session.uid,
        ownerName: session.name,
        memberUids: [session.uid],
        joinCode: makeJoinCode(name),
        status: "active",
        dailyTargets: { feeding: times.length, walk: 2 },
        feedingSchedule: { times, notes: (feedingSchedule?.notes || "").trim() },
        specialInstructions: specialInstructions || { allergy: "", medication: "", notes: "" },
        vet: { name: "", phone: "", emergencyPhone: "" }
      };
      write(KEY_PETS, pets);

      await api.setSelectedPetId(petId);
      return petId;
    },

    /** Owner AND caretaker can edit pet details (name, breed, feeding
        schedule, notes, …) — mirrors the Firestore rule for live mode.
        Neither can smuggle in ownership/membership/archive changes
        through this path; those only ever happen via archivePet() and
        joinWithCode(). */
    async updatePet(petId, patch) {
      const p = pets[petId];
      if (!p) throw new Error("Pet not found.");
      if (!(p.memberUids || []).includes(session.uid)) throw new Error("You don't have access to this pet.");
      /* Same denylist as firestore.rules' memberDetailUpdate() — a
         caretaker can edit the pet's own details, but never ownership,
         membership, the join code, or (new) the veterinarian contact.
         `vet` is dropped for anyone but the owner regardless of what the
         caller passed in, mirroring the server-side rule so demo mode and
         live mode enforce the exact same boundary. */
      const isOwner = p.ownerUid === session.uid;
      const { ownerUid, ownerName, memberUids, status, joinCode, vet, ...safePatch } = patch;
      if (isOwner && vet !== undefined) safePatch.vet = vet;
      Object.assign(p, safePatch);
      write(KEY_PETS, pets);
    },

    /** Soft delete — keeps every log, just drops the pet from active lists. */
    async archivePet(petId) {
      const p = pets[petId];
      if (!p) throw new Error("Pet not found.");
      if (p.ownerUid !== session.uid) throw new Error("Only the owner can remove this pet.");
      p.status = "archived";
      write(KEY_PETS, pets);
    },

    async joinWithCode(code) {
      const entry = Object.entries(pets).find(([, p]) => p.joinCode === code);
      if (!entry) throw new Error("No pet found with that code. Ask the owner to check it.");
      const [petId, p] = entry;
      if (!p.memberUids.includes(session.uid)) p.memberUids.push(session.uid);
      write(KEY_PETS, pets);
      api.pendingJoin = { petId, name: session.name, email: session.email };
      await api.setSelectedPetId(petId);
      return petId;
    },

    /* ---------------- which pet is currently open ---------------- */
    async getSelectedPetId() { return session?.lastSelectedPetId || null; },

    async setSelectedPetId(petId) {
      const u = users[session.email];
      u.lastSelectedPetId = petId;
      write(KEY_USERS, users);
      session = sessionFor(u);
      write(KEY_SESSION, session);
      emit();
    },

    /** demo-only: wipe accounts so you can rehearse the signup flow again */
    resetAccounts() {
      remove(KEY_USERS); remove(KEY_PETS); remove(KEY_SESSION);
    }
  };

  return api;
}

/* localStorage with a memory fallback — private windows and blocked
   site data both throw on access rather than returning null. */
const memory = {};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return key in memory ? memory[key] : fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { memory[key] = value; }
}

function remove(key) {
  try { localStorage.removeItem(key); } catch { delete memory[key]; }
}
