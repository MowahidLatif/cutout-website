/**
 * Internal/admin endpoints for the manual fulfillment workflow, used by
 * frontend/admin.html. Gated by one shared secret (a single operator, no
 * accounts): every request needs `Authorization: Bearer <ADMIN_TOKEN>`.
 * Failed attempts are rate-limited per IP (security.js), and in production
 * the token is only accepted over HTTPS. See docs/api-spec.md.
 */
const express = require("express");
const crypto = require("crypto");
const { ZipArchive } = require("archiver");
const ordersService = require("../services/orders");
const storage = require("../services/storage");
const { sendShippedNotification } = require("../services/email");
const { MATERIAL_LABELS, TIER_LABELS, TEXT_STYLE_LABELS, borderLabel, formatFeetInches, plural } = require("../services/catalog");
const config = require("../config");
const { clientIp } = require("../security");
const { ok, fail, appError } = require("./_respond");

const router = express.Router();

/** Hashing both sides first makes the comparison constant-time regardless of length. */
function tokenMatches(given) {
  const expected = config.adminToken;
  const digest = (value) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

function requireAdmin(req, res, next) {
  if (config.production && !req.secure) {
    return fail(res, appError("Admin requires HTTPS.", "FORBIDDEN"));
  }
  if ("token" in req.query || "admin_token" in req.query || "adminToken" in req.query) {
    // Tokens in URLs end up in logs and browser history.
    return fail(res, appError("Send the admin token in the Authorization header, never in the URL.", "VALIDATION_ERROR"));
  }
  const match = /^Bearer (.+)$/.exec(req.get("Authorization") || "");
  if (match && tokenMatches(match[1].trim())) {
    return next();
  }
  // The 401 counts toward the failed-attempt limit (security.js).
  console.warn(`[admin] failed auth from ${clientIp(req)}`);
  fail(res, appError("Admin token missing or wrong.", "UNAUTHORIZED"));
}

/** Who made an admin change: self-declared name (shared secret, so not proven) + IP + UA. */
function actorFrom(req) {
  const name = (req.get("X-Admin-Name") || "").trim().slice(0, 80) || "admin";
  return { name, ip: clientIp(req), userAgent: (req.get("User-Agent") || "").slice(0, 300) };
}

/**
 * One link per print file: `url` is the main one (the image, or a vector's
 * PDF), `files` lists them all with labels (a vector adds its PNG fallback).
 */
function itemDownloadLinks(order) {
  return order.items.map((item) => {
    // Orders from before 003_image_key.sql hold a URL, not a key — no link for those.
    if (!storage.isValidKey(item.imageKey)) return { itemId: item.id, url: null, expiresAt: null, files: [] };
    const files = storage.printFiles(item.imageKey).map((f) => ({ label: f.label, ...storage.createDownloadUrl(f.key) }));
    return { itemId: item.id, url: files[0].url, expiresAt: files[0].expiresAt, files };
  });
}

/** Wraps an async handler so thrown errors become JSON responses. */
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    fail(res, err);
  }
};

router.use("/admin", requireAdmin);

router.get(
  "/admin/orders",
  handle(async (req, res) => {
    const { status, q, from, to, page } = req.query;
    ok(res, await ordersService.listOrders({ status: status || "needs_action", q, from, to, page }));
  })
);

router.get(
  "/admin/orders/:id",
  handle(async (req, res) => {
    const [order, statusEvents, notes] = await Promise.all([
      ordersService.getOrderById(req.params.id),
      ordersService.getStatusEvents(req.params.id),
      ordersService.getNotes(req.params.id),
    ]);
    const links = itemDownloadLinks(order);
    order.items = order.items.map((item, i) => ({
      ...item,
      downloadUrl: links[i].url,
      downloadExpiresAt: links[i].expiresAt,
      downloadFiles: links[i].files,
    }));
    ok(res, { ...order, statusEvents, notes, allowedNextStatuses: ordersService.allowedNextStatuses(order.status) });
  })
);

router.post(
  "/admin/orders/:id/download-links",
  handle(async (req, res) => {
    const order = await ordersService.getOrderById(req.params.id);
    ok(res, itemDownloadLinks(order));
  })
);

router.post(
  "/admin/orders/:id/notes",
  handle(async (req, res) => {
    const notes = await ordersService.addNote(req.params.id, req.body && req.body.body, actorFrom(req).name);
    ok(res, notes, 201);
  })
);

