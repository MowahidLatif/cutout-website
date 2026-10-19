/**
 * Page logic for the studio on index.html: upload up to 10 photos, give each
 * its own size, text, material and quantity, see the selected one to scale
 * against a wall, see the live price for all of them, and add them to the
 * cart in one go.
 *
 * Prices shown here come from js/pricing.js + GET /api/pricing-config and
 * are only for instant feedback — the backend recomputes everything
 * (including the size tier, from the height) when the order is placed.
 */
(function () {
  const SITE = window.SITE;

  /** A fresh set of design settings (also used before any photo is added). */
  function defaultSettings() {
    return {
      heightIn: SITE.defaultHeightIn,
      lockProportions: true,
      manualWidthIn: 24,
      texts: [], // [{ style, text }]
      material: SITE.materials.find((m) => !m.comingSoon).id,
      quantity: 1,
      removeBackground: true, // per photo; the customer can switch it off
    };
  }

  const state = {
    pricingConfig: null, // { currency, rates, discountTiers, shippingRates }
    // One design per photo:
    // { id, name, file, objectUrl, src, aspect, isSample, uploadPromise, imageKey,
    //   uploadError, ...settings,
    //   original: { key, src }, cutout: { key, src } | null,   // the two printable versions
    //   bgStatus: null | "processing" | "done" | "failed", bgProgress }
    // `imageKey` / `src` always point at the version the customer chose.
    designs: [],
    activeId: null,
    // Settings edited before any photo is added; new photos start from these.
    draft: defaultSettings(),
    reference: "person",
    photoCounter: 0,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    input: $("photo-input"),
    heroDropzone: $("hero-dropzone"),
    tray: $("photo-tray"),
    traySummary: $("tray-summary"),
    trayList: $("tray-list"),
    trayMessage: $("tray-message"),
    stage: $("stage"),
    wall: $("stage-wall"),
    grid: $("stage-grid"),
    ruler: $("stage-ruler"),
    ref: $("stage-ref"),
    refPerson: $("ref-person"),
    refDoor: $("ref-door"),
    refLabel: $("ref-label"),
    figure: $("stage-figure"),
    img: $("stage-img"),
    texts: $("stage-texts"),
    stageDropzone: $("stage-dropzone"),
    sampleTag: $("sample-tag"),
    photoActions: $("photo-actions"),
    photoStatus: $("photo-status"),
    replacePhoto: $("replace-photo"),
    gridToggle: $("grid-toggle"),
    fullscreenToggle: $("fullscreen-toggle"),
    heightReadout: $("height-readout"),
    heightFt: $("height-ft"),
    heightInches: $("height-in"),
    heightRange: $("height-range"),
    widthReadout: $("width-readout"),
    widthInputs: $("width-inputs"),
    widthFt: $("width-ft"),
    widthInches: $("width-in"),
    widthHint: $("width-hint"),
    qualityRow: $("quality-row"),
    bgRow: $("bg-row"),
    removeBg: $("remove-bg"),
    bgHint: $("bg-hint"),
    stageBusy: $("stage-busy"),
    stageBusyText: $("stage-busy-text"),
    qualityBadge: $("quality-badge"),
    qualityTip: $("quality-tip"),
    qualityConsent: $("quality-consent"),
    acceptLowQuality: $("accept-low-quality"),
    lockToggle: $("lock-toggle"),
    addText: $("add-text"),
    textList: $("text-list"),
    materialOptions: $("material-options"),
    priceLabel: $("price-label"),
    priceTotal: $("price-total"),
    priceLines: $("price-lines"),
    qty: $("qty"),
    qtyLabel: $("qty-label"),
    discountTag: $("discount-tag"),
    deliveryTitle: $("delivery-title"),
    deliverySub: $("delivery-sub"),
    addToCart: $("add-to-cart"),
    addToCartLabel: $("add-to-cart-label"),
    priceNote: $("price-note"),
  };

  // ---------- Helpers ----------
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  function formatFeetInches(inches) {
    const total = Math.round(inches);
    return `${Math.floor(total / 12)}'${total % 12}"`;
  }

  function formatCurrency(n) {
    return "$" + Number(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function addBusinessDays(date, days) {
    const d = new Date(date);
    let added = 0;
    while (added < days) {
      d.setDate(d.getDate() + 1);
      const day = d.getDay();
      if (day !== 0 && day !== 6) added += 1;
    }
    return d;
  }

  function formatDay(date) {
    return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function browserCanPreview(file) {
    const name = (file.name || "").toLowerCase();
    if (file.type === "application/pdf" || name.endsWith(".pdf")) return false;
    if (/hei[cf]/.test(file.type) || /\.hei[cf]$/.test(name)) return false;
    return true;
  }

  /** Print quality at the current size, once the server has measured the photo. */
  function qualityOf(design) {
    if (!design.widthPx || !design.heightPx) return null;
    return Pricing.printQuality({
      widthPx: design.widthPx,
      heightPx: design.heightPx,
      heightIn: design.heightIn,
      widthIn: widthOf(design),
    });
  }

  function needsLowQualityOk(design) {
    const q = qualityOf(design);
    return Boolean(q && q.grade === "low" && !design.acceptedLowQuality);
  }

  /** The design the controls are editing (or the draft, before any photo). */
  function active() {
    return state.designs.find((d) => d.id === state.activeId) || state.draft;
  }

  /** Designs that can actually be ordered (real photos, not the sample). */
  function realDesigns() {
    return state.designs.filter((d) => !d.isSample);
  }

  /** The printed width: from the photo's proportions, or the customer's own value. */
  function widthOf(design) {
    if (!design.lockProportions) return design.manualWidthIn;
    if (!design.aspect) return null;
    return Math.round(design.heightIn * design.aspect * 2) / 2;
  }

  function widthProblem(design) {
    const w = widthOf(design);
    if (w === null) return null;
    if (w > SITE.widthMaxIn) {
      return `At this height the photo would be ${formatFeetInches(w)} wide — the maximum is ${SITE.widthMaxIn / 12} ft. Lower the height or unlock proportions.`;
    }
    if (w < SITE.widthMinIn) {
      return `At this height the photo would be only ${Math.round(w)}" wide — the minimum is ${SITE.widthMinIn}". Increase the height.`;
    }
    return null;
  }

  // ---------- Order limits (tray + what's already in the cart) ----------
  function cartTotals() {
    return Cart.totals();
  }

  function trayQuantity(except) {
    return realDesigns()
      .filter((d) => d !== except)
      .reduce((sum, d) => sum + d.quantity, 0);
  }

  /** Highest quantity this design can have without the order passing 500. */
  function maxQuantityFor(design) {
    const others = cartTotals().quantity + trayQuantity(design);
    return Math.max(design.quantity, Math.max(1, SITE.maxOrderQuantity - others));
  }

  function photoSlotsLeft() {
    return SITE.maxUniqueImages - cartTotals().uniqueImages - realDesigns().length;
  }

  function quantityOptions(selected, max) {
    let html = "";
    for (let n = 1; n <= max; n++) {
      html += `<option value="${n}"${n === selected ? " selected" : ""}>${n}</option>`;
    }
    return html;
  }

  // ---------- Adding photos ----------
  function openPicker() {
    els.input.click();
  }

  function wireDropzone(zone, { scrollToStudio }) {
    zone.addEventListener("click", () => {
      pickerFromHero = scrollToStudio;
      openPicker();
    });
    zone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pickerFromHero = scrollToStudio;
        openPicker();
      }
    });
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("is-dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-dragover"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("is-dragover");
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files);
        if (scrollToStudio) scrollToStudioSection();
      }
    });
  }

  let pickerFromHero = false;
  els.replacePhoto.addEventListener("click", () => {
    pickerFromHero = false;
    openPicker();
  });

  els.input.addEventListener("change", () => {
    if (els.input.files && els.input.files.length) {
      addFiles(els.input.files);
      if (pickerFromHero) scrollToStudioSection();
    }
    els.input.value = ""; // allow re-choosing the same files
  });

  function scrollToStudioSection() {
    document.getElementById("studio").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function readAspect(src) {
    return new Promise((resolve, reject) => {
      const probe = new Image();
      probe.onload = () => resolve(probe.naturalWidth / probe.naturalHeight);
      probe.onerror = () => reject(new Error("That file couldn't be opened as an image."));
      probe.src = src;
    });
  }

  function newDesign(fields) {
    state.photoCounter += 1;
    const base = state.designs.length ? defaultSettings() : { ...state.draft, texts: state.draft.texts.map((t) => ({ ...t })) };
    return {
      id: `d${Date.now().toString(36)}${state.photoCounter}`,
      name: `Photo ${state.photoCounter}`,
      file: null,
      objectUrl: null,
      src: null,
      aspect: null,
      isSample: false,
      uploadPromise: null,
      imageKey: null,
      uploadError: null,
      widthPx: null, // processed image size, from the server
      heightPx: null,
      note: null, // e.g. "Your PDF has 3 pages — we'll print page 1."
      acceptedLowQuality: false,
      original: null,
      cutout: null,
      bgStatus: null,
      bgProgress: null,
      ...base,
      ...fields,
    };
  }

  /** Adds photos to the tray, up to the order limits, and starts their uploads. */
  function addFiles(fileList) {
    hideTrayMessage();
    // A real photo replaces the sample.
    state.designs.filter((d) => d.isSample).forEach(removeDesign);

    const files = Array.from(fileList);
    let added = 0;
    let skippedForPhotos = 0;
    let skippedForQuantity = 0;
    for (const file of files) {
      if (photoSlotsLeft() <= 0) {
        skippedForPhotos += 1;
        continue;
      }
      if (cartTotals().quantity + trayQuantity() + 1 > SITE.maxOrderQuantity) {
        skippedForQuantity += 1;
        continue;
      }
      const design = newDesign({ file, objectUrl: URL.createObjectURL(file) });
      // Browsers can't display PDFs or HEIC as images: those show
      // "Processing…" until the server's converted preview arrives.
      if (browserCanPreview(file)) design.src = design.objectUrl;
      // The first photo of a batch keeps the draft's quantity; later ones start at 1,
      // trimmed if needed so the order stays within the total.
      design.quantity = clamp(design.quantity, 1, Math.max(1, SITE.maxOrderQuantity - cartTotals().quantity - trayQuantity()));
      state.designs.push(design);
      if (added === 0) state.activeId = design.id;
      added += 1;
      startUpload(design);
      if (design.src) {
        readAspect(design.objectUrl).then(
          (aspect) => {
            if (!design.widthPx) design.aspect = aspect;
            renderAll();
          },
          () => {}
        );
      }
    }

    const notes = [];
    if (skippedForPhotos) {
      notes.push(
        `Only ${SITE.maxUniqueImages} different photos per order (counting your cart) — ${plural(skippedForPhotos, "photo")} weren't added.`
      );
    }
    if (skippedForQuantity) {
      notes.push(`An order can have at most ${SITE.maxOrderQuantity} cutouts — ${plural(skippedForQuantity, "photo")} weren't added.`);
    }
    if (notes.length) showTrayMessage(notes.join(" "));
    renderAll();
  }

  function startUpload(design) {
    if (design.file.size > SITE.maxUploadMb * 1024 * 1024) {
      design.uploadError = `That file is too large. The maximum is ${SITE.maxUploadMb} MB.`;
      return;
    }
    const formData = new FormData();
    formData.append("image", design.file);
    // The backend checks type, size and resolution, fixes phone rotation,
    // and returns the key the order refers to the photo by.
    design.uploadPromise = Api.upload("/uploads", formData).then(
      (result) => {
        design.imageKey = result.imageKey;
        // The server's version is what gets printed (rotated, converted from
        // PDF/HEIC), so show it and measure quality from its real pixel size.
        design.widthPx = result.width;
        design.heightPx = result.height;
        design.aspect = result.width / result.height;
        design.src = result.previewUrl;
        design.note = result.note || null;
        design.original = { key: result.imageKey, src: result.previewUrl };
        if (design.removeBackground) startBackgroundRemoval(design);
        renderAll();
      },
      (err) => {
        design.uploadError = err.message;
        renderAll();
      }
    );
  }

  function removeDesign(design) {
    if (design.objectUrl) URL.revokeObjectURL(design.objectUrl);
    if (design.cutout) URL.revokeObjectURL(design.cutout.src);
    const index = state.designs.indexOf(design);
    state.designs.splice(index, 1);
    if (state.activeId === design.id) {
      const next = state.designs[index] || state.designs[index - 1];
      state.activeId = next ? next.id : null;
    }
  }

  async function loadSample() {
    if (realDesigns().length) {
      scrollToStudioSection();
      return;
    }
    state.designs.filter((d) => d.isSample).forEach(removeDesign);
    const design = newDesign({ isSample: true, src: "img/sample.svg", name: "Sample" });
    try {
      design.aspect = await readAspect(design.src);
    } catch (e) {
      design.aspect = 0.4;
    }
    state.designs.push(design);
    state.activeId = design.id;
    renderAll();
    scrollToStudioSection();
  }

  document.querySelectorAll("[data-try-sample]").forEach((btn) => btn.addEventListener("click", loadSample));
  wireDropzone(els.heroDropzone, { scrollToStudio: true });
  wireDropzone(els.stageDropzone, { scrollToStudio: false });

  function showTrayMessage(message) {
    els.trayMessage.textContent = message;
    els.trayMessage.classList.add("visible");
  }

  function hideTrayMessage() {
    els.trayMessage.classList.remove("visible");
  }

  // ---------- Background removal (in the browser, js/background-removal.js) ----------
  /** Points imageKey/src at the version the customer chose (cutout or original). */
  function applyBackgroundChoice(design) {
    const version = design.removeBackground && design.cutout ? design.cutout : design.original;
    if (version) {
      design.imageKey = version.key;
      design.src = version.src;
    }
  }

  function backgroundProgressText(d) {
    const p = d.bgProgress;
    if (p && p.phase === "downloading") return `Downloading the background remover (first time only)… ${p.percent}%`;
    if (p && p.phase === "queued") return "Waiting to remove background…";
    return "Removing background…";
  }

  function backgroundLabel(d) {
    if (d.bgStatus === "processing") return "Background: removing…";
    if (d.bgStatus === "failed") return "Background: kept (removal failed)";
    if (!d.removeBackground) return "Background: kept";
    return d.cutout ? "✓ Background removed" : "Background: kept";
  }

  /**
   * Cuts the photo out from the server's processed version (already upright
   * and converted from PDF/HEIC, so the cutout matches what's printed), then
   * uploads the transparent PNG as the print file. On failure the original is
   * kept and the customer is told.
   */
  async function startBackgroundRemoval(design) {
    if (design.isSample || !design.original || design.bgStatus === "processing") return;
    if (design.cutout) {
      applyBackgroundChoice(design);
      return;
    }
    if (!window.BackgroundRemoval || !BackgroundRemoval.isSupported()) {
      return backgroundFailed(design, "this browser can't run it");
    }
    hideTrayMessage();
    design.bgStatus = "processing";
    design.bgProgress = null;
    renderAll();
    try {
      const blob = await BackgroundRemoval.remove(design.original.src, {
        onStatus: (status) => {
          design.bgProgress = status;
          renderTray();
          renderStage();
        },
      });
      if (!state.designs.includes(design)) return; // removed while processing
      const formData = new FormData();
      formData.append("image", new File([blob], "cutout.png", { type: "image/png" }));
      const result = await Api.upload("/uploads", formData);
      design.cutout = { key: result.imageKey, src: URL.createObjectURL(blob) };
      design.bgStatus = "done";
      applyBackgroundChoice(design);
      renderAll();
    } catch (err) {
      // Technical detail goes to the console; the customer gets a plain notice.
      console.warn("Background removal failed:", err);
      backgroundFailed(design, null);
    }
  }

  function backgroundFailed(design, reason) {
    if (!state.designs.includes(design)) return;
    design.bgStatus = "failed";
    design.removeBackground = false;
    applyBackgroundChoice(design);
    showTrayMessage(
      `We couldn't remove the background from ${design.name}${reason ? ` (${reason})` : ""} — we'll print it as uploaded. ` +
        "You can try again from its photo card."
    );
    renderAll();
  }

  // ---------- Tray ----------
  function designStatus(d) {
    if (d.isSample) return "Sample — preview only";
    if (d.uploadError) return d.uploadError;
    if (!d.imageKey) return d.src ? "Uploading…" : "Processing…";
    if (d.bgStatus === "processing") return backgroundProgressText(d);
    if (widthProblem(d)) return "Check the size";
    const q = qualityOf(d);
    if (q) {
      const label = `Quality ${q.score}/100 · ${SITE.qualityLabels[q.grade]}`;
      return needsLowQualityOk(d) ? `${label} — confirm` : label;
    }
    return "✓ Uploaded";
  }

  function renderTray() {
    const show = state.designs.length > 0;
    els.tray.hidden = !show;
    if (!show) {
      els.trayList.innerHTML = "";
      return;
    }

    const real = realDesigns();
    const qty = trayQuantity();
    els.traySummary.textContent = real.length
      ? `${plural(real.length, "photo")} · ${plural(qty, "cutout")}`
      : "Sample photo";

    const cards = state.designs
      .map((d) => {
        const status = designStatus(d);
        const hasError = Boolean(d.uploadError || (!d.isSample && (widthProblem(d) || needsLowQualityOk(d))));
        return `
        <div class="tray-card${d.id === state.activeId ? " is-active" : ""}${hasError ? " has-error" : ""}" data-id="${d.id}" role="listitem">
          <button type="button" class="tray-card__select" aria-pressed="${d.id === state.activeId}" aria-label="Edit ${escapeHtml(d.name)}">
            <span class="tray-card__thumb-wrap${d.cutout && d.removeBackground ? " is-cutout" : ""}">
              ${
                d.src
                  ? `<img class="tray-card__thumb" src="${escapeHtml(d.src)}" alt="" />`
                  : '<span class="tray-card__thumb tray-card__thumb--processing">Processing…</span>'
              }
              ${d.bgStatus === "processing" ? '<span class="spinner-overlay" aria-hidden="true"><span class="spinner"></span></span>' : ""}
            </span>
            <span class="tray-card__name">${escapeHtml(d.name)}</span>
            <span class="tray-card__status">${escapeHtml(status)}</span>
            ${d.isSample || !d.imageKey ? "" : `<span class="tray-card__bg">${escapeHtml(backgroundLabel(d))}</span>`}
          </button>
          ${
            d.bgStatus === "failed"
              ? `<button type="button" class="link-accent tray-card__retry" data-retry-bg>Try removing the background again</button>`
              : ""
          }
          ${
            d.isSample
              ? ""
              : `<label class="tray-card__qty">Qty
                  <select data-qty aria-label="Quantity for ${escapeHtml(d.name)}">${quantityOptions(d.quantity, maxQuantityFor(d))}</select>
                </label>`
          }
          <button type="button" class="icon-btn tray-card__remove" data-remove aria-label="Remove ${escapeHtml(d.name)}">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </div>`;
      })
      .join("");

    const addTile =
      photoSlotsLeft() > 0
        ? `<button type="button" class="tray-add" data-add-photos>
             <svg class="icon"><use href="#i-plus"/></svg>Add photos
             <span class="hint">${plural(photoSlotsLeft(), "more photo")} allowed</span>
           </button>`
        : "";
    els.trayList.innerHTML = cards + addTile;
  }

  els.trayList.addEventListener("click", (e) => {
    if (e.target.closest("[data-add-photos]")) {
      pickerFromHero = false;
      openPicker();
      return;
    }
    const card = e.target.closest(".tray-card");
    if (!card) return;
    const design = state.designs.find((d) => d.id === card.dataset.id);
    if (!design) return;
    if (e.target.closest("[data-retry-bg]")) {
      design.removeBackground = true;
      startBackgroundRemoval(design);
      renderAll();
      return;
    }
    if (e.target.closest("[data-remove]")) {
      removeDesign(design);
      hideTrayMessage();
      renderAll();
    } else if (e.target.closest(".tray-card__select")) {
      state.activeId = design.id;
      renderTextList();
      renderMaterials();
      renderAll();
    }
  });

  els.trayList.addEventListener("change", (e) => {
    if (!e.target.matches("[data-qty]")) return;
    const design = state.designs.find((d) => d.id === e.target.closest(".tray-card").dataset.id);
    if (design) setQuantity(design, Number(e.target.value));
  });

  // ---------- Size controls (edit the active design) ----------
  function setHeight(inches) {
    active().heightIn = clamp(Math.round(inches), SITE.heightMinIn, SITE.heightMaxIn);
    render();
  }

  els.heightRange.addEventListener("input", () => setHeight(Number(els.heightRange.value)));
  els.heightRange.addEventListener("change", renderTray);
  [els.heightFt, els.heightInches].forEach((input) =>
    input.addEventListener("change", () => {
      const ft = Number(els.heightFt.value) || 0;
      const inch = clamp(Number(els.heightInches.value) || 0, 0, 11);
      setHeight(ft * 12 + inch);
      renderTray();
    })
  );

  els.lockToggle.addEventListener("change", () => {
    const d = active();
    if (!els.lockToggle.checked) {
      d.manualWidthIn = clamp(Math.round(widthOf(d) || 24), SITE.widthMinIn, SITE.widthMaxIn);
    }
    d.lockProportions = els.lockToggle.checked;
    renderAll();
  });

  [els.widthFt, els.widthInches].forEach((input) =>
    input.addEventListener("change", () => {
      const ft = Number(els.widthFt.value) || 0;
      const inch = clamp(Number(els.widthInches.value) || 0, 0, 11);
      active().manualWidthIn = clamp(ft * 12 + inch, SITE.widthMinIn, SITE.widthMaxIn);
      renderAll();
    })
  );

  // ---------- Text elements (active design) ----------
  els.addText.addEventListener("click", () => {
    const d = active();
    if (d.texts.length >= SITE.maxTextElements) return;
    d.texts.push({ style: "bubble", text: "" });
    renderTextList();
    render();
    const inputs = els.textList.querySelectorAll("input");
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  function renderTextList() {
    const texts = active().texts;
    const styleOptions = (selected) =>
      Object.entries(SITE.textStyles)
        .map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`)
        .join("");
    els.textList.innerHTML = texts
      .map(
        (t, i) => `
      <div class="text-item" data-index="${i}">
        <select aria-label="Text style ${i + 1}" data-field="style">${styleOptions(t.style)}</select>
        <input type="text" maxlength="${SITE.maxTextLength}" placeholder="e.g. Happy 40th, Dave!" value="${escapeHtml(t.text)}" aria-label="Text ${i + 1}" data-field="text" />
        <button type="button" class="icon-btn" data-remove aria-label="Remove text ${i + 1}"><svg class="icon"><use href="#i-trash"/></svg></button>
      </div>`
      )
      .join("");
    els.addText.disabled = texts.length >= SITE.maxTextElements;
  }

  els.textList.addEventListener("input", (e) => {
    const row = e.target.closest(".text-item");
    if (!row) return;
    active().texts[Number(row.dataset.index)][e.target.dataset.field] = e.target.value;
    renderStageTexts();
  });

  els.textList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove]");
    if (!btn) return;
    active().texts.splice(Number(btn.closest(".text-item").dataset.index), 1);
    renderTextList();
    render();
  });

  // ---------- Material (active design) ----------
  function renderMaterials() {
    const current = active().material;
    els.materialOptions.innerHTML = SITE.materials
      .map(
        (m) => `
      <label class="option-card${m.comingSoon ? " is-disabled" : ""}">
        <input type="radio" name="material" value="${m.id}"${m.id === current ? " checked" : ""}${m.comingSoon ? " disabled" : ""} />
        <span class="option-card__check"><svg class="icon"><use href="#i-check"/></svg></span>
        <span class="option-card__body">
          <span class="option-card__title">${escapeHtml(m.name)}</span>
          <span class="option-card__detail">${escapeHtml(m.detail)}</span>
        </span>
        ${m.comingSoon ? '<span class="chip">Coming soon</span>' : ""}
      </label>`
      )
      .join("");
  }

  els.materialOptions.addEventListener("change", (e) => {
    if (e.target.name === "material") {
      active().material = e.target.value;
      render();
    }
  });

  // ---------- Quantity (dropdowns) ----------
  function setQuantity(design, n) {
    design.quantity = clamp(Math.round(n) || 1, 1, maxQuantityFor(design));
    renderAll();
  }

  els.qty.addEventListener("change", () => setQuantity(active(), Number(els.qty.value)));

  // ---------- Preview tools ----------
  document.querySelectorAll("[data-reference]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.reference = btn.dataset.reference;
      document
        .querySelectorAll("[data-reference]")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      layoutStage();
    })
  );

  els.gridToggle.addEventListener("click", () => {
    const on = els.gridToggle.getAttribute("aria-pressed") !== "true";
    els.gridToggle.setAttribute("aria-pressed", String(on));
    els.grid.hidden = !on;
  });

  els.fullscreenToggle.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (els.stage.requestFullscreen) {
      els.stage.requestFullscreen().catch(() => {});
    }
  });
  if (!els.stage.requestFullscreen) els.fullscreenToggle.hidden = true;

  // ---------- Stage layout (to scale, active design) ----------
  function layoutStage() {
    const wallPx = els.wall.clientHeight;
    if (!wallPx) return;
    const ppi = wallPx / SITE.wallHeightIn;
    els.stage.style.setProperty("--ppi", ppi + "px");

    let ticks = "";
    for (let ft = 1; ft <= 8; ft++) {
      ticks += `<span class="stage__tick" style="bottom:${ft * 12 * ppi}px">${ft}'</span>`;
    }
    els.ruler.innerHTML = ticks;

    const ref = SITE.references[state.reference];
    els.ref.hidden = !ref;
    if (ref) {
      els.ref.style.height = ref.heightIn * ppi + "px";
      els.refPerson.hidden = state.reference !== "person";
      els.refDoor.hidden = state.reference !== "door";
      els.refLabel.textContent = ref.label;
    }

    const d = active();
    const widthIn = widthOf(d);
    if (d.src && d.aspect && widthIn) {
      els.figure.style.height = d.heightIn * ppi + "px";
      els.figure.style.width = widthIn * ppi + "px";
    }
  }

  function renderStage() {
    const d = active();
    const hasPhoto = Boolean(d.src);
    els.figure.hidden = !hasPhoto;
    els.figure.classList.toggle("is-cutout", Boolean(d.cutout && d.removeBackground));
    const busy = d.bgStatus === "processing";
    els.stageBusy.hidden = !busy;
    if (busy) els.stageBusyText.textContent = backgroundProgressText(d);
    // A PDF/HEIC still being processed has no picture yet, but isn't "empty".
    els.stageDropzone.hidden = hasPhoto || state.designs.includes(d);
    els.sampleTag.hidden = !d.isSample;
    if (hasPhoto && els.img.getAttribute("src") !== d.src) els.img.src = d.src;
    els.photoActions.hidden = !state.designs.length;
    els.photoStatus.textContent = state.designs.length ? `${d.name}: ${designStatus(d)}` : "";
    els.photoStatus.style.color = d.uploadError ? "var(--error)" : "";
    els.replacePhoto.hidden = photoSlotsLeft() <= 0;
    layoutStage();
    renderStageTexts();
  }

  function renderStageTexts() {
    els.texts.innerHTML = active()
      .texts.filter((t) => t.text.trim())
      .map((t) => `<div class="stage-text stage-text--${t.style}">${escapeHtml(t.text.trim())}</div>`)
      .join("");
  }

  new ResizeObserver(layoutStage).observe(els.wall);

  // ---------- Price (every design in the tray) ----------
  /** The designs the price card covers: real photos, or the one being previewed/drafted. */
  function pricedDesigns() {
    const real = realDesigns();
    return real.length ? real : [active()];
  }

  function priceDesign(d) {
    const sizeTier = Pricing.sizeTierForHeight(d.heightIn);
    const price = Pricing.calculatePrice({
      sizeTier,
      material: d.material,
      quantity: d.quantity,
      rates: state.pricingConfig.rates,
      discountTiers: state.pricingConfig.discountTiers,
    });
    return { sizeTier, price };
  }

  function renderPrice() {
    if (!state.pricingConfig) return;
    const designs = pricedDesigns();
    const priced = designs.map((d) => ({ d, ...priceDesign(d) }));
    if (priced.some((p) => !p.price)) {
      els.priceTotal.textContent = "—";
      els.priceLines.innerHTML = "";
      return;
    }

    const cutouts = designs.reduce((n, d) => n + d.quantity, 0);
    const total = priced.reduce((n, p) => n + p.price.total, 0);
    els.priceTotal.textContent = formatCurrency(total);
    els.priceLabel.textContent =
      designs.length > 1 ? `Your standees · ${plural(designs.length, "design")} · ${plural(cutouts, "cutout")}` : "Your standee";

    let lines;
    if (designs.length > 1) {
      lines = priced.map(({ d, sizeTier, price }) => [
        `${d.name} · ${SITE.tierLabels[sizeTier]} × ${d.quantity}${price.discountPct ? ` (${price.discountPct}% off)` : ""}`,
        formatCurrency(price.total),
      ]);
    } else {
      const { d, sizeTier, price } = priced[0];
      lines = [[`Base · ${SITE.tierLabels[sizeTier]}`, formatCurrency(price.baseRate) + (d.quantity > 1 ? ` × ${d.quantity}` : "")]];
      if (price.discountAmount > 0) {
        lines.push([`Bulk discount (${price.discountPct}%)`, "−" + formatCurrency(price.discountAmount), "is-discount"]);
      }
    }
    els.priceLines.innerHTML = lines
      .map(([dt, dd, cls]) => `<div class="${cls || ""}"><dt>${escapeHtml(dt)}</dt><dd>${escapeHtml(dd)}</dd></div>`)
      .join("");

    // Quantity dropdown for the design being edited.
    const d = active();
    els.qtyLabel.textContent = state.designs.length > 1 ? `Quantity · ${d.name}` : "Quantity";
    // Up to 500 options: only rebuild when the value or the ceiling changes
    // (render() runs on every slider movement).
    const qtyKey = `${d.quantity}/${maxQuantityFor(d)}`;
    if (els.qty.dataset.key !== qtyKey) {
      els.qty.innerHTML = quantityOptions(d.quantity, maxQuantityFor(d));
      els.qty.dataset.key = qtyKey;
    }
    els.qty.disabled = Boolean(d.isSample);
    const own = priceDesign(d).price;
    if (own && own.discountPct > 0) {
      els.discountTag.textContent = `${own.discountPct}% bulk discount`;
      els.discountTag.hidden = false;
    } else {
      els.discountTag.hidden = true;
    }

    // Delivery estimate (PLACEHOLDER day counts live in js/site-config.js).
    const today = new Date();
    const earliest = addBusinessDays(today, SITE.productionDays + SITE.transitDaysMin);
    const latest = addBusinessDays(today, SITE.productionDays + SITE.transitDaysMax);
    els.deliveryTitle.textContent = `Arrives ${formatDay(earliest)} – ${formatDay(latest)}`;
    const shipping = Pricing.calculateOrderShipping({
      country: SITE.defaultCountry,
      items: priced.map((p) => ({ sizeTier: p.sizeTier, quantity: p.d.quantity })),
      shippingRates: state.pricingConfig.shippingRates,
    });
    const country = SITE.countryLabels[SITE.defaultCountry];
    els.deliverySub.textContent =
      (shipping !== null ? `${formatCurrency(shipping)} shipping to ${country}` : "Shipping calculated at checkout") +
      ` · Cut & shipped within ${SITE.productionDays * 24} hrs`;
  }

  // ---------- Add to cart ----------
  function cartBlocker() {
    const real = realDesigns();
    if (!real.length) {
      return state.designs.some((d) => d.isSample) ? "Upload your own photos to order." : "Upload a photo to get started.";
    }
    const failed = real.find((d) => d.uploadError);
    if (failed) return `${failed.name}: ${failed.uploadError} Remove it to continue.`;
    const removing = real.filter((d) => d.bgStatus === "processing").length;
    if (removing) return `Removing the background from ${plural(removing, "photo")}…`;
    const uploading = real.filter((d) => !d.imageKey).length;
    if (uploading) return `Uploading ${plural(uploading, "photo")}…`;
    if (!state.pricingConfig) return "Loading prices…";
    const badSize = real.find((d) => widthProblem(d));
    if (badSize) return `${badSize.name}: ${widthProblem(badSize)}`;
    const lowQuality = real.find(needsLowQualityOk);
    if (lowQuality) {
      return `${lowQuality.name} will print at low quality at this size — tick the box under "Choose your size", use a sharper photo, or pick a smaller size.`;
    }
    const cart = cartTotals();
    if (cart.quantity + trayQuantity() > SITE.maxOrderQuantity) {
      return `An order can have at most ${SITE.maxOrderQuantity} cutouts (you'd have ${cart.quantity + trayQuantity()}, counting your cart).`;
    }
    if (cart.uniqueImages + real.length > SITE.maxUniqueImages) {
      return `An order can have at most ${SITE.maxUniqueImages} different photos (counting your cart).`;
    }
    return null;
  }

  let justAdded = false;

  function renderCartButton() {
    const blocker = cartBlocker();
    const n = realDesigns().length;
    els.addToCartLabel.textContent = n > 1 ? `Add ${n} designs to cart` : "Add to cart";
    els.addToCart.disabled = Boolean(blocker);
    if (justAdded && !n) return; // keep the "added" confirmation until something changes
    justAdded = false;
    els.priceNote.classList.remove("is-success");
    els.priceNote.textContent = blocker || "Ready when you are.";
  }

  els.addToCart.addEventListener("click", async () => {
    if (cartBlocker()) return;
    els.addToCart.disabled = true;
    const designs = realDesigns();
    const items = await Promise.all(
      designs.map(async (d) => ({
        imageKey: d.imageKey,
        thumbnail: await Cart.makeThumbnail(d.src),
        heightIn: d.heightIn,
        widthIn: widthOf(d),
        material: d.material,
        quantity: d.quantity,
        textElements: d.texts.filter((t) => t.text.trim()).map((t) => ({ style: t.style, text: t.text.trim() })),
        widthPx: d.widthPx,
        heightPx: d.heightPx,
        acceptedLowQuality: d.acceptedLowQuality,
      }))
    );
    Cart.addMany(items);
    // The tray is done; its settings carry over as the starting point for the next photos.
    const last = active();
    state.draft = { ...defaultSettings(), heightIn: last.heightIn, material: last.material };
    designs.forEach(removeDesign);
    state.activeId = null;
    renderTextList();
    renderMaterials();
    renderAll();
    justAdded = true;
    els.priceNote.classList.add("is-success");
    els.priceNote.innerHTML = `${plural(items.length, "design")} added to your cart. <a href="checkout.html">Go to checkout →</a>`;
  });

  // ---------- Print quality (active design) ----------
  const QUALITY_TIPS = {
    great: "Sharp at this size.",
    good: "Should look good at this size.",
    fair: "May look a little soft up close. A sharper photo or a smaller size will help.",
    low: "Likely to look blurry or pixelated at this size. Use a sharper or original photo, or choose a smaller size.",
    small: "This photo is under 1000 px, so it can't score above Fair — an original from your camera will print much sharper.",
  };

  function renderQuality(d) {
    const q = qualityOf(d);
    els.qualityRow.hidden = !q || d.isSample;
    if (!q) return;
    els.qualityBadge.className = `quality-badge is-${q.grade}`;
    els.qualityBadge.textContent = `Quality ${q.score}/100 · ${SITE.qualityLabels[q.grade]}`;
    const small = Math.max(d.widthPx, d.heightPx) < 1000 && q.grade !== "low";
    els.qualityTip.textContent = (small ? QUALITY_TIPS.small : QUALITY_TIPS[q.grade]) + (d.note ? ` ${d.note}` : "");
    els.qualityConsent.hidden = q.grade !== "low";
    els.qualityConsent.classList.toggle("has-error", q.grade === "low" && !d.acceptedLowQuality);
    els.acceptLowQuality.checked = d.acceptedLowQuality;
  }

  els.removeBg.addEventListener("change", () => {
    const d = active();
    d.removeBackground = els.removeBg.checked;
    if (d.removeBackground && !d.cutout) startBackgroundRemoval(d);
    applyBackgroundChoice(d);
    hideTrayMessage();
    renderAll();
  });

  function renderBackgroundToggle(d) {
    const show = state.designs.includes(d) && !d.isSample && Boolean(d.original);
    els.bgRow.hidden = !show;
    if (!show) return;
    els.removeBg.checked = d.removeBackground;
    els.removeBg.disabled = d.bgStatus === "processing";
    els.bgHint.textContent =
      d.bgStatus === "processing"
        ? backgroundProgressText(d)
        : d.bgStatus === "failed"
          ? "Removal didn't work on this photo — it will print as uploaded."
          : "Works best on people. Turn off to keep the whole photo (e.g. a group in front of a backdrop).";
  }

  els.acceptLowQuality.addEventListener("change", () => {
    active().acceptedLowQuality = els.acceptLowQuality.checked;
    renderAll();
  });

  // ---------- Render ----------
  /** Everything that depends on the active design's size (cheap; runs on slider input). */
  function render() {
    const d = active();
    els.heightReadout.textContent = formatFeetInches(d.heightIn);
    els.heightRange.value = d.heightIn;
    els.heightFt.value = Math.floor(d.heightIn / 12);
    els.heightInches.value = d.heightIn % 12;
    const fill = ((d.heightIn - SITE.heightMinIn) / (SITE.heightMaxIn - SITE.heightMinIn)) * 100;
    els.heightRange.style.setProperty("--fill", fill + "%");

    const widthIn = widthOf(d);
    els.widthReadout.textContent = widthIn ? formatFeetInches(widthIn) : "—";
    els.lockToggle.checked = d.lockProportions;
    els.widthInputs.hidden = d.lockProportions;
    if (!d.lockProportions) {
      els.widthFt.value = Math.floor(d.manualWidthIn / 12);
      els.widthInches.value = Math.round(d.manualWidthIn % 12);
    }
    const problem = widthProblem(d);
    els.widthHint.textContent =
      problem ||
      (d.lockProportions
        ? d.aspect
          ? "Width auto-calculated from your photo's proportions."
          : "Width is calculated from your photo's proportions once you add one."
        : "Proportions unlocked — the photo will be stretched to this width.");
    els.widthHint.style.color = problem ? "var(--error)" : "";

    renderQuality(d);
    renderBackgroundToggle(d);

    renderStage();
    renderPrice();
    renderCartButton();
  }

  /** Full refresh, including the tray (photos added/removed, uploads finished, quantities). */
  function renderAll() {
    renderTray();
    render();
  }

  // ---------- Init ----------
  function fillSiteCopy() {
    const r = SITE.rating;
    document.querySelectorAll("[data-site-rating]").forEach((el) => {
      el.textContent = `${r.score}/${r.outOf} from ${r.shipped} standees shipped`;
    });
    document.querySelectorAll("[data-site-from-price]").forEach((el) => {
      el.textContent = `FROM $${SITE.fromPrice}`;
    });
    document.querySelectorAll("[data-max-images]").forEach((el) => (el.textContent = SITE.maxUniqueImages));
    document.querySelectorAll("[data-max-qty]").forEach((el) => (el.textContent = SITE.maxOrderQuantity));
  }

  // Cart changes in another tab change how much room is left.
  window.addEventListener("storage", renderAll);

  async function init() {
    fillSiteCopy();
    renderMaterials();
    renderTextList();
    renderAll();
    try {
      state.pricingConfig = await Api.get("/pricing-config");
    } catch (err) {
      els.priceNote.textContent = `Couldn't load current prices (${err.message}). Please refresh.`;
      els.deliverySub.textContent = "Shipping unavailable right now.";
      return;
    }
    renderAll();
  }

  init();
})();
