/**
 * Clean-up for cutouts before they're uploaded. Attaches to `window.CutoutCleanup`.
 *
 * A die-cut standee is cut along its outer outline only, so:
 *  - fillHoles: anything enclosed by the subject is printed solid. The
 *    background remover sometimes punches holes in light or low-contrast
 *    patches (a white T-shirt, a watermark); those come back exactly as
 *    photographed, because the remover keeps the original colours.
 *  - trimToContent: empty transparent margins are cropped off, so the
 *    image's bottom edge is the subject's feet (the preview stands it on the
 *    floor) and the chosen height is the subject's height.
 *
 * fillHoles and contentBounds work on raw RGBA arrays (no DOM), so they're
 * unit-tested in backend/test/cutout-cleanup.test.js.
 */
(function () {
  const BACKGROUND_ALPHA = 128; // below this counts as background when flooding
  const CONTENT_ALPHA = 8; // above this counts as content when trimming

  /**
   * Makes everything the outer background can't reach opaque, in place.
   * The background is flooded from the four image edges through pixels with
   * alpha < 128, so gaps open to an edge (e.g. between the legs) stay
   * transparent. Pixels touching that background keep their alpha, so the
   * outline stays smooth.
   *
   * @param {Uint8ClampedArray|Uint8Array} rgba width × height × 4
   */
  function fillHoles(rgba, width, height) {
    const total = width * height;
    const outside = new Uint8Array(total);
    const queue = new Int32Array(total);
    let head = 0;
    let tail = 0;
    const visit = (i) => {
      if (!outside[i] && rgba[i * 4 + 3] < BACKGROUND_ALPHA) {
        outside[i] = 1;
        queue[tail++] = i;
      }
    };
    for (let x = 0; x < width; x++) {
      visit(x);
      visit((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
      visit(y * width);
      visit(y * width + width - 1);
    }
    while (head < tail) {
      const i = queue[head++];
      const x = i % width;
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (i >= width) visit(i - width);
      if (i < total - width) visit(i + width);
    }

    let filled = 0;
    for (let i = 0; i < total; i++) {
      if (outside[i] || rgba[i * 4 + 3] === 255) continue;
      const x = i % width;
      const onEdge =
        (x > 0 && outside[i - 1]) ||
        (x < width - 1 && outside[i + 1]) ||
        (i >= width && outside[i - width]) ||
        (i < total - width && outside[i + width]);
      if (onEdge) continue;
      rgba[i * 4 + 3] = 255;
      filled += 1;
    }
    return filled;
  }

  /** Bounding box of the visible pixels: { x, y, width, height }, or null if there are none. */
  function contentBounds(rgba, width, height) {
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (rgba[(y * width + x) * 4 + 3] > CONTENT_ALPHA) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  /** The canvas cropped to its visible pixels (the same canvas if there's nothing to trim). */
  function trimToContent(canvas) {
    const ctx = canvas.getContext("2d");
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const box = contentBounds(data, canvas.width, canvas.height);
    if (!box || (box.width === canvas.width && box.height === canvas.height)) return canvas;
    const out = document.createElement("canvas");
    out.width = box.width;
    out.height = box.height;
    out.getContext("2d").drawImage(canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
    return out;
  }

  /** Canvas → PNG blob. */
  function toPngBlob(canvas) {
    return new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't save the cutout."))), "image/png")
    );
  }

  window.CutoutCleanup = { fillHoles, contentBounds, trimToContent, toPngBlob };
})();