router.patch(
  "/admin/orders/:id/status",
  handle(async (req, res) => {
    const { status, carrier, trackingNumber, trackingUrl } = req.body || {};
    const actor = actorFrom(req);
    const { order, fromStatus } = await ordersService.updateOrderStatus(req.params.id, status, actor, {
      carrier,
      trackingNumber,
      trackingUrl,
    });
    console.log(`[admin] ${actor.name}@${actor.ip} changed order ${order.id} ${fromStatus} → ${status}`);

    // The status change is already saved; a failed email must not undo it.
    let warning = null;
    if (status === "shipped") {
      try {
        await sendShippedNotification(order);
      } catch (err) {
        console.error(`[admin] shipped email for order ${order.id} failed:`, err);
        warning = `Status saved, but the shipped email to ${order.customerEmail} failed to send: ${err.message}`;
      }
    }
    ok(res, { ...order, warning });
  })
);

// ---------- Supplier bundle: one zip with the print files + order details ----------
function orderDetailsText(order) {
  const addr = order.shippingAddress || {};
  const cutouts = order.items.reduce((n, i) => n + i.quantity, 0);
  const lines = [
    `Order ${order.id}`,
    `Placed: ${new Date(order.createdAt).toISOString().slice(0, 10)}`,
    "",
    "SHIP TO",
    order.customerName || "(no name on order)",
    addr.line1,
    addr.line2,
    `${addr.city}, ${addr.region} ${addr.postalCode}`,
    addr.country,
    `Phone: ${order.customerPhone}`,
    `Email: ${order.customerEmail}`,
    "",
    `ITEMS (${plural(cutouts, "cutout")}, ${plural(order.items.length, "design")})`,
  ].filter((line) => line !== undefined && line !== null);
  order.items.forEach((item, index) => {
    const size = item.widthIn
      ? `${formatFeetInches(item.heightIn)} tall × ${formatFeetInches(item.widthIn)} wide`
      : `${formatFeetInches(item.heightIn)} tall`;
    lines.push(
      "",
      `Item ${index + 1}: ${
        storage.isValidKey(item.imageKey)
          ? storage.printFiles(item.imageKey).map((f) => bundleImageName(order, item, index, f.key)).join(" + ")
          : bundleImageName(order, item, index)
      }`,
      `  Quantity: ${item.quantity}`,
      `  Material: ${MATERIAL_LABELS[item.material] || item.material}`,
      `  Size: ${TIER_LABELS[item.sizeTier] || item.sizeTier}, ${size}`
    );
    for (const el of item.textElements || []) {
      lines.push(`  ${TEXT_STYLE_LABELS[el.style] || el.style}: "${el.text}"`);
    }
    if (item.isVector) {
      lines.push("  Vector graphic — print from the PDF, scaled to the ordered size (PNG fallback included)");
    } else if (item.imageWidthPx) {
      lines.push(`  Image: ${item.imageWidthPx} × ${item.imageHeightPx} px` + (item.printScore != null ? `, print quality ${item.printScore}/100` : ""));
    }
    lines.push(
      item.hasTransparency
        ? "  Background: removed — transparent PNG, cut along the outline"
        : "  Background: kept (print the whole photo)",
      `  ${borderLabel(item.borderColor)}`
    );
    if (item.isBlurry) lines.push("  ⚠ Photo looks blurry or out of focus (customer was told)");
    if (item.isCompressed) lines.push("  ⚠ Photo looks heavily compressed / blocky (customer was told)");
    if (item.notes) lines.push(`  Notes: ${item.notes}`);
  });
  return lines.join("\n") + "\n";
}

function bundleImageName(order, item, index, key = item.imageKey) {
  const ext = (key || "").split(".").pop();
  return `${order.id}-item-${index + 1}.${ext}`;
}

router.get(
  "/admin/orders/:id/bundle",
  handle(async (req, res) => {
    const order = await ordersService.getOrderById(req.params.id);
    // Read every image first, so a missing file is a clean error rather than a broken zip.
    const images = [];
    for (const [index, item] of order.items.entries()) {
      if (!storage.isValidKey(item.imageKey)) continue; // pre-003 orders
      // A vector graphic contributes its PDF and PNG fallback.
      for (const file of storage.printFiles(item.imageKey)) {
        images.push({ name: bundleImageName(order, item, index, file.key), data: await storage.readFile(file.key) });
      }
    }

    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename="${order.id}-supplier-bundle.zip"`);
    res.set("Cache-Control", "no-store");
    const zip = new ZipArchive({ zlib: { level: 6 } });
    zip.on("error", (err) => {
      console.error(`[admin] bundle for order ${order.id} failed:`, err);
      res.destroy(err);
    });
    zip.pipe(res);
    zip.append(orderDetailsText(order), { name: `${order.id}-order-details.txt` });
    for (const image of images) zip.append(image.data, { name: image.name });
    await zip.finalize();
  })
);

module.exports = router;
