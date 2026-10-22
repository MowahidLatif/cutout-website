/**
 * Turns flat artwork (a logo, clip art, a text graphic) into vectors, so it
 * prints crisp at any size. Uses ImageTracer (imagetracerjs, public domain),
 * running here on the server — no external service.
 *
 * Writes three files sharing one uuid (see storage.js):
 *   <uuid>.svg — preview in the studio; the key the order refers to
 *   <uuid>.pdf — the vector print file for the supplier
 *   <uuid>.png — a ~4000 px raster fallback, also used to measure the result
 *
 * The background (the colour that fills the image edges) is removed first,
 * so the graphic stands on its own, like a cutout.
 */
const { randomUUID } = require("crypto");
const zlib = require("zlib");
const sharp = require("sharp");
const ImageTracer = require("imagetracerjs");
const storage = require("./storage");

const TRACE_MAX_PX = 1200; // tracing time grows fast with size; flat art doesn't need more
const PNG_FALLBACK_PX = 4000;
const BACKGROUND_TOLERANCE = 48; // RGB distance still counted as the background colour
const UNIFORM_BORDER_SHARE = 0.6; // only remove a background that really frames the image
const PREVIEW_TTL_SECONDS = 24 * 60 * 60;

const MAX_COLOURS = 16;
const PALETTE_COVERAGE = 0.97; // the main colours cover this share of the artwork
const MIN_COLOUR_SHARE = 0.002; // rarer colours are edge blends, not real colours
const MERGE_DISTANCE = 40; // palette colours closer than this are the same ink

const TRACE_OPTIONS = {
  colorquantcycles: 1, // we pass the palette (options.pal); just assign each pixel
  pathomit: 8, // drop specks smaller than this (px)
  ltres: 1,
  qtres: 1,
  rightangleenhance: true,
  roundcoords: 2,
};

const distSq = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/**
 * The artwork's real colours: the most common colours (4 bits per channel)
 * until they cover 97% of it, near-duplicates merged. Anti-aliased edge
 * pixels are blends of two of these and too rare to make the list.
 */
function mainColours(rgba) {
  const buckets = new Map();
  let opaque = 0;
  for (let p = 0; p < rgba.length; p += 4) {
    if (rgba[p + 3] < 128) continue;
    opaque += 1;
    const key = ((rgba[p] >> 4) << 8) | ((rgba[p + 1] >> 4) << 4) | (rgba[p + 2] >> 4);
    const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n += 1;
    b.r += rgba[p];
    b.g += rgba[p + 1];
    b.b += rgba[p + 2];
    buckets.set(key, b);
  }
  const colours = [];
  let covered = 0;
  for (const b of [...buckets.values()].sort((x, y) => y.n - x.n)) {
    if (colours.length >= MAX_COLOURS || covered / opaque >= PALETTE_COVERAGE || b.n / opaque < MIN_COLOUR_SHARE) break;
    covered += b.n;
    const rgb = [b.r / b.n, b.g / b.n, b.b / b.n];
    const same = colours.find((c) => distSq(c.rgb, rgb) < MERGE_DISTANCE * MERGE_DISTANCE);
    if (same) {
      same.rgb = same.rgb.map((v, i) => (v * same.n + rgb[i] * b.n) / (same.n + b.n));
      same.n += b.n;
    } else {
      colours.push({ rgb, n: b.n });
    }
  }
  return colours.map((c) => c.rgb.map(Math.round));
}

/** Snaps every pixel to its nearest main colour (or fully transparent), in place. */
function snapToPalette(rgba, palette) {
  for (let p = 0; p < rgba.length; p += 4) {
    if (rgba[p + 3] < 128) {
      rgba.fill(0, p, p + 4);
      continue;
    }
    const px = [rgba[p], rgba[p + 1], rgba[p + 2]];
    let best = palette[0];
    for (const c of palette) if (distSq(px, c) < distSq(px, best)) best = c;
    rgba[p] = best[0];
    rgba[p + 1] = best[1];
    rgba[p + 2] = best[2];
    rgba[p + 3] = 255;
  }
}

function validationError(message) {
  return Object.assign(new Error(message), { code: "VALIDATION_ERROR" });
}

/**
 * Makes the edge-connected background transparent, in place: flood from the
 * image edges through pixels close to the dominant border colour (or already
 * transparent). Skipped when the border isn't mostly one colour.
 */
