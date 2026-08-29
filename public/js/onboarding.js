/* =====================================================================
   onboarding.js — first-run and "add another pet" flow.
   Pod A owns this file.
   ---------------------------------------------------------------------
   ?mode=first  → Welcome → Add Pet → (add another?) → Finish → Home
   ?mode=add    → straight to Add Pet, used by "+ Add pet" on the Home
                  page once someone already has at least one pet.

   Onboarding is considered "done" purely by having at least one pet —
   there is no separate onboardingCompleted flag to go stale. Skipping
   here just drops the person onto the Home page's own empty state,
   which offers the same Add Pet screen again with no separate code
   path.
   ===================================================================== */

import { $, $$, toast, esc } from "./ui.js";
import { initAuth, speciesMeta, validatePetForm } from "./auth.js";
import { wireSpeciesGrid, wireBreedSelect, wireFeedingScheduleEditor, wirePhotoPicker } from "./pets-ui.js";

let auth = null;
let session = null;
let species = null;
let breed = null;
let feeding = null;
let photo = null;
let addedCount = 0;
let firstPetId = null;   // createPet() auto-selects whichever pet it just made,
                          // so "add another" would leave the LAST pet selected —
                          // Finish deliberately puts the FIRST one back on screen.

const mode = new URLSearchParams(location.search).get("mode") || "first";

boot();

async function boot() {
  auth = await initAuth();
  session = await auth.ready;

  if (!session) { window.location.replace("./login.html"); return; }

  $("#boot").hidden = true;

  breed = wireBreedSelect($("#fBreed"), $("#fBreedOtherWrap"), $("#fBreedOther"), $("#fBreedLabel"));
  species = wireSpeciesGrid($("#speciesGrid"), (id) => breed.populate(id));
  feeding = wireFeedingScheduleEditor($("#feedingTimesEditor"));
  photo = wirePhotoPicker({
    input: $("#fPhoto"),
    preview: $("#photoPreview"),
    clearBtn: $("#photoClear"),
    onChange: (_, err) => { if (err) toast(err, "err"); }
  });

  wireWelcome();
  wireForm();
  wireAdded();

  if (mode === "add") {
    $("#onbProgress").hidden = true;
    showScreen("screenAddPet");
  } else {
    showScreen("screenWelcome");
  }
}

/* ------------------------------------------------------------------ */
function showScreen(id) {
  $$(".onb-screen").forEach((s) => { s.hidden = s.id !== id; });
  $$(".onb-dot").forEach((d) => {
    d.classList.toggle("is-on", id === "screenPetAdded" || (id === "screenAddPet" && d.dataset.step === "profile"));
  });
}

function wireWelcome() {
  $("#btnGetStarted").addEventListener("click", () => {
    $("#onbProgress").hidden = false;
    showScreen("screenAddPet");
  });
  $("#btnSkip").addEventListener("click", () => window.location.replace("./home.html"));
}

function resetForm() {
  $("#petForm").reset();
  species.reset();
  breed.populate(null);
  feeding.set(null);
  photo.set("");
  hideFormError();
}

/* ------------------------------------------------------------------ */
function wireForm() {
  $("#petForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const payload = {
      name: $("#fName").value.trim(),
      species: species.get(),
      breed: breed.get(),
      ageYears: $("#fAge").value,
      gender: $("#fGender").value,
      weightKg: $("#fWeight").value,
      photoURL: photo.get(),
      feedingSchedule: { times: feeding.get(), notes: "" },
      walkTarget: $("#fWalkTarget").value,
      specialInstructions: { allergy: "", medication: "", notes: $("#fNotes").value.trim() }
    };

    const problem = validatePetForm(payload);
    if (problem) return showFormError(problem);

    const btn = $("#petFormSubmit");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Saving…";
    hideFormError();

    try {
      const petId = await auth.createPet(payload);
      if (!firstPetId) firstPetId = petId;
      addedCount++;
      showAdded(payload);
    } catch (err) {
      showFormError(err.message || "Could not save that pet. Try again.");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

function showFormError(msg) {
  const el = $("#petFormError");
  el.textContent = msg;
  el.hidden = false;
}
function hideFormError() { $("#petFormError").hidden = true; }

/* ------------------------------------------------------------------ */
function wireAdded() {
  $("#btnAddAnother").addEventListener("click", () => {
    resetForm();
    showScreen("screenAddPet");
  });
  $("#btnFinish").addEventListener("click", async () => {
    if (firstPetId) {
      try { await auth.setSelectedPetId(firstPetId); } catch { /* index.html falls back to pets[0] anyway */ }
    }
    window.location.replace("./home.html");
  });
}

function showAdded(pet) {
  $("#addedName").textContent = pet.name;
  const meta = speciesMeta(pet.species);

  $("#petPreviewCard").innerHTML = `
    <div class="pet-preview-avatar"${pet.photoURL ? ` style="background-image:url(${esc(pet.photoURL)})"` : ""}>
      ${pet.photoURL ? "" : meta.icon}
    </div>
    <div class="pet-preview-info">
      <b>${esc(pet.name)}</b>
      <p>${esc([meta.label, pet.breed, pet.ageYears ? `${pet.ageYears} yr` : ""].filter(Boolean).join(" · "))}</p>
    </div>`;

  const tally = $("#addedTally");
  if (addedCount > 1) {
    tally.hidden = false;
    tally.textContent = `${addedCount} pets added so far.`;
  } else {
    tally.hidden = true;
  }

  showScreen("screenPetAdded");
}
