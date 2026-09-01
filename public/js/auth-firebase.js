/* =====================================================================
   auth-firebase.js — Firebase Authentication, email and password.
   Pod A owns this file.
   ---------------------------------------------------------------------
   Deliberately minimal: signup, login, logout, plus the multi-pet
   membership calls the app needs. No password reset, no email
   verification, no social providers, no profile management — roadmap
   items, not this file's job.

   Multi-pet model: a signed-in user is a PERSON, not a pet. Which pets
   they can open comes entirely from `pets/{petId}.memberUids` — the
   same array the Firestore rules already check — so "list my pets" is
   just `pets where memberUids array-contains uid`. The users/{uid}
   document is now only a convenience: display name and which pet was
   open last (lastSelectedPetId). It is never the source of truth for
   access.
   ===================================================================== */

import { firebaseConfig } from "./config.js";
import { makeJoinCode, composeName, normaliseCode } from "./auth.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.0";

export async function create() {
  const [{ initializeApp, getApps }, authMod, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`)
  ]);

  const app  = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  const db   = fs.getFirestore(app);

  /* keep the session across a refresh — a demo that logs you out on
     reload is a demo that fails on stage */
  await authMod.setPersistence(auth, authMod.browserLocalPersistence);

  const listeners = new Set();
  let session = null;
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  let first = true;

  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

  authMod.onAuthStateChanged(auth, async (user) => {
    if (user) {
      const loginTimeKey = "petcare_login_time_" + user.uid;
      const loginTimeStr = localStorage.getItem(loginTimeKey);
      const now = Date.now();

      if (loginTimeStr) {
        const loginTime = parseInt(loginTimeStr, 10);
        if (now - loginTime > TWENTY_FOUR_HOURS_MS) {
          console.log("[PetCare Auth] 24-hour session expired. Automatically signing out.");
          localStorage.removeItem(loginTimeKey);
          await authMod.signOut(auth);
          session = null;
          listeners.forEach((cb) => cb(null));
          if (first) { first = false; resolveReady(null); }
          return;
        }
      } else {
        localStorage.setItem(loginTimeKey, now.toString());
      }

      session = await hydrate(user);
    } else {
      session = null;
    }

    listeners.forEach((cb) => cb(session));
    if (first) { first = false; resolveReady(session); }
  });

  setInterval(() => {
    const user = auth.currentUser;
    if (user) {
      const loginTimeKey = "petcare_login_time_" + user.uid;
      const loginTimeStr = localStorage.getItem(loginTimeKey);
      if (loginTimeStr && (Date.now() - parseInt(loginTimeStr, 10) > TWENTY_FOUR_HOURS_MS)) {
        console.log("[PetCare Auth] Active 24-hour session timer triggered logout.");
        localStorage.removeItem(loginTimeKey);
        authMod.signOut(auth).then(() => {
          window.location.href = "./login.html";
        });
      }
    }
  }, 60000);

  /** Turn a Firebase user into our session shape. Identity only — no
      petId/role here, since one person can hold different roles on
      different pets. */
  async function hydrate(user) {
    const snap = await fs.getDoc(fs.doc(db, "users", user.uid));
    const profile = snap.exists() ? snap.data() : {};
    return {
      uid:   user.uid,
      email: user.email,
      emailVerified: Boolean(user.emailVerified),
      otpVerified: Boolean(profile.otpVerified),
      name:  profile.name || user.displayName || (user.email || "").split("@")[0],
      firstName: profile.firstName || "", middleName: profile.middleName || "", lastName: profile.lastName || "",
      lastSelectedPetId: profile.lastSelectedPetId || null
    };
  }

  async function saveProfile(uid, patch) {
    try {
      await fs.setDoc(fs.doc(db, "users", uid), patch, { merge: true });
    } catch (e) {
      console.warn("[PetCare] saveProfile setDoc warn:", e);
    }
  }

  async function sendOtpEmail(targetEmail, targetName, otpCode) {
    const cleanEmail = targetEmail.trim().toLowerCase();
    
    /* 1. FormSubmit AJAX email dispatch (Sends real email with 6-digit OTP code to Gmail inbox) */
    try {
      await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(cleanEmail)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          _subject: `PetCare Verification OTP Code: ${otpCode}`,
          Your_6_Digit_OTP_Code: otpCode,
          User: targetName || cleanEmail.split("@")[0],
          Message: `Your 6-digit OTP verification code for PetCare login is: ${otpCode}. Please enter this 6-digit code on the login page.`
        })
      });
    } catch (e) {
      console.warn("[PetCare Email] FormSubmit dispatch error:", e);
    }

    /* 2. Write to Firestore mail collection for Firebase Trigger Email extension */
    try {
      await fs.addDoc(fs.collection(db, "mail"), {
        to: [cleanEmail],
        message: {
          subject: `PetCare Verification Code: ${otpCode}`,
          text: `Your 6-digit OTP verification code for PetCare login is: ${otpCode}`,
          html: `<div style="font-family:sans-serif;padding:20px;border:1px solid #e0e0e0;border-radius:10px;"><h2>PetCare Authentication OTP</h2><p>Your 6-digit OTP verification code is:</p><div style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#10b981;padding:12px;background:#f0fdf4;border-radius:8px;display:inline-block;margin:10px 0;">${otpCode}</div></div>`
        },
        createdAt: fs.serverTimestamp()
      });
    } catch (e) {
      console.warn("[PetCare Email] Firestore mail trigger warn:", e);
    }
  }

  const api = {
    mode: "live",
    ready,
    current: () => session,

    onChange(cb) {
      listeners.add(cb);
      cb(session);
      return () => listeners.delete(cb);
    },

    async sendOtpForEmail(email, name = "") {
      const cleanEmail = String(email || "").trim().toLowerCase();
      if (!cleanEmail || !cleanEmail.includes("@")) {
        throw new Error("Enter a valid email address.");
      }

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      
      try {
        sessionStorage.setItem("petcare_otp_" + cleanEmail, otp);
      } catch (e) {}

      try {
        await fs.setDoc(fs.doc(db, "pendingOtps", cleanEmail), {
          email: cleanEmail,
          otpCode: otp,
          createdAt: fs.serverTimestamp()
        }, { merge: true });
      } catch (e) {
        console.warn("[PetCare] Firestore pendingOtps setDoc warn:", e);
      }

      await sendOtpEmail(cleanEmail, name, otp);
      return otp;
    },

    async signUpWithOtp({ firstName, middleName, lastName, email, password, otpCode }) {
      const cleanEmail = String(email || "").trim().toLowerCase();
      const cleanOtp = String(otpCode || "").trim();

      if (!cleanOtp || cleanOtp.length !== 6 || !/^[0-9]{6}$/.test(cleanOtp)) {
        throw new Error("Enter the 6-digit OTP code received in your Gmail inbox.");
      }

      let localOtp = null;
      try { localOtp = sessionStorage.getItem("petcare_otp_" + cleanEmail); } catch (e) {}

      let firestoreOtp = null;
      try {
        const otpSnap = await fs.getDoc(fs.doc(db, "pendingOtps", cleanEmail));
        firestoreOtp = otpSnap.exists() ? String(otpSnap.data()?.otpCode).trim() : null;
      } catch (e) {
        console.warn("[PetCare] pendingOtps getDoc warn:", e);
      }

      const validOtps = [localOtp, firestoreOtp].filter(Boolean);
      if (validOtps.length > 0 && !validOtps.includes(cleanOtp)) {
        throw new Error("Incorrect OTP code. Please check your Gmail inbox and click 'Verify Email & Send OTP' if needed.");
      }

      const name = composeName({ firstName, middleName, lastName });
      const cred = await authMod.createUserWithEmailAndPassword(auth, cleanEmail, password);
      await authMod.updateProfile(cred.user, { displayName: name });

      await saveProfile(cred.user.uid, {
        name,
        firstName: (firstName || "").trim(),
        middleName: (middleName || "").trim(),
        lastName: (lastName || "").trim(),
        email: cleanEmail,
        otpVerified: true,
        emailVerified: true,
        createdAt: fs.serverTimestamp()
      });

      localStorage.setItem("petcare_login_time_" + cred.user.uid, Date.now().toString());
      session = await hydrate(cred.user);
      session.otpVerified = true;
      session.emailVerified = true;
      return session;
    },

    async signInWithOtp({ email, password, otpCode }) {
      const cleanEmail = String(email || "").trim().toLowerCase();
      const cleanOtp = String(otpCode || "").trim();

      if (!cleanOtp || cleanOtp.length !== 6 || !/^[0-9]{6}$/.test(cleanOtp)) {
        throw new Error("Enter the 6-digit OTP code received in your Gmail inbox.");
      }

      let localOtp = null;
      try { localOtp = sessionStorage.getItem("petcare_otp_" + cleanEmail); } catch (e) {}

      let firestoreOtp = null;
      try {
        const otpSnap = await fs.getDoc(fs.doc(db, "pendingOtps", cleanEmail));
        firestoreOtp = otpSnap.exists() ? String(otpSnap.data()?.otpCode).trim() : null;
      } catch (e) {
        console.warn("[PetCare] pendingOtps getDoc warn:", e);
      }

      const cred = await authMod.signInWithEmailAndPassword(auth, cleanEmail, password);

      let userOtp = null;
      try {
        const userSnap = await fs.getDoc(fs.doc(db, "users", cred.user.uid));
        userOtp = userSnap.exists() ? String(userSnap.data()?.otpCode).trim() : null;
      } catch (e) {
        console.warn("[PetCare] userSnap getDoc warn:", e);
      }

      const validOtps = [localOtp, firestoreOtp, userOtp].filter(Boolean);
      if (validOtps.length > 0 && !validOtps.includes(cleanOtp)) {
        throw new Error("Incorrect OTP code. Please check your Gmail inbox and enter the 6-digit code.");
      }

      await saveProfile(cred.user.uid, { otpVerified: true, emailVerified: true });
      localStorage.setItem("petcare_login_time_" + cred.user.uid, Date.now().toString());
      session = await hydrate(cred.user);
      session.otpVerified = true;
      session.emailVerified = true;
      return session;
    },

    async signUp(details) {
      return api.signUpWithOtp({ ...details, otpCode: details.otpCode || "" });
    },

    async signIn(creds) {
      return api.signInWithOtp({ ...creds, otpCode: creds.otpCode || "" });
    },

    async getOtpCode() {
      const user = auth.currentUser;
      if (!user) return null;
      const snap = await fs.getDoc(fs.doc(db, "users", user.uid));
      return snap.exists() ? snap.data()?.otpCode || null : null;
    },

    async resendVerificationEmail() {
      const user = auth.currentUser;
      if (!user) throw new Error("No user is currently signed in.");
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      await saveProfile(user.uid, { otpCode: otp, otpVerified: false });
      await sendOtpEmail(user.email, session?.name, otp);
      try {
        await authMod.sendEmailVerification(user);
      } catch (err) {
        console.warn("[PetCare] sendEmailVerification error:", err);
      }
      return otp;
    },

    async checkEmailVerification() {
      const user = auth.currentUser;
      if (!user) return false;
      await user.reload();
      session = await hydrate(auth.currentUser);
      return Boolean(auth.currentUser.emailVerified);
    },

    async verifyOtp(code) {
      const user = auth.currentUser;
      if (!user) throw new Error("No user is currently signed in.");
      const clean = String(code || "").trim();
      if (!clean || clean.length !== 6 || !/^[0-9]{6}$/.test(clean)) {
        throw new Error("Please enter a valid 6-digit OTP code received in your Gmail inbox.");
      }

      const snap = await fs.getDoc(fs.doc(db, "users", user.uid));
      const savedOtp = snap.exists() ? snap.data()?.otpCode : null;

      if (savedOtp && String(savedOtp).trim() === clean) {
        await saveProfile(user.uid, { otpVerified: true, emailVerified: true });
        session = await hydrate(user);
        session.otpVerified = true;
        session.emailVerified = true;
        return true;
      }

      throw new Error("Invalid OTP code. Please check your Gmail inbox and enter the correct 6-digit code.");
    },

    async signOut() {
      if (auth.currentUser) {
        localStorage.removeItem("petcare_login_time_" + auth.currentUser.uid);
      }
      await authMod.signOut(auth);
      session = null;
    },

    /* ----------------------------------------------------------------
       Pets (multi-pet). Every pet lives at the top level; a person's
       access is entirely `memberUids`-based, never stored per-user.
       ---------------------------------------------------------------- */

    /** Every pet this account owns or has been added to as a caretaker. */
    async myPets() {
      const uid = auth.currentUser?.uid;
      if (!uid) return [];
      const q = fs.query(fs.collection(db, "pets"), fs.where("memberUids", "array-contains", uid));
      const snap = await fs.getDocs(q);
      return snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((p) => p.status !== "archived")
        .map((p) => ({
          id: p.id, name: p.name, species: p.species || "other", breed: p.breed || "",
          ageYears: p.ageYears ?? null, emoji: p.emoji || "🐾", photoURL: p.photoURL || "",
          status: p.status || "active",
          role: p.ownerUid === uid ? "owner" : "caretaker"
        }));
    },

    /** Owner path: create a pet, claim ownership, publish a join code. */
    async createPet({ name, species, breed, ageYears, gender, weightKg, photoURL, feedingSchedule, walkTarget, specialInstructions }) {
      const uid   = auth.currentUser.uid;
      const petId = fs.doc(fs.collection(db, "pets")).id;
      const code  = makeJoinCode(name);
      const times = Array.isArray(feedingSchedule?.times) && feedingSchedule.times.length
        ? [...feedingSchedule.times].sort() : ["08:00", "13:00", "19:00"];

      await fs.setDoc(fs.doc(db, "pets", petId), {
        name: name.trim(),
        species: species || "other",
        breed: (breed || "").trim(),
        ageYears: Number(ageYears) || null,
        gender: gender || "",
        weightKg: Number(weightKg) || null,
        emoji: "🐾",
        photoURL: photoURL || "",
        ownerUid: uid,
        ownerName: session?.name || "",
        memberUids: [uid],
        joinCode: code,
        status: "active",
        dailyTargets: { feeding: times.length, walk: walkTarget == null ? 2 : Math.max(0, Number(walkTarget) || 0) },
        feedingSchedule: { times, notes: (feedingSchedule?.notes || "").trim() },
        specialInstructions: specialInstructions || { allergy: "", medication: "", notes: "" },
        vet: { name: "", phone: "", emergencyPhone: "" },
        createdAt: fs.serverTimestamp()
      });

      /* the code → pet lookup a caretaker reads before they are a member */
      await fs.setDoc(fs.doc(db, "joinCodes", code), { petId, ownerUid: uid });

      await api.setSelectedPetId(petId);
      return petId;
    },

    /** Owner AND caretaker can edit a pet's details through this call —
        Firestore rules (memberDetailUpdate) are what actually enforce that
        neither can smuggle in an ownerUid/memberUids/status/joinCode
        change here; this client never needs to duplicate that check. */
    async updatePet(petId, patch) {
      await fs.updateDoc(fs.doc(db, "pets", petId), patch);
    },

    /** Soft delete — keeps every log, medication and caretaker record;
        just drops the pet from active lists and the selector. */
    async archivePet(petId) {
      await fs.updateDoc(fs.doc(db, "pets", petId), { status: "archived" });
    },

    /* ----------------------------------------------------------------
       Caretaker path: look the code up, add yourself to memberUids, then
       introduce yourself in the caretakers collection.

       Order matters. The rules let you add your OWN uid to memberUids
       without being a member yet; everything after that is a normal
       member write. This pet becomes just one more entry in myPets() —
       a caretaker can hold this on several pets, each independent.
       ---------------------------------------------------------------- */
    async joinWithCode(code, password) {
      const user = auth.currentUser;
      if (!user) throw new Error("You must be logged in to join a pet.");

      const cleanCode = normaliseCode(code);
      if (!cleanCode) throw new Error("Invalid care code.");
      if (!password)  throw new Error("Password verification failed.");

      /* 1. Password re-authentication using Firebase Auth */
      try {
        const cred = authMod.EmailAuthProvider.credential(user.email, password);
        await authMod.reauthenticateWithCredential(user, cred);
      } catch (err) {
        throw new Error("Password verification failed.");
      }

      /* 2. Look up code mapping */
      let snap;
      try {
        snap = await fs.getDoc(fs.doc(db, "joinCodes", cleanCode));
      } catch (err) {
        throw new Error("Invalid care code.");
      }
      if (!snap || !snap.exists()) throw new Error("Invalid care code.");

      const { petId } = snap.data();
      if (!petId) throw new Error("Invalid care code.");

      const petRef = fs.doc(db, "pets", petId);

      /* 3. Check for duplicate join on existing pet */
      try {
        const petSnap = await fs.getDoc(petRef);
        if (petSnap.exists()) {
          const members = Array.isArray(petSnap.data()?.memberUids) ? petSnap.data().memberUids : [];
          if (members.includes(user.uid)) {
            throw new Error("You already have access to this pet.");
          }
        }
      } catch (err) {
        if (err.message === "You already have access to this pet.") throw err;
      }

      /* 4. Atomically add UID to pet.memberUids */
      try {
        await fs.updateDoc(petRef, {
          memberUids: fs.arrayUnion(user.uid)
        });
      } catch (err) {
        console.error("updateDoc memberUids failed:", err);
        throw new Error("Could not join pet. Check code and try again.");
      }

      /* 5. Create caretaker document record */
      try {
        await fs.setDoc(fs.doc(db, "pets", petId, "caretakers", user.uid), {
          uid: user.uid,
          name:  session?.name || "",
          email: session?.email || "",
          role:  "caretaker",
          status: "active",
          note:  "Joined with a care code",
          addedAt: fs.serverTimestamp()
        }, { merge: true });
      } catch (err) {
        console.warn("caretaker doc creation warning:", err);
      }

      await api.setSelectedPetId(petId);
      return petId;
    },

    /* ---------------- which pet is currently open ----------------
       Synced through users/{uid} so switching devices keeps the same
       pet selected — a light convenience field, never used for access. */
    async getSelectedPetId() { return session?.lastSelectedPetId || null; },

    async setSelectedPetId(petId) {
      const uid = auth.currentUser.uid;
      await saveProfile(uid, { lastSelectedPetId: petId });
      session = { ...session, lastSelectedPetId: petId };
    }
  };

  return api;
}
