/**
 * The shopping cart, kept in this browser (localStorage) until checkout.
 * Attaches to `window.Cart`.
 *
 * Each item is a designed standee:
 *   { id, imageKey, thumbnail (small JPEG data URL), heightIn, widthIn,
 *     material, quantity, textElements: [{ style, text }] }
 *
 * Prices are never stored here — checkout recomputes them from the live
 * pricing config, and the backend recomputes them again.
 *
 * Storage can be unavailable (private mode, blocked site data), so every
 * access is wrapped and falls back to an in-memory cart for this page.
 */
(function () {
  const KEY = "cutoutCart.v1";
  let memory = [];

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      const items = raw ? JSON.parse(raw) : [];
      return Array.isArray(items) ? items : [];
    } catch (e) {
      return memory.slice();
    }
  }

  function write(items) {
    memory = items.slice();
    try {
      localStorage.setItem(KEY, JSON.stringify(items));
    } catch (e) {
      // Quota or blocked storage — the in-memory copy still works for this page.
    }
    renderCounts();
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function get() {
    return read();
  }

  function add(item) {
    const items = read();
    items.push({ ...item, id: newId() });
    write(items);
  }

  function update(id, changes) {
    write(read().map((item) => (item.id === id ? { ...item, ...changes } : item)));
  }

  function remove(id) {
    write(read().filter((item) => item.id !== id));
  }

  function clear() {
    write([]);
  }

  /** Total number of standees (sum of quantities), for the header badge. */
  function count() {
    return read().reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  }

  function renderCounts() {
    const n = count();
    document.querySelectorAll("[data-cart-count]").forEach((el) => {
      el.textContent = String(n);
    });
  }

  /**
   * Makes a small JPEG thumbnail for the cart, so full-size photos never
   * go into localStorage.
   *
   * @param {string} src an object URL or data URL of the photo
   * @returns {Promise<string>} a data URL, or "" if it can't be made
   */
  function makeThumbnail(src, maxSide = 320) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        try {
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.8));
        } catch (e) {
          resolve("");
        }
      };
      img.onerror = () => resolve("");
      img.src = src;
    });
  }

  // Keep badges in sync when the cart changes in another tab.
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) renderCounts();
  });

  window.Cart = { get, add, update, remove, clear, count, renderCounts, makeThumbnail };
})();
