/**
 * Page logic for the studio on index.html: upload a photo, size it against
 * a to-scale wall, add text, pick a material, see the live price, and add
 * the design to the cart.
 *
 * The price shown here comes from js/pricing.js + GET /api/pricing-config
 * and is only for instant feedback — the backend recomputes everything
 * (including the size tier, from the height) when the order is placed.
 */
(function () {
  const SITE = window.SITE;

  const state = {
    pricingConfig: null, // { rates, discountTiers, shippingRates }
    file: null,
    objectUrl: null,
    aspect: null, // photo width / height
    isSample: false,
    uploadPromise: null, // resolves to the imageKey, rejects with the server's reason
    imageKey: null,
    uploadError: null,
    heightIn: SITE.defaultHeightIn,
    lockProportions: true,
    manualWidthIn: 24,
    texts: [], // [{ style, text }]
    material: SITE.materials.find((m) => !m.comingSoon).id,
    quantity: 1,
    reference: "person",
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    input: $("photo-input"),
    heroDropzone: $("hero-dropzone"),
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
    lockToggle: $("lock-toggle"),
    addText: $("add-text"),
    textList: $("text-list"),
    materialOptions: $("material-options"),
    priceTotal: $("price-total"),
    priceLines: $("price-lines"),
    qty: $("qty"),
    qtyMinus: $("qty-minus"),
    qtyPlus: $("qty-plus"),
    discountTag: $("discount-tag"),
    deliveryTitle: $("delivery-title"),
    deliverySub: $("delivery-sub"),
    addToCart: $("add-to-cart"),
    priceNote: $("price-note"),
  };

  // ---------- Helpers ----------
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  function formatFeetInches(inches) {
    const total = Math.round(inches);
    return `${Math.floor(total / 12)}'${total % 12}"`;
  }

  function formatCurrency(n) {
    return "$" + Number(n).toFixed(2);
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

  /** The printed width: from the photo's proportions, or the customer's own value. */
  function currentWidthIn() {
    if (!state.lockProportions) return state.manualWidthIn;
    if (!state.aspect) return null;
    return Math.round(state.heightIn * state.aspect * 2) / 2;
  }

  function widthProblem() {
    const w = currentWidthIn();
    if (w === null) return null;
    if (w > SITE.widthMaxIn) {
      return `At this height your photo would be ${formatFeetInches(w)} wide — the maximum is ${SITE.widthMaxIn / 12} ft. Lower the height or unlock proportions.`;
    }
    if (w < SITE.widthMinIn) {
      return `At this height your photo would be only ${Math.round(w)}" wide — the minimum is ${SITE.widthMinIn}". Increase the height.`;
    }
    return null;
  }

  // ---------- Photo: choose, preview, upload ----------
  function openPicker() {
    els.input.click();
  }

  function wireDropzone(zone, { scrollToStudio }) {
    zone.addEventListener("click", openPicker);
    zone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
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
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) {
        handleFile(file);
        if (scrollToStudio) scrollToStudioSection();
      }
    });
  }

  let pickerFromHero = false;
  els.heroDropzone.addEventListener("click", () => (pickerFromHero = true));
  els.stageDropzone.addEventListener("click", () => (pickerFromHero = false));
  els.replacePhoto.addEventListener("click", () => {
    pickerFromHero = false;
    openPicker();
  });

  els.input.addEventListener("change", () => {
    const file = els.input.files && els.input.files[0];
    if (file) {
      handleFile(file);
      if (pickerFromHero) scrollToStudioSection();
    }
    els.input.value = ""; // allow re-choosing the same file
  });

  function scrollToStudioSection() {
    document.getElementById("studio").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function showPhoto(src, aspect) {
    state.aspect = aspect;
    els.img.src = src;
    els.figure.hidden = false;
    els.stageDropzone.hidden = true;
    els.photoActions.hidden = false;
    els.sampleTag.hidden = !state.isSample;
    render();
  }

  function readAspect(src) {
    return new Promise((resolve, reject) => {
      const probe = new Image();
      probe.onload = () => resolve(probe.naturalWidth / probe.naturalHeight);
      probe.onerror = () => reject(new Error("That file couldn't be opened as an image."));
      probe.src = src;
    });
  }

  async function handleFile(file) {
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.file = file;
    state.isSample = false;
    state.imageKey = null;
    state.uploadError = null;
    state.objectUrl = URL.createObjectURL(file);

    // Preview straight away (the browser applies EXIF rotation to <img> the
    // same way the server bakes it in), while the upload runs in the background.
    readAspect(state.objectUrl).then(
      (aspect) => showPhoto(state.objectUrl, aspect),
      () => {}
    );

    if (file.size > SITE.maxUploadMb * 1024 * 1024) {
      state.uploadPromise = Promise.reject(
        new Error(`That file is too large. The maximum is ${SITE.maxUploadMb} MB.`)
      );
    } else {
      setPhotoStatus(`Uploading ${file.name}…`);
      state.uploadPromise = uploadImage(file);
    }

    const thisUpload = state.uploadPromise;
    thisUpload.then(
      (imageKey) => {
        if (state.uploadPromise !== thisUpload) return; // a newer photo was chosen
        state.imageKey = imageKey;
        setPhotoStatus(`✓ ${file.name} uploaded`);
        render();
      },
      (err) => {
        if (state.uploadPromise !== thisUpload) return;
        state.uploadError = err.message;
        setPhotoStatus(err.message, true);
        render();
      }
    );
    render();
  }

  async function uploadImage(file) {
    // The backend checks type, size and resolution, fixes phone rotation,
    // and returns the key the order refers to the photo by.
    const formData = new FormData();
    formData.append("image", file);
    const result = await Api.upload("/uploads", formData);
    return result.imageKey;
  }

  function setPhotoStatus(message, isError) {
    els.photoStatus.textContent = message;
    els.photoStatus.style.color = isError ? "var(--error)" : "";
    els.photoActions.hidden = false;
  }

  async function loadSample() {
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
    state.file = null;
    state.isSample = true;
    state.imageKey = null;
    state.uploadError = null;
    state.uploadPromise = null;
    const src = "img/sample.svg";
    try {
      showPhoto(src, await readAspect(src));
    } catch (e) {
      showPhoto(src, 0.4);
    }
    setPhotoStatus("Showing a sample photo");
    scrollToStudioSection();
  }

  document.querySelectorAll("[data-try-sample]").forEach((btn) => btn.addEventListener("click", loadSample));
  wireDropzone(els.heroDropzone, { scrollToStudio: true });
  wireDropzone(els.stageDropzone, { scrollToStudio: false });

  // ---------- Size controls ----------
  function setHeight(inches) {
    state.heightIn = clamp(Math.round(inches), SITE.heightMinIn, SITE.heightMaxIn);
    render();
  }

  els.heightRange.addEventListener("input", () => setHeight(Number(els.heightRange.value)));
  [els.heightFt, els.heightInches].forEach((input) =>
    input.addEventListener("change", () => {
      const ft = Number(els.heightFt.value) || 0;
      const inch = clamp(Number(els.heightInches.value) || 0, 0, 11);
      setHeight(ft * 12 + inch);
    })
  );

  els.lockToggle.addEventListener("change", () => {
    if (!els.lockToggle.checked) {
      state.manualWidthIn = clamp(Math.round(currentWidthIn() || 24), SITE.widthMinIn, SITE.widthMaxIn);
    }
    state.lockProportions = els.lockToggle.checked;
    render();
  });

  [els.widthFt, els.widthInches].forEach((input) =>
    input.addEventListener("change", () => {
      const ft = Number(els.widthFt.value) || 0;
      const inch = clamp(Number(els.widthInches.value) || 0, 0, 11);
      state.manualWidthIn = clamp(ft * 12 + inch, SITE.widthMinIn, SITE.widthMaxIn);
      render();
    })
  );

  // ---------- Text elements ----------
  els.addText.addEventListener("click", () => {
    if (state.texts.length >= SITE.maxTextElements) return;
    state.texts.push({ style: "bubble", text: "" });
    renderTextList();
    render();
    const inputs = els.textList.querySelectorAll("input");
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  function renderTextList() {
    const styleOptions = (selected) =>
      Object.entries(SITE.textStyles)
        .map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`)
        .join("");
    els.textList.innerHTML = state.texts
      .map(
        (t, i) => `
      <div class="text-item" data-index="${i}">
        <select aria-label="Text style ${i + 1}" data-field="style">${styleOptions(t.style)}</select>
        <input type="text" maxlength="${SITE.maxTextLength}" placeholder="e.g. Happy 40th, Dave!" value="${escapeHtml(t.text)}" aria-label="Text ${i + 1}" data-field="text" />
        <button type="button" class="icon-btn" data-remove aria-label="Remove text ${i + 1}"><svg class="icon"><use href="#i-trash"/></svg></button>
      </div>`
      )
      .join("");
    els.addText.disabled = state.texts.length >= SITE.maxTextElements;
  }

  els.textList.addEventListener("input", (e) => {
    const row = e.target.closest(".text-item");
    if (!row) return;
    const t = state.texts[Number(row.dataset.index)];
    t[e.target.dataset.field] = e.target.value;
    renderStageTexts();
  });

  els.textList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove]");
    if (!btn) return;
    state.texts.splice(Number(btn.closest(".text-item").dataset.index), 1);
    renderTextList();
    render();
  });

  // ---------- Material ----------
  function renderMaterials() {
    els.materialOptions.innerHTML = SITE.materials
      .map(
        (m) => `
      <label class="option-card${m.comingSoon ? " is-disabled" : ""}">
        <input type="radio" name="material" value="${m.id}"${m.id === state.material ? " checked" : ""}${m.comingSoon ? " disabled" : ""} />
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
      state.material = e.target.value;
      render();
    }
  });

  // ---------- Quantity ----------
  function setQuantity(n) {
    state.quantity = clamp(Math.round(n) || 1, 1, 99);
    render();
  }
  els.qtyMinus.addEventListener("click", () => setQuantity(state.quantity - 1));
  els.qtyPlus.addEventListener("click", () => setQuantity(state.quantity + 1));
  els.qty.addEventListener("change", () => setQuantity(Number(els.qty.value)));

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

  // ---------- Stage layout (to scale) ----------
  function layoutStage() {
    const wallPx = els.wall.clientHeight;
    if (!wallPx) return;
    const ppi = wallPx / SITE.wallHeightIn;
    els.stage.style.setProperty("--ppi", ppi + "px");

    // Ruler: one tick per foot, 1–8 ft.
    let ticks = "";
    for (let ft = 1; ft <= 8; ft++) {
      ticks += `<span class="stage__tick" style="bottom:${ft * 12 * ppi}px">${ft}'</span>`;
    }
    els.ruler.innerHTML = ticks;

    // Reference figure.
    const ref = SITE.references[state.reference];
    els.ref.hidden = !ref;
    if (ref) {
      els.ref.style.height = ref.heightIn * ppi + "px";
      els.refPerson.hidden = state.reference !== "person";
      els.refDoor.hidden = state.reference !== "door";
      els.refLabel.textContent = ref.label;
    }

    // The standee itself.
    const widthIn = currentWidthIn();
    if (state.aspect && widthIn) {
      els.figure.style.height = state.heightIn * ppi + "px";
      els.figure.style.width = widthIn * ppi + "px";
    }
  }

  function renderStageTexts() {
    els.texts.innerHTML = state.texts
      .filter((t) => t.text.trim())
      .map((t) => `<div class="stage-text stage-text--${t.style}">${escapeHtml(t.text.trim())}</div>`)
      .join("");
  }

  new ResizeObserver(layoutStage).observe(els.wall);

  // ---------- Price ----------
  function renderPrice() {
    const sizeTier = Pricing.sizeTierForHeight(state.heightIn);
    if (!state.pricingConfig) return;

    const price = Pricing.calculatePrice({
      sizeTier,
      material: state.material,
      quantity: state.quantity,
      rates: state.pricingConfig.rates,
      discountTiers: state.pricingConfig.discountTiers,
    });
    if (!price) {
      els.priceTotal.textContent = "—";
      els.priceLines.innerHTML = "";
      return;
    }

    els.priceTotal.textContent = formatCurrency(price.total);
    const lines = [
      [`Base · ${SITE.tierLabels[sizeTier]}`, formatCurrency(price.baseRate) + (state.quantity > 1 ? ` × ${state.quantity}` : "")],
    ];
    if (price.discountAmount > 0) {
      lines.push([`Bulk discount (${price.discountPct}%)`, "−" + formatCurrency(price.discountAmount), "is-discount"]);
    }
    els.priceLines.innerHTML = lines
      .map(([dt, dd, cls]) => `<div class="${cls || ""}"><dt>${escapeHtml(dt)}</dt><dd>${escapeHtml(dd)}</dd></div>`)
      .join("");

    if (price.discountPct > 0) {
      els.discountTag.textContent = `${price.discountPct}% bulk discount`;
      els.discountTag.hidden = false;
    } else {
      els.discountTag.hidden = true;
    }

    // Delivery estimate (PLACEHOLDER day counts live in js/site-config.js).
    const today = new Date();
    const earliest = addBusinessDays(today, SITE.productionDays + SITE.transitDaysMin);
    const latest = addBusinessDays(today, SITE.productionDays + SITE.transitDaysMax);
    els.deliveryTitle.textContent = `Arrives ${formatDay(earliest)} – ${formatDay(latest)}`;
    const shipping = Pricing.calculateShipping({
      country: SITE.defaultCountry,
      sizeTier,
      quantity: state.quantity,
      shippingRates: state.pricingConfig.shippingRates,
    });
    const country = SITE.countryLabels[SITE.defaultCountry];
    els.deliverySub.textContent =
      (shipping !== null ? `${formatCurrency(shipping)} shipping to ${country}` : "Shipping calculated at checkout") +
      ` · Cut & shipped within ${SITE.productionDays * 24} hrs`;
  }

  // ---------- Add to cart ----------
  function cartBlocker() {
    if (state.isSample) return "Upload your own photo to order.";
    if (!state.file) return "Upload a photo to get started.";
    if (state.uploadError) return state.uploadError;
    if (!state.imageKey) return "Uploading your photo…";
    if (!state.pricingConfig) return "Loading prices…";
    return widthProblem();
  }

  function renderCartButton() {
    const blocker = cartBlocker();
    els.addToCart.disabled = Boolean(blocker);
    if (blocker || !justAdded) {
      els.priceNote.classList.remove("is-success");
      els.priceNote.textContent = blocker || "Ready when you are.";
    }
  }

  let justAdded = false;
  els.addToCart.addEventListener("click", async () => {
    if (cartBlocker()) return;
    els.addToCart.disabled = true;
    const thumbnail = await Cart.makeThumbnail(state.objectUrl);
    Cart.add({
      imageKey: state.imageKey,
      thumbnail,
      heightIn: state.heightIn,
      widthIn: currentWidthIn(),
      material: state.material,
      quantity: state.quantity,
      textElements: state.texts
        .filter((t) => t.text.trim())
        .map((t) => ({ style: t.style, text: t.text.trim() })),
    });
    justAdded = true;
    els.priceNote.classList.add("is-success");
    els.priceNote.innerHTML = 'Added to your cart. <a href="checkout.html">Go to checkout →</a>';
    els.addToCart.disabled = false;
  });

  // ---------- Render ----------
  function render() {
    justAdded = false;
    // Size readouts and inputs.
    els.heightReadout.textContent = formatFeetInches(state.heightIn);
    els.heightRange.value = state.heightIn;
    els.heightFt.value = Math.floor(state.heightIn / 12);
    els.heightInches.value = state.heightIn % 12;
    const fill = ((state.heightIn - SITE.heightMinIn) / (SITE.heightMaxIn - SITE.heightMinIn)) * 100;
    els.heightRange.style.setProperty("--fill", fill + "%");

    const widthIn = currentWidthIn();
    els.widthReadout.textContent = widthIn ? formatFeetInches(widthIn) : "—";
    els.widthInputs.hidden = state.lockProportions;
    if (!state.lockProportions) {
      els.widthFt.value = Math.floor(state.manualWidthIn / 12);
      els.widthInches.value = Math.round(state.manualWidthIn % 12);
    }
    const problem = widthProblem();
    els.widthHint.textContent =
      problem ||
      (state.lockProportions
        ? state.aspect
          ? "Width auto-calculated from your photo's proportions."
          : "Width is calculated from your photo's proportions once you add one."
        : "Proportions unlocked — the photo will be stretched to this width.");
    els.widthHint.style.color = problem ? "var(--error)" : "";

    els.qty.value = state.quantity;
    els.qtyMinus.disabled = state.quantity <= 1;

    layoutStage();
    renderStageTexts();
    renderPrice();
    renderCartButton();
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
  }

  async function init() {
    fillSiteCopy();
    renderMaterials();
    renderTextList();
    render();
    try {
      state.pricingConfig = await Api.get("/pricing-config");
    } catch (err) {
      els.priceNote.textContent = `Couldn't load current prices (${err.message}). Please refresh.`;
      els.deliverySub.textContent = "Shipping unavailable right now.";
      return;
    }
    render();
  }

  init();
})();
