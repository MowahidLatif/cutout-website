/**
 * Page logic for pricing.html: renders the live rate, discount and shipping
 * tables from GET /api/pricing-config. (A file, not an inline <script>, so
 * the Content-Security-Policy can forbid inline scripts.)
 */
(function () {
  document.getElementById("year").textContent = new Date().getFullYear();

  const SIZE_LABELS = {
    small: "Small (up to 3ft)",
    medium: "Medium (3–5ft)",
    life_size: "Life-size (5–6.5ft)",
    xl: "XL (6.5ft+)",
  };
  const MATERIAL_LABELS = {
    cardboard: "Cardboard",
    coroplast: "Coroplast",
    foam_board: "Foam board",
    acrylic: "Acrylic",
  };
  const COUNTRY_LABELS = {
    CA: "Canada",
    US: "United States",
  };

  function showError(message) {
    const el = document.getElementById("status");
    el.textContent = message;
    el.classList.add("visible");
  }

  function formatCurrency(n) {
    return "$" + Number(n).toFixed(2);
  }

  async function loadPricing() {
    try {
      const data = await Api.get("/pricing-config");
      renderRates(data.rates || []);
      renderDiscounts(data.discountTiers || []);
      renderShipping(data.shippingRates || []);
    } catch (err) {
      showError(
        "Couldn't load current pricing (" + err.message + "). Please try again shortly."
      );
      document.getElementById("rates-body").innerHTML =
        "<tr><td colspan=\"3\">Unavailable</td></tr>";
      document.getElementById("discount-body").innerHTML =
        "<tr><td colspan=\"2\">Unavailable</td></tr>";
      document.getElementById("shipping-body").innerHTML =
        "<tr><td colspan=\"4\">Unavailable</td></tr>";
    }
  }

  function renderRates(rates) {
    const body = document.getElementById("rates-body");
    if (!rates.length) {
      body.innerHTML = "<tr><td colspan=\"3\">No rates configured yet.</td></tr>";
      return;
    }
    body.innerHTML = rates
      .map(
        (r) => `
      <tr>
        <td>${SIZE_LABELS[r.sizeTier] || r.sizeTier}</td>
        <td>${MATERIAL_LABELS[r.material] || r.material}</td>
        <td>${formatCurrency(r.baseRate)}</td>
      </tr>`
      )
      .join("");
  }

  function renderDiscounts(tiers) {
    const body = document.getElementById("discount-body");
    if (!tiers.length) {
      body.innerHTML = "<tr><td colspan=\"2\">No discount tiers configured yet.</td></tr>";
      return;
    }
    body.innerHTML = tiers
      .map((t) => {
        const range = t.maxQty ? `${t.minQty}–${t.maxQty}` : `${t.minQty}+`;
        return `
      <tr>
        <td>${range}</td>
        <td>${Number(t.discountPct) > 0 ? t.discountPct + "% off" : "—"}</td>
      </tr>`;
      })
      .join("");
  }

  function renderShipping(shippingRates) {
    const body = document.getElementById("shipping-body");
    if (!shippingRates.length) {
      body.innerHTML = "<tr><td colspan=\"4\">No shipping rates configured yet.</td></tr>";
      return;
    }
    body.innerHTML = shippingRates
      .map(
        (s) => `
      <tr>
        <td>${COUNTRY_LABELS[s.country] || s.country}</td>
        <td>${SIZE_LABELS[s.sizeTier] || s.sizeTier}</td>
        <td>${formatCurrency(s.firstUnitRate)}</td>
        <td>${formatCurrency(s.additionalUnitRate)}</td>
      </tr>`
      )
      .join("");
  }

  loadPricing();
})();
