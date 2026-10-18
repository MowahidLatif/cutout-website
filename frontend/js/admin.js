/**
 * Page logic for admin.html: sign in with the shared admin token, list
 * orders, and show/refresh the expiring image download links to forward
 * to the supplier.
 */
(function () {
  document.getElementById("year").textContent = new Date().getFullYear();

  const TOKEN_KEY = "cutoutAdminToken";
  const statusEl = document.getElementById("status");
  const tokenForm = document.getElementById("token-form");
  const ordersSection = document.getElementById("orders-section");
  const ordersBody = document.getElementById("orders-body");
  const statusFilter = document.getElementById("status-filter");
  const detailEl = document.getElementById("order-detail");

  // ---------- Token ----------
  let memoryToken = null; // fallback if sessionStorage is blocked
  function getToken() {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch (e) {
      return memoryToken;
    }
  }
  function setToken(token) {
    memoryToken = token;
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      // Storage blocked — the in-memory copy still works for this page load.
    }
  }

  function authHeaders() {
    return { "X-Admin-Token": getToken() || "" };
  }

  function showSignIn(message) {
    setToken(null);
    ordersSection.style.display = "none";
    tokenForm.style.display = "block";
    if (message) showStatus(message);
  }

  tokenForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const token = document.getElementById("admin-token").value.trim();
    if (!token) return;
    setToken(token);
    hideStatus();
    tokenForm.style.display = "none";
    loadOrders();
  });

  document.getElementById("sign-out").addEventListener("click", (e) => {
    e.preventDefault();
    showSignIn();
  });

  /** Wraps an admin API call so a 401 sends you back to the sign-in form. */
  async function adminCall(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 401) {
        showSignIn("That admin token wasn't accepted. Please sign in again.");
      } else {
        showStatus(err.message);
      }
      throw err;
    }
  }

  // ---------- Orders list ----------
  statusFilter.addEventListener("change", loadOrders);

  async function loadOrders() {
    hideStatus();
    detailEl.style.display = "none";
    const query = statusFilter.value ? `?status=${encodeURIComponent(statusFilter.value)}` : "";
    let orders;
    try {
      orders = await adminCall(() => Api.get(`/admin/orders${query}`, authHeaders()));
    } catch (err) {
      return;
    }
    ordersSection.style.display = "block";

    if (!orders.length) {
      ordersBody.innerHTML = '<tr><td colspan="5">No orders.</td></tr>';
      return;
    }
    ordersBody.innerHTML = orders
      .map(
        (o) => `
      <tr>
        <td>${escapeHtml(new Date(o.createdAt).toLocaleString())}</td>
        <td>${escapeHtml(o.customerEmail)}</td>
        <td>${escapeHtml(o.status)}</td>
        <td>${formatCurrency(o.totalPrice)}</td>
        <td><button type="button" class="btn btn-secondary" data-order-id="${escapeHtml(o.id)}">Open</button></td>
      </tr>`
      )
      .join("");
  }

  ordersBody.addEventListener("click", (e) => {
    const button = e.target.closest("[data-order-id]");
    if (button) openOrder(button.dataset.orderId);
  });

  // ---------- Order detail ----------
  async function openOrder(orderId) {
    hideStatus();
    let order;
    try {
      order = await adminCall(() =>
        Api.get(`/admin/orders/${encodeURIComponent(orderId)}`, authHeaders())
      );
    } catch (err) {
      return;
    }

    const addr = order.shippingAddress || {};
    detailEl.innerHTML = `
      <h2 style="margin-top:0">Order ${escapeHtml(order.id)}</h2>
      <p>
        <strong>Status:</strong> ${escapeHtml(order.status)}<br />
        <strong>Customer:</strong> ${escapeHtml(order.customerEmail)} / ${escapeHtml(order.customerPhone)}<br />
        <strong>Ship to:</strong> ${escapeHtml(
          [addr.line1, addr.line2, addr.city, addr.region, addr.postalCode, addr.country]
            .filter(Boolean)
            .join(", ")
        )}<br />
        <strong>Totals:</strong> subtotal ${formatCurrency(order.subtotal)},
        discount ${formatCurrency(order.discountAmount)},
        shipping ${formatCurrency(order.shippingAmount)},
        <strong>total ${formatCurrency(order.totalPrice)}</strong>
      </p>
      <h3>Items</h3>
      ${order.items
        .map(
          (item) => `
        <div class="card" style="margin-bottom:1rem" data-item-id="${escapeHtml(item.id)}">
          <p style="margin-top:0">
            ${escapeHtml(item.quantity)} × ${escapeHtml(item.sizeTier)} / ${escapeHtml(item.material)},
            height ${escapeHtml(item.heightIn)}in
          </p>
          <div class="item-link">${renderLink(item.downloadUrl, item.downloadExpiresAt)}</div>
        </div>`
        )
        .join("")}
      <button type="button" class="btn btn-secondary" id="refresh-links">Generate fresh links</button>
    `;
    detailEl.style.display = "block";
    detailEl.scrollIntoView({ behavior: "smooth", block: "start" });

    document.getElementById("refresh-links").addEventListener("click", () => refreshLinks(order.id));
  }

  async function refreshLinks(orderId) {
    hideStatus();
    let links;
    try {
      links = await adminCall(() =>
        Api.post(`/admin/orders/${encodeURIComponent(orderId)}/download-links`, {}, authHeaders())
      );
    } catch (err) {
      return;
    }
    links.forEach((link) => {
      const card = detailEl.querySelector(`[data-item-id="${CSS.escape(link.itemId)}"] .item-link`);
      if (card) card.innerHTML = renderLink(link.url, link.expiresAt);
    });
    showStatus("Fresh links generated.", "success");
  }

  function renderLink(url, expiresAt) {
    if (!url) {
      return "<em>No downloadable image for this item (created before image keys were introduced).</em>";
    }
    return `
      <a class="btn btn-primary" href="${escapeHtml(url)}">Download image</a>
      <button type="button" class="btn btn-secondary" data-copy="${escapeHtml(url)}">Copy link</button>
      <span class="hint" style="margin-left:0.5rem">Expires ${escapeHtml(new Date(expiresAt).toLocaleDateString())}</span>`;
  }

  detailEl.addEventListener("click", async (e) => {
    const button = e.target.closest("[data-copy]");
    if (!button) return;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "Copied!";
    } catch (err) {
      window.prompt("Copy this link:", button.dataset.copy);
    }
  });

  // ---------- Helpers ----------
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

  function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = "status-message visible " + (type || "error");
  }

  function hideStatus() {
    statusEl.className = "status-message";
  }

  // ---------- Init ----------
  if (getToken()) {
    loadOrders();
  } else {
    showSignIn();
  }
})();
