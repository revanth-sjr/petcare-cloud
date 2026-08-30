/* =====================================================================
   auth.js — authentication facade.
   Pod A owns this file.
   ---------------------------------------------------------------------
   Picks Firebase Auth when config.js has credentials, and an in-browser
   mock otherwise, so `npm run dev` still gets you a real signup/login
   flow with no Firebase project.

   Both implementations expose the same surface:
       auth.mode                     'live' | 'demo'
       auth.ready                    Promise<session|null>   (resolves once)
       auth.current()                session | null
       auth.onChange(cb)             cb(session|null)
       auth.signUp({name,email,password})      → session
       auth.signIn({email,password})           → session
       auth.signOut()
       auth.myPets()                           → [{id,name,species,breed,ageYears,
                                                    emoji,photoURL,status,role}]
       auth.createPet({name,species,...})      → petId   (owner path)
       auth.updatePet(petId,patch)                       (owner-only, one pet)
       auth.archivePet(petId)                            (soft delete)
       auth.joinWithCode(code)                 → petId   (caretaker path)
       auth.getSelectedPetId() / setSelectedPetId(petId)

   A session identifies a PERSON, not a pet — one account can own one pet
   and caretake another, so role is never stored on the session:
       { uid, email, name, lastSelectedPetId }
   Role for whichever pet is open comes from the matching entry in
   auth.myPets(), e.g. myPets().find(p => p.id === petId).role.
   ===================================================================== */

import { isFirebaseConfigured } from "./config.js";

let impl = null;

export async function initAuth() {
  if (impl) return impl;
  if (isFirebaseConfigured()) {
    try {
      impl = await (await import("./auth-firebase.js")).create();
      return impl;
    } catch (err) {
      console.warn("[PetCare] Firebase Auth unavailable, using the demo account store.", err);
    }
  }
  impl = await (await import("./auth-mock.js")).create();
  return impl;
}

/* ---------------------------------------------------------------------
   Shared validation. Used by both implementations and by the login page,
   so the rules a user sees are the rules that actually apply.
   ------------------------------------------------------------------ */
export const RULES = {
  nameMin: 2,
  passwordMin: 6,
  codePattern: /^[A-Z0-9]{3,10}-[0-9]{3,6}$/
};

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "yopmail.com", "mailinator.com", "tempmail.com", "10minutemail.com",
  "guerrillamail.com", "dispostable.com", "trashmail.com", "getairmail.com",
  "sharklasers.com", "throwawaymail.com", "maildrop.cc", "temp-mail.org",
  "fakeinbox.com", "mailcatch.com", "mymailnavy.com"
]);

export function emailValidationError(v) {
  const clean = String(v || "").trim().toLowerCase();
  if (!clean) return "Enter your Gmail address.";
  if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(clean)) return "Enter a valid email address.";
  
  if (!clean.endsWith("@gmail.com")) {
    return "Only legitimate @gmail.com email addresses are allowed.";
  }
  
  const domain = clean.split("@")[1];
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return "Temporary/disposable emails are not allowed. Please use your real Gmail address.";
  return null;
}

export const isEmail = (v) => !emailValidationError(v);

/** First + Last are required, Middle is optional — composeName() below is
    what turns the three into the single `name` string every other part of
    the app already reads (performedBy, ownerName, chat context, …), so
    nothing downstream needed to change for this split. */
export function validateSignup({ firstName, lastName, email, password }) {
  if (!firstName || firstName.trim().length < 1) return "Enter your first name.";
  if (!lastName || lastName.trim().length < 1)   return "Enter your last name.";
  const emailErr = emailValidationError(email);
  if (emailErr) return emailErr;
  if (!password || password.length < RULES.passwordMin)
    return `Password must be at least ${RULES.passwordMin} characters.`;
  return null;
}

/** "Revanth  Kumar" (double space if middle is blank) never happens —
    filter(Boolean) drops empty parts before joining. */
export function composeName({ firstName, middleName, lastName }) {
  return [firstName, middleName, lastName].map((s) => (s || "").trim()).filter(Boolean).join(" ");
}

export function validateLogin({ email, password }) {
  const emailErr = emailValidationError(email);
  if (emailErr) return emailErr;
  if (!password) return "Enter your password.";
  return null;
}

export const normaliseCode = (v) => String(v || "").trim().toUpperCase();