function removeFlatBackground(rgba, width, height) {
  const border = [];
  for (let x = 0; x < width; x++) border.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y++) border.push(y * width, y * width + width - 1);
  const buckets = new Map();
  for (const i of border) {
    if (rgba[i * 4 + 3] < 128) continue;
    const key = ((rgba[i * 4] >> 4) << 8) | ((rgba[i * 4 + 1] >> 4) << 4) | (rgba[i * 4 + 2] >> 4);
    const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n += 1;
    b.r += rgba[i * 4];
    b.g += rgba[i * 4 + 1];
    b.b += rgba[i * 4 + 2];
    buckets.set(key, b);
  }
  const top = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
  const opaqueBorder = border.filter((i) => rgba[i * 4 + 3] >= 128).length;
  const hasColourBackground = top && top.n / Math.max(1, opaqueBorder) >= UNIFORM_BORDER_SHARE;
  const bg = hasColourBackground ? [top.r / top.n, top.g / top.n, top.b / top.n] : null;

  const isBackground = (i) => {
    const p = i * 4;
    if (rgba[p + 3] < 128) return true;
    if (!bg) return false;
    const dr = rgba[p] - bg[0];
    const dg = rgba[p + 1] - bg[1];
    const db = rgba[p + 2] - bg[2];
    return dr * dr + dg * dg + db * db <= BACKGROUND_TOLERANCE * BACKGROUND_TOLERANCE;
  };
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const visit = (i) => {
    if (!seen[i] && isBackground(i)) {
      seen[i] = 1;
      queue[tail++] = i;
    }
  };
  border.forEach(visit);
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < width * height - width) visit(i + width);
  }
  for (let i = 0; i < width * height; i++) {
    if (seen[i]) rgba.fill(0, i * 4, i * 4 + 4);
  }
}

/**
 * Crops away fully transparent margins, so the graphic's bottom edge is its
 * lowest visible pixel (the studio stands it on the floor). Returns the
 * cropped { rgba, width, height }, or null when nothing is visible.
 */
function trimTransparent(rgba, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] >= 128) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((minY + y) * width + minX) * 4;
    out.set(rgba.subarray(from, from + w * 4), y * w * 4);
  }
  return { rgba: out, width: w, height: h };
}

/** The visible filled shapes: [{ color: {r,g,b}, paths: [outer, ...holes] }]. */
function shapesOf(tracedata) {
  const shapes = [];
  tracedata.layers.forEach((layer, li) => {
    const color = tracedata.palette[li];
    if (color.a < 128) return; // the removed background
    layer.forEach((path) => {
      if (path.isholepath) return;
      shapes.push({ color, paths: [path, ...path.holechildren.map((h) => layer[h])] });
    });
  });
  return shapes;
}

const num = (n) => String(Math.round(n * 100) / 100);

