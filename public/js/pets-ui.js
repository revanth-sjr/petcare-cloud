/* =====================================================================
   pets-ui.js — shared species-grid + photo-picker widgets.
   Pod A owns this file.
   ---------------------------------------------------------------------
   Both onboarding.js (add a pet) and app.js (edit a pet) need the exact
   same species chip grid and photo-to-dataURL picker. Sharing one
   implementation means the two forms can never quietly drift apart.
   ===================================================================== */

import { SPECIES, speciesMeta, breedOptions } from "./auth.js";

/**
 * Renders pet-type chips into `grid`. Picking one is step 1 of the
 * cascade — the caller's `onSelect(id)` is where step 2 (populating the
 * breed select below it) happens, via wireBreedSelect().
 * Returns { get, set, reset } so the caller can read/drive the selection.
 */
export function wireSpeciesGrid(grid, onSelect) {
  let selected = null;
  grid.innerHTML = "";

  for (const s of SPECIES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "species-chip";
    btn.dataset.species = s.id;
    btn.innerHTML = `<span class="species-icon">${s.icon}</span><span>${s.label}</span>`;
    btn.addEventListener("click", () => set(s.id));
    grid.appendChild(btn);
  }

  function set(id) {
    selected = id;
    [...grid.children].forEach((b) => b.classList.toggle("is-on", b.dataset.species === id));
    onSelect?.(id);
  }

  function reset() {
    selected = null;
    [...grid.children].forEach((b) => b.classList.remove("is-on"));
    onSelect?.(null);
  }

  return { get: () => selected, set, reset };
}

/**
 * Step 2 of the cascade: a breed <select> whose options depend on
 * whichever pet type was just chosen, always ending in "Other" — which
 * reveals a free-text input rather than forcing an unlisted breed into
 * the wrong bucket. `labelEl` (optional) gets the type's own label for
 * the field, e.g. "Bird type" instead of "Breed".
 */
export function wireBreedSelect(selectEl, customWrapEl, customInputEl, labelEl) {
  selectEl.addEventListener("change", () => {
    const isOther = selectEl.value === "Other";
    if (customWrapEl) customWrapEl.hidden = !isOther;
    if (isOther) customInputEl?.focus();
  });

  /** Call when the pet type changes — rebuilds the option list. */
  function populate(speciesId) {
    selectEl.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = ""; blank.textContent = speciesId ? "Select…" : "Choose a pet type first";
    selectEl.appendChild(blank);

    if (speciesId) {
      for (const b of breedOptions(speciesId)) {
        const opt = document.createElement("option");
        opt.value = b; opt.textContent = b;
        selectEl.appendChild(opt);
      }
    }
    selectEl.disabled = !speciesId;
    selectEl.value = "";
    if (labelEl) labelEl.textContent = speciesId ? speciesMeta(speciesId).breedLabel : "Breed";
    if (customWrapEl) customWrapEl.hidden = true;
    if (customInputEl) customInputEl.value = "";
  }

  /** "Other" resolves to the free-text value; anything else is the pick itself. */
  function get() {
    if (selectEl.value === "Other") return (customInputEl?.value || "").trim();
    return selectEl.value;
  }

  /** Pre-fills from a stored breed string — falls back to "Other" +
      free text when the value isn't in the current type's curated list
      (e.g. it was typed in before the list existed, or the pet's type
      changed since). */
  function set(breedValue) {
    const known = [...selectEl.options].some((o) => o.value === breedValue && breedValue !== "");
    if (breedValue && !known) {
      if (![...selectEl.options].some((o) => o.value === "Other")) return; // no type chosen yet
      selectEl.value = "Other";
      if (customWrapEl) customWrapEl.hidden = false;
      if (customInputEl) customInputEl.value = breedValue;
    } else {
      selectEl.value = breedValue || "";
      if (customWrapEl) customWrapEl.hidden = true;
    }
  }

  return { populate, get, set };
}