/** Human-readable message for the error codes Firebase Auth returns. */
export function authMessage(err) {
  const code = err?.code || "";
  const map = {
    "auth/email-already-in-use": "That email already has an account. Log in instead.",
    "auth/invalid-email":        "That email address doesn't look right.",
    "auth/weak-password":        `Password must be at least ${RULES.passwordMin} characters.`,
    "auth/user-not-found":       "No account with that email. Sign up instead.",
    "auth/wrong-password":       "Wrong password. Try again.",
    "auth/invalid-credential":   "Email or password is incorrect.",
    "auth/too-many-requests":    "Too many attempts. Wait a minute and try again.",
    "auth/network-request-failed":"Network problem — check your connection.",
    "auth/operation-not-allowed":"Email/password sign-in is not enabled in the Firebase console."
  };
  return map[code] || err?.message || "Something went wrong. Try again.";
}

/** A short, readable join code: BUDDY-4821 */
export function makeJoinCode(petName) {
  const stem = String(petName || "PET").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "PET";
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${stem}-${n}`;
}

/* ---------------------------------------------------------------------
   Pet type → breed — used by onboarding, the edit-pet form, the pet
   selector, and the AI context. Picking a type shows that type's own
   curated breed/species list (breedOptions); "Other" always opens a
   free-text field, so nothing is ever forced into the wrong bucket.
   ------------------------------------------------------------------ */
export const SPECIES = [
  { id: "dog", label: "Dog", icon: '<img src="https://img.icons8.com/color/48/dog.png" alt="Dog" class="species-icon-img">', breedLabel: "Breed", breeds: [
      "Labrador Retriever", "Golden Retriever", "German Shepherd", "Poodle", "Beagle",
      "Bulldog", "Rottweiler", "Shih Tzu", "Pomeranian", "Mixed Breed"
    ] },
  { id: "cat", label: "Cat", icon: '<img src="https://img.icons8.com/color/48/cat.png" alt="Cat" class="species-icon-img">', breedLabel: "Breed", breeds: [
      "Persian", "Siamese", "Maine Coon", "Bengal", "Ragdoll", "British Shorthair", "Sphynx", "Mixed Breed"
    ] },
  { id: "bird", label: "Bird", icon: '<img src="https://img.icons8.com/color/48/bird.png" alt="Bird" class="species-icon-img">', breedLabel: "Bird type", breeds: [
      "Parrot", "Cockatiel", "Lovebird", "Budgerigar", "Macaw", "Canary", "Finch"
    ] },
  { id: "fish", label: "Fish", icon: '<img src="https://img.icons8.com/color/48/fish.png" alt="Fish" class="species-icon-img">', breedLabel: "Fish type", breeds: [
      "Goldfish", "Betta", "Guppy", "Molly", "Tetra", "Angelfish", "Koi"
    ] },
  { id: "rabbit", label: "Rabbit", icon: '<img src="https://img.icons8.com/color/48/rabbit.png" alt="Rabbit" class="species-icon-img">', breedLabel: "Breed", breeds: [
      "Holland Lop", "Netherland Dwarf", "Mini Rex", "Lionhead", "Flemish Giant"
    ] },
  { id: "hamster", label: "Hamster", icon: '<img src="https://img.icons8.com/color/48/hamster.png" alt="Hamster" class="species-icon-img">', breedLabel: "Breed", breeds: [
      "Syrian", "Roborovski", "Campbell's Dwarf", "Winter White", "Chinese"
    ] },
  { id: "reptile", label: "Reptile", icon: '<img src="https://img.icons8.com/color/48/lizard.png" alt="Reptile" class="species-icon-img">', breedLabel: "Type", breeds: [
      "Turtle", "Tortoise", "Gecko", "Iguana", "Snake", "Bearded Dragon"
    ] },
  { id: "other", label: "Other", icon: "🐾", breedLabel: "Type / breed", breeds: [] }
];

export function speciesMeta(id) {
  return SPECIES.find((s) => s.id === id) || SPECIES[SPECIES.length - 1];
}

/** This type's curated list, always ending in "Other" for a free-text value. */
export function breedOptions(id) {
  return [...speciesMeta(id).breeds, "Other"];
}

/** Required: name + species. Everything else in the pet form is optional. */
export function validatePetForm({ name, species }) {
  if (!name || name.trim().length < 1) return "Give your pet a name.";
  if (!species || !SPECIES.some((s) => s.id === species)) return "Choose a pet type.";
  return null;
}