function toSvg(shapes, width, height) {
  const d = (path) =>
    path.segments
      .map((s, i) => (i === 0 ? `M${num(s.x1)} ${num(s.y1)} ` : "") + (s.type === "L" ? `L${num(s.x2)} ${num(s.y2)}` : `Q${num(s.x2)} ${num(s.y2)} ${num(s.x3)} ${num(s.y3)}`))
      .join(" ") + " Z";
  const body = shapes
    .map(({ color, paths }) => {
      const rgb = `rgb(${color.r},${color.g},${color.b})`;
      // The thin stroke in the same colour closes hairline seams between shapes.
      return `<path fill="${rgb}" stroke="${rgb}" stroke-width="1" fill-rule="evenodd" d="${paths.map(d).join(" ")}"/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

/**
 * A one-page vector PDF drawn straight from the trace (no PDF library): each
 * shape is filled and stroked in its colour, holes by the even-odd rule, and
 * ImageTracer's quadratic curves become cubic Béziers. 1 px = 1 pt, so the
 * page is the trace size; it scales losslessly to the ordered size.
 */
function toPdf(shapes, width, height) {
  const c = (n) => (n / 255).toFixed(3);
  const ops = [`1 0 0 -1 0 ${height} cm`, "1 w", "1 j"];
  for (const { color, paths } of shapes) {
    ops.push(`${c(color.r)} ${c(color.g)} ${c(color.b)} rg ${c(color.r)} ${c(color.g)} ${c(color.b)} RG`);
    for (const path of paths) {
      path.segments.forEach((s, i) => {
        if (i === 0) ops.push(`${num(s.x1)} ${num(s.y1)} m`);
        if (s.type === "L") {
          ops.push(`${num(s.x2)} ${num(s.y2)} l`);
        } else {
          // Quadratic (p0, control, p3) → cubic control points at 2/3 toward the control.
          const c1x = s.x1 + ((s.x2 - s.x1) * 2) / 3;
          const c1y = s.y1 + ((s.y2 - s.y1) * 2) / 3;
          const c2x = s.x3 + ((s.x2 - s.x3) * 2) / 3;
          const c2y = s.y3 + ((s.y2 - s.y3) * 2) / 3;
          ops.push(`${num(c1x)} ${num(c1y)} ${num(c2x)} ${num(c2y)} ${num(s.x3)} ${num(s.y3)} c`);
        }
      });
      ops.push("h");
    }
    ops.push("B*");
  }
  const content = zlib.deflateSync(Buffer.from(ops.join("\n"), "latin1"));

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << >> >>`,
  ];
  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [];
  let length = chunks[0].length;
  const push = (buf) => {
    chunks.push(buf);
    length += buf.length;
  };
  objects.forEach((body, i) => {
    offsets.push(length);
    push(Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1"));
  });
  offsets.push(length);
  push(Buffer.from(`4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, "latin1"));
  push(content);
  push(Buffer.from("\nendstream\nendobj\n", "latin1"));
  const xref = length;
  let trailer = `xref\n0 5\n0000000000 65535 f \n`;
  for (const off of offsets) trailer += `${String(off).padStart(10, "0")} 00000 n \n`;
  trailer += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(Buffer.from(trailer, "latin1"));
  return Buffer.concat(chunks);
}

/**
 * @param {string} key a stored raster upload (jpg/png/webp)
 * @returns {Promise<{ imageKey: string, width: number, height: number, previewUrl: string, vector: true }>}
 */
async function vectorizeUpload(key) {
  if (!storage.isValidKey(key) || /\.(svg|pdf)$/.test(key) || !(await storage.fileExists(key))) {
    throw validationError("Uploaded image not found. Please upload it again.");
  }
  const { data, info } = await sharp(await storage.readFile(key))
    .resize({ width: TRACE_MAX_PX, height: TRACE_MAX_PX, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = new Uint8ClampedArray(data);
  // Snap first: edge blends become either the shape's colour or the
  // background's — and the background ones are removed with it (no halo).
  const palette = mainColours(rgba);
  if (!palette.length) throw validationError("Nothing to trace in that image — it looks empty.");
  snapToPalette(rgba, palette);
  removeFlatBackground(rgba, info.width, info.height);
  const art = trimTransparent(rgba, info.width, info.height);
  if (!art) throw validationError("Nothing to trace in that image — it looks empty.");

  const tracedata = ImageTracer.imagedataToTracedata(
    { width: art.width, height: art.height, data: art.rgba },
    { ...TRACE_OPTIONS, pal: [...palette.map(([r, g, b]) => ({ r, g, b, a: 255 })), { r: 0, g: 0, b: 0, a: 0 }] }
  );
  const shapes = shapesOf(tracedata);
  if (!shapes.length) throw validationError("Nothing to trace in that image — it looks empty.");

  const svg = toSvg(shapes, art.width, art.height);
  const pdf = toPdf(shapes, art.width, art.height);
  const density = Math.min(2400, (72 * PNG_FALLBACK_PX) / Math.max(art.width, art.height));
  const png = await sharp(Buffer.from(svg), { density }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });

  const base = randomUUID();
  const imageKey = `${base}.svg`;
  await storage.saveFile(imageKey, Buffer.from(svg), "image/svg+xml");
  await storage.saveFile(`${base}.pdf`, pdf, "application/pdf");
  await storage.saveFile(`${base}.png`, png.data, "image/png");
  return {
    imageKey,
    width: png.info.width,
    height: png.info.height,
    previewUrl: storage.createDownloadUrl(imageKey, { ttlSeconds: PREVIEW_TTL_SECONDS, relative: true }).url,
    vector: true,
  };
}

module.exports = { vectorizeUpload, mainColours, snapToPalette, removeFlatBackground, trimTransparent, toSvg, toPdf, shapesOf };
