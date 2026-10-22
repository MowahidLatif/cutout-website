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
      borderColor: SITE.defaultBorderColor, // hex from SITE.borderColors, or null for no border
      lastBorderColor: SITE.defaultBorderColor, // restored when the border is switched back on
      notes: "", // for the supplier, up to SITE.maxNotesLength
      notesOpen: false,
    };
  }

  const state = {
    pricingConfig: null, // { currency, rates, discountTiers, shippingRates }
    // One design per photo:
    // { id, name, file, objectUrl, src, aspect, isSample, uploadPromise, imageKey,
    //   uploadError, ...settings,
    //   original: { key, src, width, height, blurry, compressed }, cutout: { …, vector? } | null,
    //   webOrScreenshot, graphic (upload audit: a screenshot / flat artwork),
    //   bgStatus: null | "processing" | "done" | "failed", bgProgress,
    //   reviewed (seen in the review modal), edited (cutout traced by hand) }
    // `imageKey` / `src` / pixel size always follow the version the customer chose.
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
    qtyHint: $("qty-hint"),
    borderLabel: $("border-label"),
    borderToggle: $("border-toggle"),
    borderSwatches: $("border-swatches"),
    notesOpen: $("notes-open"),
    notesField: $("notes-field"),
    notesLabel: $("notes-label"),
    notesInput: $("notes-input"),
    notesCount: $("notes-count"),
    reviewModal: $("review-modal"),
    reviewCount: $("review-count"),
    reviewTitle: $("review-title"),
    reviewError: $("review-error"),
    reviewPanes: document.querySelectorAll("#review-modal [data-pane]"),
    reviewProgress: $("review-progress"),
    reviewImg: $("review-img"),
    reviewFailedImg: $("review-failed-img"),
    reviewGraphicImg: $("review-graphic-img"),
    reviewEdit: $("review-edit"),
    reviewKeepOriginal: $("review-keep-original"),
    sourceNote: $("source-note"),
    lensToggle: $("lens-toggle"),
    lens: $("print-lens"),
    lensCanvas: $("print-lens-canvas"),
    lensCaption: $("print-lens-caption"),
    traceCanvas: $("trace-canvas"),
    traceHint: $("trace-hint"),
    traceUndo: $("trace-undo"),
    traceReset: $("trace-reset"),
    traceDone: $("trace-done"),
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
      blurry: Boolean(design.blurry),
      compressed: Boolean(design.compressed),
      vector: Boolean(design.vector),
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
      reviewed: false,
      edited: false,
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
        const audit = result.audit || {};
        design.original = {
          key: result.imageKey,
          src: result.previewUrl,
          width: result.width,
          height: result.height,
          blurry: Boolean(audit.isBlurry),
          compressed: Boolean(audit.isCompressed),
        };
        design.webOrScreenshot = Boolean(audit.isWebOrScreenshot);
        // Flat artwork is offered as a vector instead of the photo background remover.
        design.graphic = Boolean(audit.looksLikeGraphic);
        applyBackgroundChoice(design);
        if (design.removeBackground) {
          if (!design.graphic) startBackgroundRemoval(design);
          openNextReview();
        } else {
          design.reviewed = true;
        }
        renderAll();
      },
      (err) => {
        design.uploadError = err.message;
        if (review.design === design) {
          closeReview();
          openNextReview();
        }
        renderAll();
      }
    );
  }

  function removeDesign(design) {
    if (design.objectUrl) URL.revokeObjectURL(design.objectUrl);
    if (design.cutout) URL.revokeObjectURL(design.cutout.src);
    const index = state.designs.indexOf(design);
    state.designs.splice(index, 1);
    if (review.design === design) closeReview();
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
      // A hand-traced crop has its own size and proportions.
      design.widthPx = version.width;
      design.heightPx = version.height;
      design.aspect = version.width / version.height;
      // The image audit's verdict follows the version too (printQuality caps).
      design.blurry = Boolean(version.blurry);
      design.compressed = Boolean(version.compressed);
      design.vector = Boolean(version.vector);
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
    if (d.graphic && !d.cutout) return "Graphic: kept as is";
    if (!d.removeBackground) return d.graphic ? "Graphic: kept as is" : "Background: kept";
    if (d.cutout && d.cutout.vector) return "✓ Vector graphic";
    if (d.cutout && d.edited) return "✓ Custom cutout";
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
          renderReview();
        },
      });
      if (!state.designs.includes(design)) return; // removed while processing
      await uploadCutout(design, blob);
      design.bgStatus = "done";
      applyBackgroundChoice(design);
      renderAll();
      renderReview();
    } catch (err) {
      // Technical detail goes to the console; the customer gets a plain notice.
      console.warn("Background removal failed:", err);
      backgroundFailed(design, null);
    }
  }

  /** Uploads a transparent PNG (automatic or hand-traced) as the design's cutout. */
  async function uploadCutout(design, blob) {
    const formData = new FormData();
    formData.append("image", new File([blob], "cutout.png", { type: "image/png" }));
    formData.append("kind", "cutout"); // ours: skip the screenshot / graphic checks
    const result = await Api.upload("/uploads", formData);
    const audit = result.audit || {};
    if (design.cutout) URL.revokeObjectURL(design.cutout.src);
    design.cutout = {
      key: result.imageKey,
      src: URL.createObjectURL(blob),
      width: result.width,
      height: result.height,
      blurry: Boolean(audit.isBlurry),
      compressed: Boolean(audit.isCompressed),
    };
  }

  function backgroundFailed(design, reason) {
    if (!state.designs.includes(design)) return;
    design.bgStatus = "failed";
    design.removeBackground = false;
    applyBackgroundChoice(design);
    // The review modal explains it; only a photo already reviewed gets a notice.
    if (design.reviewed) {
      showTrayMessage(
        `We couldn't remove the background from ${design.name}${reason ? ` (${reason})` : ""} — we'll print it as uploaded. ` +
          "Use “Review cutout” on its photo card to try again or trace it yourself."
      );
    }
    renderAll();
    renderReview();
  }

  // ---------- Review modal (after each upload: loading → review → optional trace) ----------
  // One photo at a time. Closing it (X, Escape, backdrop) keeps the AI cutout,
  // same as Accept; the next photo waiting for review opens after it.
  const review = { design: null, tracing: false, saving: false, vectorizing: false, error: "", editor: null, traceSource: "cutout" };

  /** Photos still to review, in tray order (one may still be uploading). */
  function waitingForReview() {
    return state.designs.filter((d) => !d.isSample && !d.uploadError && !d.reviewed && d.removeBackground);
  }

  function openNextReview() {
    if (els.reviewModal.open) return renderReview();
    const next = waitingForReview()[0];
    if (next) openReview(next);
  }

  function openReview(design) {
    review.design = design;
    review.tracing = false;
    review.error = "";
    if (!els.reviewModal.open) els.reviewModal.showModal();
    renderReview();
  }

  /** Closes without changing the photo (it was removed, or a choice was already made). */
  function closeReview() {
    review.design = null;
    review.tracing = false;
    if (els.reviewModal.open) els.reviewModal.close();
  }

  /** "cutout": Accept · "original": keep the background · "keep": closed (removal stays on). */
  function finishReview(choice) {
    const d = review.design;
    if (!d) return;
    if (choice === "original") d.removeBackground = false;
    if (choice === "cutout") d.removeBackground = true;
    d.reviewed = true;
    applyBackgroundChoice(d);
    state.activeId = d.id;
    closeReview();
    hideTrayMessage();
    renderTextList();
    renderMaterials();
    renderAll();
    openNextReview();
  }

  function reviewPane(d) {
    if (review.tracing) return "trace";
    if (review.saving || review.vectorizing || !d.original) return "loading";
    if (d.graphic && !d.cutout && d.bgStatus !== "processing") return "graphic";
    if (d.bgStatus === "processing" || (!d.cutout && d.bgStatus !== "failed")) return "loading";
    return d.bgStatus === "failed" && !d.cutout ? "failed" : "review";
  }

  function renderReview() {
    const d = review.design;
    if (!d || !els.reviewModal.open) return;
    const pane = reviewPane(d);
    els.reviewPanes.forEach((p) => (p.hidden = p.dataset.pane !== pane));
    const real = realDesigns();
    els.reviewCount.textContent = real.length > 1 ? `Photo ${real.indexOf(d) + 1} of ${real.length}` : "Your photo";
    const isVector = Boolean(d.cutout && d.cutout.vector);
    els.reviewTitle.textContent = {
      loading: review.saving ? "Saving your cutout…" : review.vectorizing ? "Making it a vector…" : "Removing the background…",
      graphic: "Logo or graphic?",
      review: isVector ? "Here's your vector" : d.edited ? "Here's your traced cutout" : "How does this look?",
      failed: "Background removal didn't work",
      trace: "Trace your cutout",
    }[pane];
    els.reviewError.hidden = !review.error;
    els.reviewError.textContent = review.error;
    if (pane === "loading") {
      els.reviewProgress.textContent = review.saving
        ? "Uploading the edited cutout…"
        : review.vectorizing
          ? "Tracing the shapes — this takes a few seconds…"
          : d.original
          ? backgroundProgressText(d)
          : "Uploading your photo…";
    }
    if (pane === "review" && els.reviewImg.getAttribute("src") !== d.cutout.src) els.reviewImg.src = d.cutout.src;
    if (pane === "review") {
      // A vector is already exact; tracing applies to photos.
      els.reviewEdit.hidden = isVector;
      els.reviewKeepOriginal.textContent = isVector ? "Keep the original image instead" : "Keep the original background instead";
    }
    if (pane === "graphic" && els.reviewGraphicImg.getAttribute("src") !== d.original.src) els.reviewGraphicImg.src = d.original.src;
    if (pane === "failed" && els.reviewFailedImg.getAttribute("src") !== d.original.src) els.reviewFailedImg.src = d.original.src;
  }

  /** Flat artwork → vector on the server (SVG preview, PDF + PNG print files). */
  async function vectorize(d) {
    review.vectorizing = true;
    review.error = "";
    renderReview();
    try {
      const result = await Api.post(`/uploads/${encodeURIComponent(d.original.key)}/vectorize`, {});
      if (d.cutout) URL.revokeObjectURL(d.cutout.src);
      d.cutout = { key: result.imageKey, src: result.previewUrl, width: result.width, height: result.height, vector: true };
      d.bgStatus = "done";
      d.edited = false;
      d.removeBackground = true;
      applyBackgroundChoice(d);
    } catch (err) {
      console.warn("Vectorizing failed:", err);
      review.error = `We couldn't turn it into a vector (${err.message}). You can keep it as is.`;
    }
    review.vectorizing = false;
    renderAll();
    renderReview();
  }

  // Trace mode (js/trace-editor.js)
  function traceEditor() {
    if (!review.editor) {
      review.editor = TraceEditor.create(els.traceCanvas, {
        onChange: () => {
          const edited = review.editor.edited();
          els.traceUndo.disabled = !review.editor.canUndo();
          els.traceReset.disabled = !edited;
          els.traceDone.disabled = !edited;
        },
      });
    }
    return review.editor;
  }

  async function startTrace(source) {
    const d = review.design;
    review.tracing = true;
    review.error = "";
    review.traceSource = source === "cutout" && d.cutout ? "cutout" : "original";
    document.querySelectorAll("[data-trace-source]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.traceSource === review.traceSource));
      btn.disabled = btn.dataset.traceSource === "cutout" && !d.cutout;
    });
    renderReview(); // the canvas needs to be visible to measure itself
    const version = review.traceSource === "cutout" ? d.cutout : d.original;
    try {
      await traceEditor().load(version.src);
    } catch (err) {
      review.error = err.message;
      renderReview();
    }
  }

  async function finishTrace() {
    const d = review.design;
    let blob;
    try {
      blob = await traceEditor().toBlob();
    } catch (err) {
      review.error = err.message;
      return renderReview();
    }
    review.tracing = false;
    review.saving = true;
    renderReview();
    try {
      await uploadCutout(d, blob);
      d.edited = true;
      d.bgStatus = "done";
      d.removeBackground = true;
      applyBackgroundChoice(d);
    } catch (err) {
      console.warn("Saving the traced cutout failed:", err);
      review.error = `Your traced cutout couldn't be saved (${err.message}). Please try again.`;
    }
    review.saving = false;
    renderAll();
    renderReview();
  }

  $("review-accept").addEventListener("click", () => finishReview("cutout"));
  $("review-keep-original").addEventListener("click", () => finishReview("original"));
  $("review-use-original").addEventListener("click", () => finishReview("original"));
  $("review-close").addEventListener("click", () => finishReview("keep"));
  $("review-edit").addEventListener("click", () => startTrace("cutout"));
  $("review-keep-graphic").addEventListener("click", () => finishReview("original"));
  $("review-vectorize").addEventListener("click", () => vectorize(review.design));
  $("review-is-photo").addEventListener("click", () => {
    const d = review.design;
    d.graphic = false;
    d.removeBackground = true;
    startBackgroundRemoval(d);
    renderReview();
  });
  $("review-trace-original").addEventListener("click", () => startTrace("original"));
  $("review-retry").addEventListener("click", () => {
    const d = review.design;
    d.removeBackground = true;
    review.error = "";
    startBackgroundRemoval(d);
    renderReview();
  });
  // Escape: closing keeps the cutout, like the X. While tracing, Escape only leaves trace mode.
  els.reviewModal.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (review.tracing) {
      review.tracing = false;
      renderReview();
    } else {
      finishReview("keep");
    }
  });
  // A click on the backdrop (outside the dialog box) closes it — but never mid-trace.
  els.reviewModal.addEventListener("click", (e) => {
    if (e.target !== els.reviewModal || review.tracing) return;
    const box = els.reviewModal.getBoundingClientRect();
    const inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
    if (!inside) finishReview("keep");
  });
  document.querySelectorAll("[data-trace-tool]").forEach((btn) =>
    btn.addEventListener("click", () => {
      traceEditor().setTool(btn.dataset.traceTool);
      document
        .querySelectorAll("[data-trace-tool]")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      els.traceHint.textContent =
        btn.dataset.traceTool === "crop"
          ? "Drag a box around what you want to keep — the photo is cut down to it."
          : "Drag around what you want to keep — everything outside becomes transparent.";
    })
  );
  document.querySelectorAll("[data-trace-source]").forEach((btn) =>
    btn.addEventListener("click", () => startTrace(btn.dataset.traceSource))
  );
  els.traceUndo.addEventListener("click", () => traceEditor().undo());
  els.traceReset.addEventListener("click", () => traceEditor().reset());
  els.traceDone.addEventListener("click", finishTrace);
  $("trace-cancel").addEventListener("click", () => {
    review.tracing = false;
    renderReview();
  });
  window.addEventListener("resize", () => review.tracing && review.editor && review.editor.layout());

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

  function renderTraySummary() {
    const real = realDesigns();
    els.traySummary.textContent = real.length
      ? `${plural(real.length, "photo")} · ${plural(trayQuantity(), "cutout")}`
      : "Sample photo";
  }

  function renderTray() {
    const show = state.designs.length > 0;
    els.tray.hidden = !show;
    if (!show) {
      els.trayList.innerHTML = "";
      return;
    }

    renderTraySummary();

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
            </span>
            <span class="tray-card__name">${escapeHtml(d.name)}</span>
            <span class="tray-card__status">${escapeHtml(status)}</span>
            ${d.webOrScreenshot ? '<span class="tray-card__tag">Screenshot / web photo</span>' : ""}
            ${d.isSample || !d.imageKey ? "" : `<span class="tray-card__bg">${escapeHtml(backgroundLabel(d))}</span>`}
          </button>
          ${
            !d.isSample && d.original && (d.graphic || d.bgStatus === "done" || d.bgStatus === "failed")
              ? `<button type="button" class="link-accent tray-card__review" data-review>${d.graphic ? "Review graphic" : "Review cutout"}</button>`
              : ""
          }
          ${
            d.isSample
              ? ""
              : `<label class="tray-card__qty">Qty
                  <input type="number" inputmode="numeric" min="1" max="${maxQuantityFor(d)}" step="1" value="${d.quantity}"
                    data-qty aria-label="Quantity for ${escapeHtml(d.name)}" />
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
    if (e.target.closest("[data-review]")) {
      openReview(design);
      return;
    }
    if (e.target.closest("[data-remove]")) {
      removeDesign(design);
      hideTrayMessage();
      renderAll();
    } else if (e.target.closest(".tray-card__select")) {
      state.activeId = design.id;
      els.qtyHint.textContent = "";
      renderTextList();
      renderMaterials();
      renderAll();
    }
  });

  // Tray quantity boxes: typing updates the price without rebuilding the tray
  // (which would drop focus); leaving the box clamps it and refreshes everything.
  const trayDesignOf = (input) => state.designs.find((d) => d.id === input.closest(".tray-card").dataset.id);
  els.trayList.addEventListener("input", (e) => {
    if (!e.target.matches("[data-qty]")) return;
    const design = trayDesignOf(e.target);
    if (!design) return;
    readQuantity(e.target, design, false);
    renderTraySummary();
    render();
  });
  els.trayList.addEventListener("change", (e) => {
    if (!e.target.matches("[data-qty]")) return;
    const design = trayDesignOf(e.target);
    if (!design) return;
    const hint = readQuantity(e.target, design, true);
    if (hint) showTrayMessage(`${design.name}: ${hint}`);
    renderAll();
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

  // ---------- Quantity (number boxes: price card, tray cards) ----------
  /**
   * Applies a typed quantity to `design`, kept within 1 … maxQuantityFor().
   * While typing (`commit` false) an empty box is left alone; on commit the
   * box is rewritten with the value actually used. Returns a hint explaining
   * any adjustment ("" if none).
   */
  function readQuantity(input, design, commit) {
    const max = maxQuantityFor(design);
    const raw = input.value.trim() === "" ? NaN : Number(input.value);
    let hint = "";
    if (Number.isFinite(raw)) {
      design.quantity = clamp(Math.round(raw), 1, max);
      if (raw > max) {
        hint =
          max < SITE.maxOrderQuantity
            ? `Max ${max} — an order can have ${SITE.maxOrderQuantity} cutouts in total, counting your other photos and cart.`
            : `Max ${max} cutouts per order.`;
      } else if (raw < 1) {
        hint = "At least 1.";
      } else if (!Number.isInteger(raw)) {
        hint = "Whole numbers only.";
      }
    }
    if (commit) input.value = design.quantity;
    return hint;
  }

  els.qty.addEventListener("input", () => {
    els.qtyHint.textContent = readQuantity(els.qty, active(), false);
    renderAll();
  });
  els.qty.addEventListener("change", () => {
    els.qtyHint.textContent = readQuantity(els.qty, active(), true);
    renderAll();
  });

  // ---------- Border and notes (price card, active design) ----------
  els.borderSwatches.innerHTML = SITE.borderColors
    .map(
      (c) => `<label class="swatch">
        <input type="radio" name="border-color" value="${c.hex}" />
        <span class="swatch__dot" style="--swatch:${c.hex}"></span>${escapeHtml(c.name)}
      </label>`
    )
    .join("");

  els.borderToggle.addEventListener("change", () => {
    const d = active();
    if (els.borderToggle.checked) {
      d.borderColor = d.lastBorderColor || SITE.defaultBorderColor;
    } else {
      if (d.borderColor) d.lastBorderColor = d.borderColor;
      d.borderColor = null;
    }
    render();
  });

  els.borderSwatches.addEventListener("change", (e) => {
    if (e.target.name !== "border-color") return;
    active().borderColor = active().lastBorderColor = e.target.value;
    render();
  });

  els.notesOpen.addEventListener("click", () => {
    active().notesOpen = true;
    render();
    els.notesInput.focus();
  });

  els.notesInput.addEventListener("input", () => {
    const d = active();
    d.notes = els.notesInput.value.slice(0, SITE.maxNotesLength);
    els.notesCount.textContent = `${d.notes.length}/${SITE.maxNotesLength}`;
  });

  function renderOrderOptions(d) {
    const disabled = Boolean(d.isSample);
    const which = state.designs.length > 1 ? ` · ${d.name}` : "";
    els.borderLabel.textContent = `Border around the cutout${which}`;
    els.borderToggle.checked = Boolean(d.borderColor);
    els.borderToggle.disabled = disabled;
    els.borderSwatches.hidden = !d.borderColor;
    els.borderSwatches.querySelectorAll("input").forEach((input) => {
      input.checked = input.value === d.borderColor;
      input.disabled = disabled;
    });
    const open = d.notesOpen || Boolean(d.notes);
    els.notesOpen.hidden = open;
    els.notesOpen.disabled = disabled;
    els.notesField.hidden = !open;
    els.notesLabel.textContent = `Notes for the supplier${which}`;
    els.notesInput.disabled = disabled;
    els.notesInput.maxLength = SITE.maxNotesLength;
    if (document.activeElement !== els.notesInput) els.notesInput.value = d.notes;
    els.notesCount.textContent = `${d.notes.length}/${SITE.maxNotesLength}`;
  }

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
    // The border preview: a die-cut outline on cutouts, a frame on whole photos.
    els.figure.classList.toggle("no-border", !d.borderColor);
    els.figure.style.setProperty("--edge", d.borderColor || "transparent");
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
    renderLens();
  }

  function renderStageTexts() {
    els.texts.innerHTML = active()
      .texts.filter((t) => t.text.trim())
      .map((t) => `<div class="stage-text stage-text--${t.style}">${escapeHtml(t.text.trim())}</div>`)
      .join("");
  }

  // ---------- Print detail lens (actual printed size) ----------
  // A 200 × 200 CSS px window. CSS px are 1/96 in, so it shows 200/96 ≈ 2.08
  // printed inches of the photo — however many photo pixels that is at the
  // chosen size — scaled the way a printer would. Low resolution or blur is
  // visible directly instead of being a number.
  const LENS_PX = 200;
  const LENS_IN = LENS_PX / 96;
  const lens = { open: false, focus: null, imageId: null }; // focus: {x, y} as 0–1 of the image

  /**
   * Default spot: the centre, or for a cutout the top quarter (usually the
   * face) — moved to the nearest visible pixel, so a logo with a gap in the
   * middle doesn't open on empty space.
   */
  function lensDefaultFocus(d, img) {
    const target = d.cutout && d.removeBackground && !d.vector ? { x: 0.5, y: 0.125 } : { x: 0.5, y: 0.5 };
    const GRID = 32;
    const probe = document.createElement("canvas");
    probe.width = GRID;
    probe.height = GRID;
    const ctx = probe.getContext("2d");
    ctx.drawImage(img, 0, 0, GRID, GRID);
    const { data } = ctx.getImageData(0, 0, GRID, GRID);
    let best = null;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (data[(y * GRID + x) * 4 + 3] < 200) continue;
        const point = { x: (x + 0.5) / GRID, y: (y + 0.5) / GRID };
        const dist = (point.x - target.x) ** 2 + (point.y - target.y) ** 2;
        if (!best || dist < best.dist) best = { ...point, dist };
      }
    }
    return best ? { x: best.x, y: best.y } : target;
  }

  function renderLens() {
    const d = active();
    const available = Boolean(!d.isSample && d.imageKey && d.src && widthOf(d));
    els.lensToggle.hidden = !available;
    if (!available) lens.open = false;
    // A different photo or version (original / cutout / vector) starts from its own default spot.
    if (lens.imageId !== `${d.id}:${d.imageKey}`) {
      lens.imageId = `${d.id}:${d.imageKey}`;
      lens.focus = null;
    }
    els.lens.hidden = !lens.open;
    els.lensToggle.setAttribute("aria-pressed", String(lens.open));
    if (!lens.open) return;

    const img = els.img;
    if (!img.complete || !img.naturalWidth) {
      img.addEventListener("load", renderLens, { once: true });
      return;
    }
    const widthIn = widthOf(d);
    const pxPerInX = img.naturalWidth / widthIn;
    const pxPerInY = img.naturalHeight / d.heightIn;
    if (!lens.focus) lens.focus = lensDefaultFocus(d, img);
    const focus = lens.focus;
    const sw = LENS_IN * pxPerInX;
    const sh = LENS_IN * pxPerInY;

    const dpr = window.devicePixelRatio || 1;
    const canvas = els.lensCanvas;
    canvas.width = Math.round(LENS_PX * dpr);
    canvas.height = Math.round(LENS_PX * dpr);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, focus.x * img.naturalWidth - sw / 2, focus.y * img.naturalHeight - sh / 2, sw, sh, 0, 0, canvas.width, canvas.height);

    const q = qualityOf(d);
    const shown = `${LENS_IN.toFixed(1)} × ${LENS_IN.toFixed(1)} in shown`;
    els.lensCaption.textContent = q && q.vector
      ? `${shown} · vector, sharp at any size`
      : `${shown} · ${q ? q.ppi : Math.round(Math.min(pxPerInX, pxPerInY))} pixels per inch` +
        (q && q.issue ? ` · looks ${q.issue === "blurry" ? "blurry" : "compressed"}` : "");
  }

  /** Where in the image (0–1) a click on the preview landed, allowing for frame and letterboxing. */
  function imagePointAt(clientX, clientY) {
    const img = els.img;
    const box = img.getBoundingClientRect();
    const style = getComputedStyle(img);
    const border = parseFloat(style.borderTopWidth) || 0;
    let left = box.left + border;
    let top = box.top + border;
    let width = box.width - 2 * border;
    let height = box.height - 2 * border;
    if (style.objectFit === "contain" && img.naturalWidth) {
      // Cutouts: fitted inside the box and pinned to the floor (object-position: center bottom).
      const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      left += (width - w) / 2;
      top += height - h;
      width = w;
      height = h;
    }
    const x = (clientX - left) / width;
    const y = (clientY - top) / height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  }

  els.lensToggle.addEventListener("click", () => {
    lens.open = !lens.open;
    renderLens();
  });
  $("lens-close").addEventListener("click", () => {
    lens.open = false;
    renderLens();
    els.lensToggle.focus();
  });
  els.figure.addEventListener("click", (e) => {
    if (!lens.open) return;
    const point = imagePointAt(e.clientX, e.clientY);
    if (!point) return;
    lens.focus = point;
    renderLens();
  });

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
    els.qty.max = maxQuantityFor(d);
    if (document.activeElement !== els.qty) els.qty.value = d.quantity;
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
        // The audit's verdict, for checkout's quality line (the server re-checks the file).
        blurry: Boolean(d.blurry),
        compressed: Boolean(d.compressed),
        vector: Boolean(d.vector),
        borderColor: d.borderColor,
        notes: d.notes.trim() || null,
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
    blurry: "Photo looks blurry or out of focus — a sharper original will print much better.",
    compressed: "Photo looks heavily compressed (blocky) — the original file will print cleaner.",
    vector: "Vector graphic — prints perfectly sharp at any size.",
  };

  function renderQuality(d) {
    const q = qualityOf(d);
    els.qualityRow.hidden = !q || d.isSample;
    if (!q) return;
    els.qualityBadge.className = `quality-badge is-${q.grade}`;
    els.qualityBadge.textContent = `Quality ${q.score}/100 · ${SITE.qualityLabels[q.grade]}${q.vector ? " · Vector" : ""}`;
    const small = !q.vector && Math.max(d.widthPx, d.heightPx) < 1000 && q.grade !== "low";
    const tip = q.vector ? QUALITY_TIPS.vector : q.issue ? QUALITY_TIPS[q.issue] : small ? QUALITY_TIPS.small : QUALITY_TIPS[q.grade];
    els.qualityTip.textContent = tip + (d.note ? ` ${d.note}` : "");
    // Non-blocking nudge: camera originals print sharper than screenshots / web copies.
    els.sourceNote.hidden = !d.webOrScreenshot || q.vector;
    els.qualityConsent.hidden = q.grade !== "low";
    els.qualityConsent.classList.toggle("has-error", q.grade === "low" && !d.acceptedLowQuality);
    els.acceptLowQuality.checked = d.acceptedLowQuality;
  }

  els.removeBg.addEventListener("change", () => {
    const d = active();
    d.removeBackground = els.removeBg.checked;
    if (d.removeBackground && !d.cutout) {
      if (!d.graphic) startBackgroundRemoval(d);
      openReview(d);
    }
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
    renderOrderOptions(d);

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
