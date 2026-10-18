/**
 * Page logic for admin.html: sign in with the shared admin token, list
 * orders, show/refresh the expiring image download links to forward to
 * the supplier, and change order status (recorded in the order history).
 *
 * The token and name live in sessionStorage only: they're gone when this
 * tab closes, and the token is only ever sent in a header, never in a URL.
 */
(function () {
  document.getElementById("year").textContent = new Date().getFullYear();

  const TOKEN_KEY = "cutoutAdminToken";
  const NAME_KEY = "cutoutAdminName";
  const statusEl = document.getElementById("status");
  const tokenForm = document.getElementById("token-form");
  const tokenInput = document.getElementById("admin-token");
  const nameInput = document.getElementById("admin-name");
  const ordersSection = document.getElementById("orders-section");
  const ordersBody = document.getElementById("orders-body");
  const statusFilter = document.getElementById("status-filter");
  const detailEl = document.getElementById("order-detail");

  const STATUS_OPTIONS = ["in_production", "shipped", "delivered", "cancelled"];

  // ---------- Session-only credentials ----------
  const memory = {}; // fallback if sessionStorage is blocked
  function sessionGet(key) {
    try {
      return sessionStorage.getItem(key);
    } catch (e) {
      return memory[key] || null;
    }
  }
  function sessionSet(key, value) {
    memory[key] = value;
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    } catch (e) {
      // Storage blocked — the in-memory copy still works for this page load.
    }
  }

  function authHeaders() {
    return {
      "X-Admin-Token": sessionGet(TOKEN_KEY) || "",
      "X-Admin-Name": sessionGet(NAME_KEY) || "",
    };
  }

  function showSignIn(message) {
    sessionSet(TOKEN_KEY, null);
    ordersSection.style.display = "none";
    tokenForm.style.display = "block";
    nameInput.value = sessionGet(NAME_KEY) || "";
    if (message) showStatus(message);
  }

  tokenForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const token = tokenInput.value.trim();
    const name = nameInput.value.trim();
    if (!token || !name) {
      showStatus("Enter your name and the admin token.");
      return;
    }
    sessionSet(TOKEN_KEY, token);
    sessionSet(NAME_KEY, name);
    tokenInput.value = "";
    hideStatus();
    tokenForm.style.display = "none";
    loadOrders();
  });

  document.getElementById("sign-out").addEventListener("click", (e) => {
    e.preventDefault();
    showSignIn();
  });

  /** Wraps an admin API call so a 401/429 sends you back to the sign-in form. */
  async function adminCall(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 401) {
        showSignIn("That admin token wasn't accepted. Please sign in again.");
      } else if (err.status === 429) {
        const minutes = err.retryAfter ? Math.ceil(err.retryAfter / 60) : 15;
        showSignIn(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
      } else {
        showStatus(err.message);
      }
      throw err;
    }
  }

  // ---------- Orders list ----------
  statusFilter.addEventListener("change", () => loadOrders());

  /** @param {{ keepDetail?: boolean }} [options] keepDetail refreshes the list without closing the open order */
  async function loadOrders({ keepDetail = false } = {}) {
    if (!keepDetail) {
      hideStatus();
      detailEl.style.display = "none";
    }
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
            height ${escapeHtml(item.heightIn)}in${item.widthIn ? `, width ${escapeHtml(item.widthIn)}in` : ""}
          </p>
          ${(item.textElements || [])
            .map((el) => `<p class="hint">Text (${escapeHtml(el.style)}): “${escapeHtml(el.text)}”</p>`)
            .join("")}
          <div class="item-link">${renderLink(item.downloadUrl, item.downloadExpiresAt)}</div>
        </div>`
        )
        .join("")}
      <button type="button" class="btn btn-secondary" id="refresh-links">Generate fresh links</button>

      <h3>Change status</h3>
      <div class="form-row cols-2">
        <div class="field">
          <label for="new-status">New status</label>
          <select id="new-status">
            ${STATUS_OPTIONS.map(
              (s) => `<option value="${s}"${s === order.status ? " disabled" : ""}>${s}</option>`
            ).join("")}
          </select>
          <span class="hint">"shipped" also emails the customer.</span>
        </div>
      </div>
      <button type="button" class="btn btn-primary" id="update-status" style="margin-top:0.75rem">Update status</button>

      <h3>History</h3>
      ${renderHistory(order.statusEvents || [])}
    `;
    detailEl.style.display = "block";
    detailEl.scrollIntoView({ behavior: "smooth", block: "start" });

    const select = document.getElementById("new-status");
    const firstEnabled = STATUS_OPTIONS.find((s) => s !== order.status);
    select.value = firstEnabled;

    document.getElementById("refresh-links").addEventListener("click", () => refreshLinks(order.id));
    document.getElementById("update-status").addEventListener("click", () =>
      updateStatus(order.id, select.value)
    );
  }

  async function updateStatus(orderId, status) {
    if (!window.confirm(`Change this order's status to "${status}"?`)) return;
    hideStatus();
    try {
      await adminCall(() =>
        Api.patch(`/admin/orders/${encodeURIComponent(orderId)}/status`, { status }, authHeaders())
      );
    } catch (err) {
      return;
    }
    await openOrder(orderId);
    showStatus(`Status changed to ${status}.`, "success");
    loadOrders({ keepDetail: true });
  }

  function renderHistory(events) {
    if (!events.length) {
      return "<p><em>No status changes recorded yet.</em></p>";
    }
    return `
      <div class="table-scroll"><table>
        <thead><tr><th>When</th><th>Change</th><th>By</th><th>IP</th></tr></thead>
        <tbody>
          ${events
            .map(
              (ev) => `
            <tr>
              <td>${escapeHtml(new Date(ev.createdAt).toLocaleString())}</td>
              <td>${escapeHtml(ev.fromStatus || "—")} → ${escapeHtml(ev.toStatus)}</td>
              <td title="${escapeHtml(ev.userAgent || "")}">${escapeHtml(ev.changedBy)}</td>
              <td>${escapeHtml(ev.ip || "—")}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table></div>`;
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
  if (sessionGet(TOKEN_KEY) && sessionGet(NAME_KEY)) {
    loadOrders();
  } else {
    showSignIn();
  }
})();
