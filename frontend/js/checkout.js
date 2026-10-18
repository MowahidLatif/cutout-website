/**
 * Page logic for checkout.html: show the cart, collect contact + shipping
 * details, show a live order summary, then create the order and redirect
 * to Stripe Checkout.
 *
 * The summary uses the same formula as the backend (js/pricing.js), but
 * the backend recomputes every price from scratch when the order is created.
 */
(function () {
  const SITE = window.SITE;
  let pricingConfig = null;

  const $ = (id) => document.getElementById(id);
  const form = $("checkout-form");
  const emptyEl = $("empty-cart");
  const listEl = $("cart-list");
  const summaryEl = $("summary-rows");
  const statusEl = $("form-status");
  const submitBtn = $("submit-btn");

  const fields = {
    email: $("email"),
    phone: $("phone"),
    country: $("country"),
    line1: $("line1"),
    line2: $("line2"),
    city: $("city"),
    region: $("region"),
    postalCode: $("postal-code"),
  };

  // ---------- Helpers ----------
  function formatCurrency(n) {
    return "$" + Number(n).toFixed(2);
  }

  function formatFeetInches(inches) {
    const total = Math.round(inches);
    return `${Math.floor(total / 12)}'${total % 12}"`;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function materialName(id) {
    const m = SITE.materials.find((x) => x.id === id);
    return m ? m.name : id;
  }

  /** Prices one cart item with the live config; null if config isn't loaded. */
  function priceItem(item) {
    if (!pricingConfig) return null;
    const sizeTier = Pricing.sizeTierForHeight(item.heightIn);
    const price = Pricing.calculatePrice({
      sizeTier,
      material: item.material,
      quantity: item.quantity,
      rates: pricingConfig.rates,
      discountTiers: pricingConfig.discountTiers,
    });
    const shipping = Pricing.calculateShipping({
      country: fields.country.value,
      sizeTier,
      quantity: item.quantity,
      shippingRates: pricingConfig.shippingRates,
    });
    return { sizeTier, price, shipping };
  }

  // ---------- Render ----------
  function render() {
    const items = Cart.get();
    emptyEl.hidden = items.length > 0;
    form.hidden = items.length === 0;
    if (!items.length) return;

    listEl.innerHTML = items
      .map((item) => {
        const priced = priceItem(item);
        const tier = SITE.tierLabels[Pricing.sizeTierForHeight(item.heightIn)];
        const dims = `${formatFeetInches(item.heightIn)} tall${item.widthIn ? ` × ${formatFeetInches(item.widthIn)} wide` : ""}`;
        const texts = (item.textElements || [])
          .map((t) => `${SITE.textStyles[t.style] || t.style}: “${escapeHtml(t.text)}”`)
          .join(" · ");
        return `
        <article class="cart-item" data-id="${escapeHtml(item.id)}">
          ${
            item.thumbnail
              ? `<img class="cart-item__thumb" src="${escapeHtml(item.thumbnail)}" alt="Your photo" />`
              : '<div class="cart-item__thumb"></div>'
          }
          <div>
            <p class="cart-item__title">${escapeHtml(tier)} standee · ${escapeHtml(materialName(item.material))}</p>
            <p class="cart-item__meta">${escapeHtml(dims)}</p>
            ${texts ? `<p class="cart-item__meta">${texts}</p>` : ""}
          </div>
          <div class="cart-item__actions">
            <div class="stepper" aria-label="Quantity">
              <button type="button" data-qty="-1" aria-label="Fewer"${item.quantity <= 1 ? " disabled" : ""}><svg class="icon"><use href="#i-minus"/></svg></button>
              <input type="number" min="1" max="99" value="${item.quantity}" aria-label="Quantity" data-qty-input />
              <button type="button" data-qty="1" aria-label="More"><svg class="icon"><use href="#i-plus"/></svg></button>
            </div>
            <span class="cart-item__price">${priced && priced.price ? formatCurrency(priced.price.total) : ""}</span>
            <button type="button" class="link-accent" data-remove style="font-size:0.9rem">Remove</button>
          </div>
        </article>`;
      })
      .join("");

    renderSummary(items);
  }

  function renderSummary(items) {
    if (!pricingConfig) {
      summaryEl.innerHTML = "<div><dt>Loading prices…</dt><dd></dd></div>";
      submitBtn.disabled = true;
      return;
    }
    let subtotal = 0;
    let itemsTotal = 0;
    let shipping = 0;
    let shippingKnown = Boolean(fields.country.value);
    for (const item of items) {
      const { price, shipping: s } = priceItem(item);
      if (!price) continue;
      subtotal += price.subtotal;
      itemsTotal += price.total;
      if (s === null) shippingKnown = false;
      else shipping += s;
    }
    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const discount = round2(subtotal - itemsTotal);
    const count = items.reduce((n, i) => n + i.quantity, 0);

    const rows = [[`Standees (${count})`, formatCurrency(subtotal)]];
    if (discount > 0) rows.push(["Bulk discount", "−" + formatCurrency(discount), "is-discount"]);
    rows.push(["Shipping", shippingKnown ? formatCurrency(shipping) : "Choose a country"]);
    rows.push(["Total", formatCurrency(round2(itemsTotal + (shippingKnown ? shipping : 0))), "is-total"]);

    summaryEl.innerHTML = rows
      .map(([dt, dd, cls]) => `<div class="${cls || ""}"><dt>${dt}</dt><dd>${dd}</dd></div>`)
      .join("");
    submitBtn.disabled = false;
  }

  // ---------- Cart edits ----------
  listEl.addEventListener("click", (e) => {
    const row = e.target.closest(".cart-item");
    if (!row) return;
    const item = Cart.get().find((i) => i.id === row.dataset.id);
    if (!item) return;
    const step = e.target.closest("[data-qty]");
    if (step) {
      Cart.update(item.id, { quantity: Math.min(99, Math.max(1, item.quantity + Number(step.dataset.qty))) });
      render();
    } else if (e.target.closest("[data-remove]")) {
      Cart.remove(item.id);
      render();
    }
  });

  listEl.addEventListener("change", (e) => {
    if (!e.target.matches("[data-qty-input]")) return;
    const id = e.target.closest(".cart-item").dataset.id;
    Cart.update(id, { quantity: Math.min(99, Math.max(1, Math.round(Number(e.target.value)) || 1)) });
    render();
  });

  fields.country.addEventListener("change", () => render());
  window.addEventListener("storage", render);

  // ---------- Validation ----------
  function setFieldError(el, hasError) {
    const field = el.closest(".field");
    if (field) field.classList.toggle("has-error", hasError);
  }

  function validate() {
    let valid = true;
    const required = [fields.email, fields.phone, fields.country, fields.line1, fields.city, fields.region, fields.postalCode];
    required.forEach((el) => {
      const ok = (el.value || "").trim().length > 0;
      setFieldError(el, !ok);
      if (!ok) valid = false;
    });
    if (fields.email.value && !/^\S+@\S+\.\S+$/.test(fields.email.value.trim())) {
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
      showStatus("Please fix the highlighted fields.");
      return;
    }
    const items = Cart.get();
    if (!items.length) return;

    submitBtn.disabled = true;
    submitBtn.textContent = "Processing…";
    try {
      const order = await Api.post("/orders", {
        customerEmail: fields.email.value.trim(),
        customerPhone: fields.phone.value.trim(),
        shippingAddress: {
          line1: fields.line1.value.trim(),
          line2: fields.line2.value.trim(),
          city: fields.city.value.trim(),
          region: fields.region.value.trim(),
          postalCode: fields.postalCode.value.trim(),
          country: fields.country.value,
        },
        items: items.map((item) => ({
          imageKey: item.imageKey,
          heightIn: item.heightIn,
          widthIn: item.widthIn,
          material: item.material,
          quantity: item.quantity,
          textElements: item.textElements || [],
        })),
      });
      const checkout = await Api.post(`/orders/${order.id}/checkout-session`, {});
      // The cart is cleared when Stripe sends the customer back to order-status.html.
      window.location.href = checkout.url;
    } catch (err) {
      const hint = /photo not found/i.test(err.message)
        ? " One of the photos in your cart has expired — remove that item and add it again from the studio."
        : "";
      showStatus("Something went wrong: " + err.message + hint);
      submitBtn.disabled = false;
      submitBtn.textContent = "Pay with Stripe";
    }
  });

  function showStatus(message) {
    statusEl.textContent = message;
    statusEl.classList.add("visible");
    statusEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function hideStatus() {
    statusEl.classList.remove("visible");
  }

  // ---------- Init ----------
  async function init() {
    render();
    try {
      pricingConfig = await Api.get("/pricing-config");
    } catch (err) {
      showStatus(`Couldn't load current prices (${err.message}). Please refresh.`);
      return;
    }
    render();
  }

  init();
})();
