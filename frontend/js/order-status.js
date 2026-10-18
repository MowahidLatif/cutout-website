/**
 * Page logic for order-status.html: look up an order by ID + email.
 */
(function () {
  // Stripe sends the customer back here as order-status.html?order=<id>
  // after paying: prefill the ID, and the cart's job is done.
  const orderFromUrl = new URLSearchParams(window.location.search).get("order");
  if (orderFromUrl) {
    document.getElementById("order-id").value = orderFromUrl;
    if (window.Cart) window.Cart.clear();
  }

  const form = document.getElementById("lookup-form");
  const statusEl = document.getElementById("status");
  const resultCard = document.getElementById("result");

  const STATUS_LABELS = {
    pending_payment: "Payment pending",
    paid: "Paid — queued for production",
    in_production: "In production",
    shipped: "Shipped",
    delivered: "Delivered",
    cancelled: "Cancelled",
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideStatus();
    resultCard.style.display = "none";

    const orderId = document.getElementById("order-id").value.trim();
    const email = document.getElementById("lookup-email").value.trim();

    if (!orderId || !email) {
      showStatus("Enter both your order ID and email.");
      return;
    }

    try {
      const order = await Api.get(
        `/orders/${encodeURIComponent(orderId)}?email=${encodeURIComponent(email)}`
      );
      renderResult(order);
    } catch (err) {
      showStatus("Couldn't find that order: " + err.message);
    }
  });

  function renderResult(order) {
    document.getElementById("result-id").textContent = order.id;
    document.getElementById("result-status").textContent =
      STATUS_LABELS[order.status] || order.status;

    const itemsEl = document.getElementById("result-items");
    const items = order.items || [];
    itemsEl.innerHTML = items
      .map(
        (item) => `
      <p>
        ${item.quantity} × ${item.sizeTier}, ${item.material}
        (${item.heightIn}in)
      </p>`
      )
      .join("");

    resultCard.style.display = "block";
  }

  function showStatus(message) {
    statusEl.textContent = message;
    statusEl.classList.add("visible");
  }

  function hideStatus() {
    statusEl.classList.remove("visible");
  }
})();