/**
 * Wires a file input to a live circular preview and an optional clear
 * button, resolving the chosen photo to a data URL kept entirely
 * client-side — no Storage bucket required for the demo path (point 16
 * in the spec: Storage if configured, else a local/default avatar).
 *
 * The photo is downscaled and re-encoded as JPEG before it ever becomes
 * a data URL. Firestore caps a whole document at 1MiB, and a phone photo
 * routinely arrives at several MB — without this, "add a profile photo"
 * would work fine in demo mode and then fail silently in live mode the
 * first time someone picked a real camera photo.
 */
export function wirePhotoPicker({ input, preview, clearBtn, onChange, maxSourceBytes = 20 * 1024 * 1024 }) {
  let value = "";

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > maxSourceBytes) {
      input.value = "";
      onChange?.(null, "That photo is too large — pick a smaller file.");
      return;
    }
    try {
      value = await fileToCompressedDataUrl(file);
      applyPreview();
      onChange?.(value, null);
    } catch {
      input.value = "";
      onChange?.(null, "Could not read that photo — try a different file.");
    }
  });

  clearBtn?.addEventListener("click", () => {
    value = "";
    input.value = "";
    applyPreview();
    onChange?.("", null);
  });

  function applyPreview() {
    if (value) {
      preview.style.backgroundImage = `url(${value})`;
      preview.textContent = "";
      if (clearBtn) clearBtn.hidden = false;
    } else {
      preview.style.backgroundImage = "";
      preview.textContent = "🐾";
      if (clearBtn) clearBtn.hidden = true;
    }
  }

  function set(dataUrl) { value = dataUrl || ""; applyPreview(); }

  return { get: () => value, set };
}

/**
 * A generic add/remove/edit time-list editor: no separate "times per
 * day" field to keep in sync — the count IS the list. Backs both the
 * per-pet feeding schedule (default labelFn: Breakfast/Lunch/Dinner,
 * matching how most owners actually think about meals) and, with a
 * different labelFn, a medication's own scheduled doses.
 */
export function wireFeedingScheduleEditor(container, {
  defaultTimes = ["08:00", "13:00", "19:00"],
  labelFn = (i) => ["Breakfast", "Lunch", "Dinner"][i] || `Feed ${i + 1}`,
  addLabel = "+ Add a feeding time"
} = {}) {
  let times = [...defaultTimes];

  function render() {
    container.innerHTML = "";
    times.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "feed-time-row";
      row.innerHTML = `
        <span class="feed-time-label">${labelFn(i)}</span>
        <input type="time" class="feed-time-input" value="${t}">
        <button type="button" class="icon-btn feed-time-remove" title="Remove this time" aria-label="Remove this time">✕</button>`;
      row.querySelector(".feed-time-input").addEventListener("input", (e) => { times[i] = e.target.value || times[i]; });
      row.querySelector(".feed-time-remove").addEventListener("click", () => {
        if (times.length <= 1) return;   // always at least one feeding time
        times.splice(i, 1);
        render();
      });
      container.appendChild(row);
    });

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn btn-ghost btn-sm feed-time-add";
    addBtn.textContent = addLabel;
    addBtn.addEventListener("click", () => {
      const [h, m] = (times[times.length - 1] || "12:00").split(":").map(Number);
      times.push(`${String((h + 3) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
      render();
    });
    container.appendChild(addBtn);
  }

  function set(list) { times = list && list.length ? [...list] : [...defaultTimes]; render(); }
  function get() { return [...times].sort(); }

  render();
  return { set, get };
}

/** Downscales to at most `maxDim` on the long edge and re-encodes as
    JPEG, so the resulting data URL comfortably fits inside a Firestore
    document however large the source photo was. */
function fileToCompressedDataUrl(file, { maxDim = 480, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const c = canvas.getContext("2d");
      c.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("Could not decode that image.")); };
    img.src = objectUrl;
  });
}
