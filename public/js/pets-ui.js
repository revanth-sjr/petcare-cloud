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

  if (preview) {
    preview.style.cursor = "pointer";
    preview.title = "Click to edit framing or change photo";
    preview.addEventListener("click", () => {
      if (value) {
        openPhotoCropModal(
          value,
          (croppedDataUrl) => {
            value = croppedDataUrl;
            applyPreview();
            onChange?.(value, null);
          }
        );
      } else {
        input.click();
      }
    });
  }

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > maxSourceBytes) {
      input.value = "";
      onChange?.(null, "That photo is too large — pick a smaller file.");
      return;
    }
    openPhotoCropModal(
      file,
      (croppedDataUrl) => {
        value = croppedDataUrl;
        applyPreview();
        onChange?.(value, null);
      },
      () => {
        input.value = "";
      }
    );
  });

  clearBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
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

  const formatTime = (value) => {
    const [hour, minute] = value.split(":").map(Number);
    const suffix = hour >= 12 ? "PM" : "AM";
    const displayHour = hour % 12 || 12;
    return `${String(displayHour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${suffix}`;
  };

  const parseTime = (value) => {
    const match = String(value).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const suffix = match[3]?.toUpperCase();
    if (minute > 59) return null;
    if (suffix) {
      if (hour < 1 || hour > 12) return null;
      if (suffix === "PM" && hour < 12) hour += 12;
      if (suffix === "AM" && hour === 12) hour = 0;
    } else if (hour > 23) return null;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  };

  function render() {
    container.innerHTML = "";
    times.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "feed-time-row";
      row.innerHTML = `
        <span class="feed-time-label">${labelFn(i)}</span>
        <input type="text" class="feed-time-input" value="${formatTime(t)}" placeholder="08:00 AM" inputmode="numeric" aria-label="${labelFn(i)} time">
        <button type="button" class="icon-btn feed-time-remove" title="Remove this time" aria-label="Remove this time">✕</button>`;
      const input = row.querySelector(".feed-time-input");
      input.addEventListener("input", (e) => {
        const parsed = parseTime(e.target.value);
        if (parsed) times[i] = parsed;
      });
      input.addEventListener("blur", () => { input.value = formatTime(times[i]); });
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

/**
 * Opens an Instagram-style interactive photo crop and grid adjustment modal.
 * Features 3x3 grid overlay, drag/pan, zoom slider (1x-3x), rotate, focus presets,
 * and renders a high-quality 480x480 square JPEG data URL.
 */
export function openPhotoCropModal(imageSource, onSave, onCancel) {
  document.querySelectorAll(".crop-modal-backdrop").forEach((el) => el.remove());

  const backdrop = document.createElement("div");
  backdrop.className = "crop-modal-backdrop";
  backdrop.innerHTML = `
    <div class="crop-modal-card" role="dialog" aria-label="Adjust Photo Framing">
      <div class="crop-modal-header">
        <div class="crop-modal-title">
          <h3>Customize Pet Photo</h3>
          <p>Drag & zoom to center your pet's face inside the grid</p>
        </div>
        <button type="button" class="crop-close-btn" id="cropHeaderClose" aria-label="Close modal">&times;</button>
      </div>

      <div class="crop-viewport-wrap">
        <div class="crop-viewport" id="cropViewport">
          <img class="crop-img" id="cropImg" draggable="false" alt="Pet preview to crop" />
          <div class="crop-grid-overlay" id="cropGrid">
            <div class="crop-grid-cell"></div><div class="crop-grid-cell"></div><div class="crop-grid-cell"></div>
            <div class="crop-grid-cell"></div><div class="crop-grid-cell"></div><div class="crop-grid-cell"></div>
            <div class="crop-grid-cell"></div><div class="crop-grid-cell"></div><div class="crop-grid-cell"></div>
          </div>
          <div class="crop-avatar-mask" id="cropMask"></div>
        </div>
      </div>

      <div class="crop-controls">
        <div class="crop-slider-row">
          <span class="crop-slider-icon">🔍</span>
          <input type="range" class="crop-zoom-slider" id="cropZoom" min="1" max="3" step="0.02" value="1" aria-label="Zoom level">
          <span class="crop-zoom-label" id="cropZoomVal">100%</span>
        </div>

        <div class="crop-presets-row">
          <button type="button" class="crop-preset-btn" id="btnFocusHead" title="Center Head / Face">
            <span>👤 Head</span>
          </button>
          <button type="button" class="crop-preset-btn" id="btnFocusCenter" title="Center Photo">
            <span>🎯 Center</span>
          </button>
          <button type="button" class="crop-preset-btn" id="btnRotate" title="Rotate 90°">
            <span>🔄 Rotate</span>
          </button>
          <button type="button" class="crop-preset-btn" id="btnToggleGrid" title="Toggle Grid Overlay">
            <span>📐 Grid</span>
          </button>
        </div>
      </div>

      <div class="crop-modal-footer">
        <button type="button" class="btn btn-ghost" id="cropCancelBtn">Cancel</button>
        <button type="button" class="btn btn-primary" id="cropApplyBtn">✨ Apply Framing</button>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add("is-visible"));

  const img = backdrop.querySelector("#cropImg");
  const viewport = backdrop.querySelector("#cropViewport");
  const zoomSlider = backdrop.querySelector("#cropZoom");
  const zoomLabel = backdrop.querySelector("#cropZoomVal");
  const gridOverlay = backdrop.querySelector("#cropGrid");
  const maskOverlay = backdrop.querySelector("#cropMask");

  let scale = 1.0;
  let offsetX = 0;
  let offsetY = 0;
  let rotation = 0;
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let baseScale = 1.0;
  let naturalW = 1;
  let naturalH = 1;

  if (typeof imageSource === "string") {
    img.src = imageSource;
  } else if (imageSource instanceof File) {
    const objectUrl = URL.createObjectURL(imageSource);
    img.src = objectUrl;
  }

  img.onload = () => {
    naturalW = img.naturalWidth || 480;
    naturalH = img.naturalHeight || 480;
    resetTransform();
  };

  function getEffectiveDimensions() {
    const isRotated90 = (rotation / 90) % 2 !== 0;
    const w = isRotated90 ? naturalH : naturalW;
    const h = isRotated90 ? naturalW : naturalH;
    return { w, h };
  }

  function updateTransform() {
    const vWidth = viewport.clientWidth || 300;
    const vHeight = viewport.clientHeight || 300;
    const { w: effW, h: effH } = getEffectiveDimensions();

    baseScale = Math.max(vWidth / effW, vHeight / effH);
    const curW = effW * baseScale * scale;
    const curH = effH * baseScale * scale;

    const maxOffsetX = Math.max(0, (curW - vWidth) / 2);
    const maxOffsetY = Math.max(0, (curH - vHeight) / 2);

    offsetX = Math.max(-maxOffsetX, Math.min(maxOffsetX, offsetX));
    offsetY = Math.max(-maxOffsetY, Math.min(maxOffsetY, offsetY));

    img.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px)) rotate(${rotation}deg) scale(${baseScale * scale})`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    zoomSlider.value = scale;
  }

  function resetTransform() {
    scale = 1.0;
    offsetX = 0;
    offsetY = 0;
    rotation = 0;
    updateTransform();
  }

  function onPointerDown(e) {
    isDragging = true;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startX = clientX - offsetX;
    startY = clientY - offsetY;
    viewport.classList.add("is-grabbing");
  }

  function onPointerMove(e) {
    if (!isDragging) return;
    if (e.cancelable) e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    offsetX = clientX - startX;
    offsetY = clientY - startY;
    updateTransform();
  }

  function onPointerEnd() {
    isDragging = false;
    viewport.classList.remove("is-grabbing");
  }

  viewport.addEventListener("mousedown", onPointerDown);
  window.addEventListener("mousemove", onPointerMove);
  window.addEventListener("mouseup", onPointerEnd);

  viewport.addEventListener("touchstart", onPointerDown, { passive: false });
  window.addEventListener("touchmove", onPointerMove, { passive: false });
  window.addEventListener("touchend", onPointerEnd);

  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.08 : -0.08;
    scale = Math.max(1.0, Math.min(3.0, scale + delta));
    updateTransform();
  }, { passive: false });

  zoomSlider.addEventListener("input", (e) => {
    scale = parseFloat(e.target.value);
    updateTransform();
  });

  backdrop.querySelector("#btnFocusCenter").addEventListener("click", () => {
    offsetX = 0;
    offsetY = 0;
    scale = 1.0;
    updateTransform();
  });

  backdrop.querySelector("#btnFocusHead").addEventListener("click", () => {
    scale = 1.35;
    const vHeight = viewport.clientHeight || 300;
    const { h: effH } = getEffectiveDimensions();
    const curH = effH * baseScale * scale;
    const maxOffsetY = Math.max(0, (curH - vHeight) / 2);
    offsetY = maxOffsetY * 0.7;
    offsetX = 0;
    updateTransform();
  });

  backdrop.querySelector("#btnRotate").addEventListener("click", () => {
    rotation = (rotation + 90) % 360;
    updateTransform();
  });

  let gridMode = 0;
  backdrop.querySelector("#btnToggleGrid").addEventListener("click", () => {
    gridMode = (gridMode + 1) % 3;
    gridOverlay.style.display = gridMode === 0 ? "grid" : "none";
    maskOverlay.style.display = gridMode === 1 ? "block" : "none";
  });

  function cleanupListeners() {
    window.removeEventListener("mousemove", onPointerMove);
    window.removeEventListener("mouseup", onPointerEnd);
    window.removeEventListener("touchmove", onPointerMove);
    window.removeEventListener("touchend", onPointerEnd);
  }

  function close(cancel = false) {
    cleanupListeners();
    backdrop.classList.remove("is-visible");
    setTimeout(() => backdrop.remove(), 200);
    if (cancel) onCancel?.();
  }

  backdrop.querySelector("#cropHeaderClose").addEventListener("click", () => close(true));
  backdrop.querySelector("#cropCancelBtn").addEventListener("click", () => close(true));
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close(true);
  });

  backdrop.querySelector("#cropApplyBtn").addEventListener("click", () => {
    const canvasSize = 480;
    const vSize = viewport.clientWidth || 300;
    const factor = canvasSize / vSize;

    const canvas = document.createElement("canvas");
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    ctx.save();
    ctx.translate(canvasSize / 2 + offsetX * factor, canvasSize / 2 + offsetY * factor);
    ctx.rotate((rotation * Math.PI) / 180);

    const drawW = naturalW * baseScale * scale * factor;
    const drawH = naturalH * baseScale * scale * factor;

    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();

    cleanupListeners();
    const croppedDataUrl = canvas.toDataURL("image/jpeg", 0.88);
    close(false);
    onSave(croppedDataUrl);
  });
}

