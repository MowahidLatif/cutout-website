/**
 * Page logic for create.html: fetch pricing config, live-calculate price,
 * validate the form, upload the image, create the order, and redirect to
 * Stripe Checkout.
 */
(function () {
  let pricingConfig = null; // { rates, discountTiers, shippingRates }
  let uploadedImageUrl = null;
  let selectedFile = null;

  const form = document.getElementById("order-form");
  const statusEl = document.getElementById("form-status");
  const submitBtn = document.getElementById("submit-btn");

  const fields = {
    sizeTier: document.getElementById("size-tier"),
    material: document.getElementById("material"),
    quantity: document.getElementById("quantity"),
    height: document.getElementById("height"),
    email: document.getElementById("email"),
    phone: document.getElementById("phone"),
    line1: document.getElementById("line1"),
    line2: document.getElementById("line2"),
    city: document.getElementById("city"),
    region: document.getElementById("region"),
    postalCode: document.getElementById("postal-code"),
    country: document.getElementById("country"),
  };

  // ---------- Image upload ----------
  const dropzone = document.getElementById("dropzone");
  const dropzoneLabel = document.getElementById("dropzone-label");
  const imageInput = document.getElementById("image-input");
  const imagePreview = document.getElementById("image-preview");

  dropzone.addEventListener("click", () => imageInput.click());
  dropzone.addEventListener("dragover", (e) => e.preventDefault());
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  });
  imageInput.addEventListener("change", () => {
    if (imageInput.files && imageInput.files[0]) {
      handleFile(imageInput.files[0]);
    }
  });

  function handleFile(file) {
    selectedFile = file;
    uploadedImageUrl = null;
    const reader = new FileReader();
    reader.onload = (e) => {
      imagePreview.src = e.target.result;
      imagePreview.style.display = "block";
      dropzoneLabel.textContent = file.name;
      dropzone.classList.add("has-image");
    };
    reader.readAsDataURL(file);
    clearFieldError(document.getElementById("image-input"));
    recalculatePrice();
  }

  async function uploadImage(file) {
    // Ask the backend for a presigned S3 URL, then PUT the file directly.
    const presign = await Api.post("/uploads/presigned-url", {
      fileName: file.name,
      contentType: file.type,
    });
    await fetch(presign.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
    return presign.publicUrl;
  }

  // ---------- Live pricing ----------
  [fields.sizeTier, fields.material, fields.quantity, fields.country].forEach((el) => {
    el.addEventListener("change", recalculatePrice);
    el.addEventListener("input", recalculatePrice);
  });

  function recalculatePrice() {
    if (!pricingConfig) return;

    const result = Pricing.calculatePrice({
      sizeTier: fields.sizeTier.value,
      material: fields.material.value,
      quantity: Number(fields.quantity.value),
      rates: pricingConfig.rates,
      discountTiers: pricingConfig.discountTiers,
    });

    const totalEl = document.getElementById("price-total");
    const breakdownEl = document.getElementById("price-breakdown");
    const discountTag = document.getElementById("discount-tag");

    if (!result) {
      totalEl.textContent = "$0.00";
      breakdownEl.textContent = "Select a size and material to see your price.";
      discountTag.style.display = "none";
      return;
    }

    const shipping = Pricing.calculateShipping({
      country: fields.country.value,
      sizeTier: fields.sizeTier.value,
      quantity: Number(fields.quantity.value),
      shippingRates: pricingConfig.shippingRates,
    });

    const itemsLine = `${formatCurrency(result.unitPrice)} each × ${fields.quantity.value}`;
    if (shipping === null) {
      totalEl.textContent = formatCurrency(result.total);
      breakdownEl.textContent = `${itemsLine} — shipping calculated once you choose a country`;
    } else {
      totalEl.textContent = formatCurrency(result.total + shipping);
      breakdownEl.textContent = `${itemsLine} + ${formatCurrency(shipping)} shipping`;
    }

    if (result.discountPct > 0) {
      discountTag.textContent = `${result.discountPct}% bulk discount`;
      discountTag.style.display = "inline-block";
    } else {
      discountTag.style.display = "none";
    }
  }

  function formatCurrency(n) {
    return "$" + Number(n).toFixed(2);
  }

  // ---------- Validation ----------
  function setFieldError(el, hasError) {
    const field = el.closest(".field");
    if (!field) return;
    field.classList.toggle("has-error", hasError);
  }

  function clearFieldError(el) {
    setFieldError(el, false);
  }

  function validate() {
    let valid = true;

    if (!selectedFile) {
      setFieldError(imageInput, true);
      valid = false;
    } else {
      clearFieldError(imageInput);
    }

    const requiredTextFields = [
      fields.sizeTier,
      fields.material,
      fields.quantity,
      fields.height,
      fields.email,
      fields.phone,
      fields.line1,
      fields.city,
      fields.region,
      fields.postalCode,
      fields.country,
    ];

    requiredTextFields.forEach((el) => {
      const value = (el.value || "").trim();
      const ok = value.length > 0;
      setFieldError(el, !ok);
      if (!ok) valid = false;
    });

    if (fields.quantity.value && Number(fields.quantity.value) < 1) {
      setFieldError(fields.quantity, true);
      valid = false;
    }

    if (fields.email.value && !/^\S+@\S+\.\S+$/.test(fields.email.value)) {
      setFieldError(fields.email, true);
      valid = false;
    }

    return valid;
  }

  // ---------- Submit ----------
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideStatus();

    if (!validate()) {
      showStatus("Please fix the highlighted fields above.", "error");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Processing…";

    try {
      if (!uploadedImageUrl) {
        uploadedImageUrl = await uploadImage(selectedFile);
      }

      const order = await Api.post("/orders", {
        customerEmail: fields.email.value.trim(),
        customerPhone: fields.phone.value.trim(),
        shippingAddress: {
          line1: fields.line1.value.trim(),
          line2: fields.line2.value.trim(),
          city: fields.city.value.trim(),
          region: fields.region.value.trim(),
          postalCode: fields.postalCode.value.trim(),
          country: fields.country.value.trim(),
        },
        items: [
          {
            imageUrl: uploadedImageUrl,
            sizeTier: fields.sizeTier.value,
            material: fields.material.value,
            heightIn: Number(fields.height.value),
            quantity: Number(fields.quantity.value),
          },
        ],
      });

      const checkout = await Api.post(`/orders/${order.id}/checkout-session`, {});
      window.location.href = checkout.url;
    } catch (err) {
      showStatus("Something went wrong: " + err.message, "error");
      submitBtn.disabled = false;
      submitBtn.textContent = "Pay with Stripe";
    }
  });

  function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = "status-message visible " + type;
  }

  function hideStatus() {
    statusEl.className = "status-message";
  }

  // ---------- Init ----------
  async function init() {
    try {
      pricingConfig = await Api.get("/pricing-config");
      submitBtn.disabled = false;
      recalculatePrice();
    } catch (err) {
      showStatus(
        "Couldn't load current pricing (" + err.message + "). Please refresh and try again.",
        "error"
      );
    }
  }

  init();
})();
