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
  const acceptFinalSale = $("accept-final-sale");
  const consentEl = $("final-sale-consent");

  const fields = {
    name: $("customer-name"),
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
    return "$" + Number(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    return { sizeTier, price };
  }

  function qualityLine(item) {
    if (!item.widthPx || !item.heightPx) return "";
    const q = Pricing.printQuality({
      widthPx: item.widthPx,
      heightPx: item.heightPx,
      heightIn: item.heightIn,
      widthIn: item.widthIn,
    });
    const accepted = q.grade === "low" && item.acceptedLowQuality ? " (you confirmed)" : "";
    return `<p class="cart-item__meta">Print quality: ${SITE.qualityLabels[q.grade]}${accepted}</p>`;
  }

  /** What breaks the per-order limits, if anything (e.g. an old cart). */
  function limitProblem(items) {
    const { quantity, uniqueImages } = Cart.totals(items);
    if (quantity > SITE.maxOrderQuantity) {
      return `An order can have at most ${SITE.maxOrderQuantity} cutouts — your cart has ${quantity}. Lower some quantities.`;
    }
    if (uniqueImages > SITE.maxUniqueImages) {
      return `An order can have at most ${SITE.maxUniqueImages} different photos — your cart has ${uniqueImages}. Remove some designs.`;
    }
    return null;
  }

  /** Most this item can have: what's left of the 500 after the other items. */
  function maxQuantityFor(item, items) {
    const others = items.filter((i) => i.id !== item.id).reduce((n, i) => n + i.quantity, 0);
    return Math.max(item.quantity, Math.max(1, SITE.maxOrderQuantity - others));
  }

  function quantityInput(item, items) {
    return `<label class="qty-select">Qty
      <input type="number" inputmode="numeric" min="1" max="${maxQuantityFor(item, items)}" step="1" value="${item.quantity}"
        data-qty-input aria-label="Quantity" />
    </label>`;
  }

  function optionsLine(item) {
    const color = item.borderColor && SITE.borderColors.find((c) => c.hex === item.borderColor);
    const border = item.borderColor
      ? `Border: <span class="swatch-dot" style="background:${escapeHtml(item.borderColor)}"></span> ${escapeHtml(color ? color.name : item.borderColor)}`
      : "No border";
    const notes = item.notes ? ` · Notes: “${escapeHtml(item.notes)}”` : "";
    return `<p class="cart-item__meta">${border}${notes}</p>`;
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
            ${optionsLine(item)}
            ${qualityLine(item)}
          </div>
          <div class="cart-item__actions">
            ${quantityInput(item, items)}
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
    const shippingItems = [];
    for (const item of items) {
      const { sizeTier, price } = priceItem(item);
      if (!price) continue;
      subtotal += price.subtotal;
      itemsTotal += price.total;
      shippingItems.push({ sizeTier, quantity: item.quantity });
    }
    // Shipping is priced for the whole order: one first-unit charge.
    const shipping = Pricing.calculateOrderShipping({
      country: fields.country.value,
      items: shippingItems,
      shippingRates: pricingConfig.shippingRates,
    });
    const shippingKnown = shipping !== null;
    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const discount = round2(subtotal - itemsTotal);
    const count = items.reduce((n, i) => n + i.quantity, 0);
    const designs = items.length;

    const rows = [[`${count} cutout${count === 1 ? "" : "s"} · ${designs} design${designs === 1 ? "" : "s"}`, formatCurrency(subtotal)]];
    if (discount > 0) rows.push(["Bulk discount", "−" + formatCurrency(discount), "is-discount"]);
    rows.push(["Shipping", shippingKnown ? formatCurrency(shipping) : "Choose a country"]);
    rows.push([`Total (${pricingConfig.currency || SITE.currency})`, formatCurrency(round2(itemsTotal + (shippingKnown ? shipping : 0))), "is-total"]);

    summaryEl.innerHTML = rows
      .map(([dt, dd, cls]) => `<div class="${cls || ""}"><dt>${dt}</dt><dd>${dd}</dd></div>`)
      .join("");

    const problem = limitProblem(items);
    submitBtn.disabled = Boolean(problem);
    if (problem) showStatus(problem, { scroll: false });
  }

  // ---------- Cart edits ----------
  listEl.addEventListener("click", (e) => {
    const row = e.target.closest(".cart-item");
    if (!row) return;
    const item = Cart.get().find((i) => i.id === row.dataset.id);
    if (!item) return;
    if (e.target.closest("[data-remove]")) {
      Cart.remove(item.id);
      hideStatus();
      render();
    }
  });

  /** A typed quantity, kept within 1 … the item's max; null while the box is empty. */
  function typedQuantity(input) {
    const raw = input.value.trim() === "" ? NaN : Number(input.value);
    if (!Number.isFinite(raw)) return null;
    return Math.min(Number(input.max), Math.max(1, Math.round(raw)));
  }

  // While typing: update the cart, this row's price and the summary, without
  // rebuilding the list (that would drop focus). On leaving the box: clamp it.
  listEl.addEventListener("input", (e) => {
    if (!e.target.matches("[data-qty-input]")) return;
    const row = e.target.closest(".cart-item");
    const quantity = typedQuantity(e.target);
    if (quantity === null) return;
    Cart.update(row.dataset.id, { quantity });
    const item = Cart.get().find((i) => i.id === row.dataset.id);
    const priced = priceItem(item);
    row.querySelector(".cart-item__price").textContent = priced && priced.price ? formatCurrency(priced.price.total) : "";
    hideStatus();
    renderSummary(Cart.get());
  });

  listEl.addEventListener("change", (e) => {
    if (!e.target.matches("[data-qty-input]")) return;
    const id = e.target.closest(".cart-item").dataset.id;
    const raw = Number(e.target.value);
    const quantity = typedQuantity(e.target) || Cart.get().find((i) => i.id === id).quantity;
    Cart.update(id, { quantity });
    hideStatus();
    render();
    if (raw > quantity) {
      showStatus(`Max ${quantity} for that design — an order can have ${SITE.maxOrderQuantity} cutouts in total.`, { scroll: false });
    }
  });

  fields.country.addEventListener("change", () => render());
  acceptFinalSale.addEventListener("change", () => {
    if (acceptFinalSale.checked) consentEl.classList.remove("has-error");
  });
  window.addEventListener("storage", render);

  // ---------- Validation ----------
  function setFieldError(el, hasError) {
    const field = el.closest(".field");
    if (field) field.classList.toggle("has-error", hasError);
  }

  function validate() {
    let valid = true;
    const required = [fields.name, fields.email, fields.phone, fields.country, fields.line1, fields.city, fields.region, fields.postalCode];
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

  /** The customer must acknowledge the final-sale policy before paying. */
  function validateConsent() {
    consentEl.classList.toggle("has-error", !acceptFinalSale.checked);
    return acceptFinalSale.checked;
  }

  // ---------- Submit ----------
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideStatus();
    const fieldsOk = validate();
    const consentOk = validateConsent();
    if (!fieldsOk) {
      showStatus("Please fix the highlighted fields.");
      return;
    }
    if (!consentOk) {
      showStatus("Please confirm you understand your standee is custom-made and final sale.");
      return;
    }
    const items = Cart.get();
    if (!items.length) return;

    submitBtn.disabled = true;
    submitBtn.textContent = "Processing…";
    try {
      const order = await Api.post("/orders", {
        customerName: fields.name.value.trim(),
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
        acceptedFinalSale: acceptFinalSale.checked,
        items: items.map((item) => ({
          imageKey: item.imageKey,
          heightIn: item.heightIn,
          widthIn: item.widthIn,
          material: item.material,
          quantity: item.quantity,
          textElements: item.textElements || [],
          acceptedLowQuality: item.acceptedLowQuality === true,
          borderColor: item.borderColor === undefined ? SITE.defaultBorderColor : item.borderColor, // older carts: the old default
          notes: item.notes || null,
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

  function showStatus(message, { scroll = true } = {}) {
    statusEl.textContent = message;
    statusEl.classList.add("visible");
    if (scroll) statusEl.scrollIntoView({ behavior: "smooth", block: "center" });
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
