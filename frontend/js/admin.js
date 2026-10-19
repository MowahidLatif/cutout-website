/**
 * Page logic for admin.html: sign in with the shared admin token, find
 * orders (status, search, dates, 25 per page), and work an order: details,
 * fresh image links, the supplier bundle, guarded status changes (tracking
 * required for "shipped"), internal notes and the status history.
 *
 * The token and name live in sessionStorage only: they're gone when this
 * tab closes, and the token is only ever sent as `Authorization: Bearer`,
 * never in a URL.
 */
(function () {
  const TOKEN_KEY = "cutoutAdminToken";
  const NAME_KEY = "cutoutAdminName";
  const $ = (id) => document.getElementById(id);

  const statusEl = $("status");
  const tokenForm = $("token-form");
  const tokenInput = $("admin-token");
  const nameInput = $("admin-name");
  const ordersSection = $("orders-section");
  const ordersBody = $("orders-body");
  const detailEl = $("order-detail");
  const filtersForm = $("filters");
  const filters = { status: $("status-filter"), q: $("search"), from: $("from-date"), to: $("to-date") };
  const pageInfo = $("page-info");
  const prevPage = $("prev-page");
  const nextPage = $("next-page");

  const STATUS_LABELS = {
    pending_payment: "Payment pending",
    paid: "Paid",
    in_production: "In production",
    shipped: "Shipped",
    delivered: "Delivered",
    cancelled: "Cancelled",
  };

  let currentPage = 1;

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
      Authorization: `Bearer ${sessionGet(TOKEN_KEY) || ""}`,
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

  $("sign-out").addEventListener("click", (e) => {
    e.preventDefault();
    detailEl.style.display = "none";
    showSignIn("Logged out.");
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
  filtersForm.addEventListener("submit", (e) => {
    e.preventDefault();
    currentPage = 1;
    loadOrders();
  });
  filters.status.addEventListener("change", () => {
    currentPage = 1;
    loadOrders();
  });
  $("clear-filters").addEventListener("click", () => {
    filters.status.value = "needs_action";
    filters.q.value = filters.from.value = filters.to.value = "";
    currentPage = 1;
    loadOrders();
  });
  prevPage.addEventListener("click", () => {
    currentPage = Math.max(1, currentPage - 1);
    loadOrders();
  });
  nextPage.addEventListener("click", () => {
    currentPage += 1;
    loadOrders();
  });

  async function loadOrders({ keepDetail = false } = {}) {
    if (!keepDetail) {
      hideStatus();
      detailEl.style.display = "none";
    }
    const params = new URLSearchParams({ status: filters.status.value, page: String(currentPage) });
    if (filters.q.value.trim()) params.set("q", filters.q.value.trim());
    if (filters.from.value) params.set("from", filters.from.value);
    if (filters.to.value) params.set("to", filters.to.value);
    let result;
    try {
      result = await adminCall(() => Api.get(`/admin/orders?${params}`, authHeaders()));
    } catch (err) {
      return;
    }
    ordersSection.style.display = "block";

    const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
    pageInfo.textContent = `Page ${result.page} of ${pages} · ${result.total} order${result.total === 1 ? "" : "s"}`;
    prevPage.disabled = result.page <= 1;
    nextPage.disabled = result.page >= pages;

    if (!result.orders.length) {
      ordersBody.innerHTML = '<tr><td colspan="8">No orders match these filters.</td></tr>';
      return;
    }
    ordersBody.innerHTML = result.orders
      .map(
        (o) => `
      <tr>
        <td data-label="Order"><code title="${escapeHtml(o.id)}">${escapeHtml(o.shortId)}</code></td>
        <td data-label="Created">${escapeHtml(new Date(o.createdAt).toLocaleDateString())}</td>
        <td data-label="Customer"><span>${escapeHtml(o.customerName || "—")}<br /><span class="hint">${escapeHtml(o.customerEmail)}</span></span></td>
        <td data-label="Status">${escapeHtml(STATUS_LABELS[o.status] || o.status)}</td>
        <td data-label="Total (CAD)">${formatCurrency(o.totalPrice)}</td>
        <td data-label="Items"><span>${escapeHtml(o.itemCount)} <span class="hint">(${escapeHtml(o.cutoutCount)} cutouts)</span></span></td>
        <td data-label="Country">${escapeHtml(o.country || "—")}</td>
        <td data-label=""><button type="button" class="btn btn-secondary btn-sm" data-order-id="${escapeHtml(o.id)}">Open</button></td>
      </tr>`
      )
      .join("");
  }

  ordersBody.addEventListener("click", (e) => {
    const button = e.target.closest("[data-order-id]");
    if (button) openOrder(button.dataset.orderId);
  });

  // ---------- Order detail ----------
  async function openOrder(orderId, { scroll = true } = {}) {
    let order;
    try {
      order = await adminCall(() => Api.get(`/admin/orders/${encodeURIComponent(orderId)}`, authHeaders()));
    } catch (err) {
      return;
    }
    const addr = order.shippingAddress || {};
    const next = order.allowedNextStatuses || [];

    detailEl.innerHTML = `
      <h2 style="margin-top:0">Order <code>${escapeHtml(order.id)}</code></h2>
      <p><strong>Status:</strong> ${escapeHtml(STATUS_LABELS[order.status] || order.status)}</p>
      <dl class="admin-grid">
        <div><dt>Customer</dt><dd>${escapeHtml(order.customerName || "—")}<br />${escapeHtml(order.customerEmail)}<br />${escapeHtml(order.customerPhone)}</dd></div>
        <div><dt>Ship to</dt><dd>${[addr.line1, addr.line2, `${addr.city || ""}, ${addr.region || ""} ${addr.postalCode || ""}`, addr.country]
          .filter(Boolean)
          .map(escapeHtml)
          .join("<br />")}</dd></div>
        <div><dt>Totals (${escapeHtml(order.currency || "CAD")})</dt><dd>
          Standees ${formatCurrency(order.subtotal)} · discount −${formatCurrency(order.discountAmount)}<br />
          Shipping ${formatCurrency(order.shippingAmount)} · <strong>total ${formatCurrency(order.totalPrice)}</strong></dd></div>
        <div><dt>Payment</dt><dd>Stripe payment: ${escapeHtml(order.stripePaymentIntentId || "not paid yet")}<br />
          Final sale accepted: ${order.finalSaleAcceptedAt ? escapeHtml(new Date(order.finalSaleAcceptedAt).toLocaleString()) + ` (policy ${escapeHtml(order.finalSalePolicyVersion)})` : "not recorded"}</dd></div>
        ${
          order.trackingNumber
            ? `<div><dt>Shipping</dt><dd>${escapeHtml(order.carrier)} · ${escapeHtml(order.trackingNumber)}${
                order.trackingUrl ? `<br /><a href="${escapeHtml(order.trackingUrl)}" target="_blank" rel="noopener">Tracking link</a>` : ""
              }<br />Shipped ${escapeHtml(new Date(order.shippedAt).toLocaleString())}</dd></div>`
            : ""
        }
      </dl>

      <div class="admin-actions">
        <button type="button" class="btn btn-primary" id="download-bundle">Download supplier bundle</button>
        <button type="button" class="btn btn-secondary" id="refresh-links">Generate fresh image links</button>
      </div>

      <h3>Items</h3>
      ${order.items.map(renderItem).join("")}

      <h3>Change status</h3>
      ${
        next.length
          ? `<form id="status-form" novalidate>
              <div class="form-row cols-2">
                <div class="field">
                  <label for="new-status">New status</label>
                  <select id="new-status">${next.map((s) => `<option value="${s}">${escapeHtml(STATUS_LABELS[s])}</option>`).join("")}</select>
                  <span class="hint">"Shipped" emails the customer their tracking details.</span>
                </div>
              </div>
              <div class="form-row cols-3" id="tracking-fields" style="margin-top:1rem">
                <div class="field"><label for="carrier">Carrier</label><input id="carrier" type="text" maxlength="100" placeholder="e.g. UPS" /></div>
                <div class="field"><label for="tracking-number">Tracking number</label><input id="tracking-number" type="text" maxlength="100" /></div>
                <div class="field"><label for="tracking-url">Tracking URL (optional)</label><input id="tracking-url" type="text" maxlength="500" placeholder="https://…" /></div>
              </div>
              <button type="submit" class="btn btn-primary" style="margin-top:1rem">Update status</button>
            </form>`
          : `<p class="hint">"${escapeHtml(STATUS_LABELS[order.status] || order.status)}" has no further status changes.</p>`
      }

      <h3>Internal notes</h3>
      <p class="hint">Only visible here — never shown to the customer.</p>
      <div id="notes-list">${renderNotes(order.notes || [])}</div>
      <form id="note-form" novalidate>
        <div class="field">
          <label for="note-body" class="visually-hidden">New note</label>
          <textarea id="note-body" rows="3" maxlength="2000" placeholder="Add a note…" style="width:100%;padding:0.75rem;border-radius:14px;border:1px solid var(--border-strong);font:inherit"></textarea>
        </div>
        <button type="submit" class="btn btn-secondary btn-sm" style="margin-top:0.5rem">Add note</button>
      </form>

      <h3>History</h3>
      ${renderHistory(order.statusEvents || [])}
    `;
    detailEl.style.display = "block";
    if (scroll) detailEl.scrollIntoView({ behavior: "smooth", block: "start" });

    $("download-bundle").addEventListener("click", () => downloadBundle(order.id));
    $("refresh-links").addEventListener("click", () => refreshLinks(order.id));
    $("note-form").addEventListener("submit", (e) => {
      e.preventDefault();
      addNote(order.id);
    });
    const statusForm = $("status-form");
    if (statusForm) {
      const select = $("new-status");
      const trackingFields = $("tracking-fields");
      const syncTracking = () => (trackingFields.hidden = select.value !== "shipped");
      select.addEventListener("change", syncTracking);
      syncTracking();
      statusForm.addEventListener("submit", (e) => {
        e.preventDefault();
        updateStatus(order.id, select.value);
      });
    }
  }

  function renderItem(item) {
    const size = item.widthIn
      ? `${formatFeetInches(item.heightIn)} tall × ${formatFeetInches(item.widthIn)} wide`
      : `${formatFeetInches(item.heightIn)} tall`;
    const quality =
      item.printPpi != null
        ? `Print quality ${escapeHtml(item.printScore ?? Math.min(100, item.printPpi * 2))}/100 · ${escapeHtml(item.imageWidthPx)}×${escapeHtml(item.imageHeightPx)} px` +
          (item.lowQualityAccepted ? " — <strong>low quality, customer accepted</strong>" : "")
        : "";
    return `
      <div class="card" style="margin-bottom:1rem" data-item-id="${escapeHtml(item.id)}">
        <p style="margin-top:0"><strong>${escapeHtml(item.quantity)} × ${escapeHtml(item.sizeTier)} · ${escapeHtml(item.material)}</strong> — ${escapeHtml(size)}</p>
        ${(item.textElements || []).map((el) => `<p class="hint">${escapeHtml(el.style)}: “${escapeHtml(el.text)}”</p>`).join("")}
        ${quality ? `<p class="hint">${quality}</p>` : ""}
        <div class="item-link">${renderLink(item.downloadUrl, item.downloadExpiresAt)}</div>
      </div>`;
  }

  function renderLink(url, expiresAt) {
    if (!url) return "<em>No downloadable image for this item.</em>";
    return `
      <a class="btn btn-ghost btn-sm" href="${escapeHtml(url)}">Download image</a>
      <button type="button" class="btn btn-ghost btn-sm" data-copy="${escapeHtml(url)}">Copy link</button>
      <span class="hint" style="margin-left:0.5rem">Link expires ${escapeHtml(new Date(expiresAt).toLocaleDateString())}</span>`;
  }

  function renderNotes(notes) {
    if (!notes.length) return '<p class="hint">No notes yet.</p>';
    return notes
      .map(
        (n) => `<div class="note"><span class="hint">${escapeHtml(new Date(n.createdAt).toLocaleString())} · ${escapeHtml(n.author)}</span><br />${escapeHtml(n.body)}</div>`
      )
      .join("");
  }

  function renderHistory(events) {
    if (!events.length) return "<p><em>No status changes recorded yet.</em></p>";
    return `
      <div class="table-scroll"><table class="stack-on-phone">
        <thead><tr><th>When</th><th>Change</th><th>By</th><th>IP</th></tr></thead>
        <tbody>
          ${events
            .map(
              (ev) => `
            <tr>
              <td data-label="When">${escapeHtml(new Date(ev.createdAt).toLocaleString())}</td>
              <td data-label="Change">${escapeHtml(ev.fromStatus || "—")} → ${escapeHtml(ev.toStatus)}</td>
              <td data-label="By" title="${escapeHtml(ev.userAgent || "")}">${escapeHtml(ev.changedBy)}</td>
              <td data-label="IP">${escapeHtml(ev.ip || "—")}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table></div>`;
  }

  async function updateStatus(orderId, status) {
    const body = { status };
    if (status === "shipped") {
      body.carrier = $("carrier").value.trim();
      body.trackingNumber = $("tracking-number").value.trim();
      body.trackingUrl = $("tracking-url").value.trim();
      if (!body.carrier || !body.trackingNumber) {
        showStatus("Enter the carrier and tracking number to mark this order shipped.");
        return;
      }
    }
    const confirmText =
      status === "shipped"
        ? `Mark this order shipped via ${body.carrier} (${body.trackingNumber})? The customer will be emailed.`
        : `Change this order's status to "${STATUS_LABELS[status]}"?`;
    if (!window.confirm(confirmText)) return;
    hideStatus();
    let result;
    try {
      result = await adminCall(() =>
        Api.patch(`/admin/orders/${encodeURIComponent(orderId)}/status`, body, authHeaders())
      );
    } catch (err) {
      return;
    }
    await openOrder(orderId, { scroll: false });
    if (result.warning) showStatus(result.warning, "warning");
    else showStatus(`Status changed to ${STATUS_LABELS[status]}.`, "success");
    loadOrders({ keepDetail: true });
  }

  async function addNote(orderId) {
    const textarea = $("note-body");
    const text = textarea.value.trim();
    if (!text) return;
    let notes;
    try {
      notes = await adminCall(() =>
        Api.post(`/admin/orders/${encodeURIComponent(orderId)}/notes`, { body: text }, authHeaders())
      );
    } catch (err) {
      return;
    }
    $("notes-list").innerHTML = renderNotes(notes);
    textarea.value = "";
  }

  async function downloadBundle(orderId) {
    hideStatus();
    let file;
    try {
      file = await adminCall(() => Api.download(`/admin/orders/${encodeURIComponent(orderId)}/bundle`, authHeaders()));
    } catch (err) {
      return;
    }
    const url = URL.createObjectURL(file.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
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
    return "$" + Number(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatFeetInches(inches) {
    const total = Math.round(Number(inches));
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
