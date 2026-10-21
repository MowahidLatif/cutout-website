/** frontend/js/cutout-cleanup.js: cutouts are solid inside and trimmed to the subject. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFrontend } = require("./helpers");

const { CutoutCleanup } = loadFrontend("js/cutout-cleanup.js");

/** An RGBA image from rows of alpha values (one character per pixel: "." 0, "o" 100, "#" 255, "s" 200). */
function image(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const rgba = new Uint8Array(width * height * 4);
  const alpha = { ".": 0, o: 100, s: 200, "#": 255 };
  rows.forEach((row, y) => [...row].forEach((c, x) => (rgba[(y * width + x) * 4 + 3] = alpha[c])));
  const at = (x, y) => rgba[(y * width + x) * 4 + 3];
  return { rgba, width, height, at };
}

test("a hole fully inside the subject is filled", () => {
  const img = image([
    ".......",
    ".#####.",
    ".#...#.",
    ".#...#.",
    ".#####.",
    ".......",
  ]);
  CutoutCleanup.fillHoles(img.rgba, img.width, img.height);
  for (let y = 2; y <= 3; y++) for (let x = 2; x <= 4; x++) assert.equal(img.at(x, y), 255, `(${x},${y}) filled`);
  assert.equal(img.at(0, 0), 0, "outside stays transparent");
});

test("a faded patch inside the subject becomes opaque", () => {
  const img = image([
    ".....",
    ".###.",
    ".#o#.",
    ".#s#.",
    ".###.",
    ".....",
  ]);
  CutoutCleanup.fillHoles(img.rgba, img.width, img.height);
  assert.equal(img.at(2, 2), 255);
  assert.equal(img.at(2, 3), 255);
});

test("a gap open to the bottom edge (between the legs) stays transparent", () => {
  const img = image([
    ".#####.",
    ".#####.",
    ".##.##.",
    ".##.##.",
    ".##.##.",
  ]);
  CutoutCleanup.fillHoles(img.rgba, img.width, img.height);
  for (let y = 2; y <= 4; y++) assert.equal(img.at(3, y), 0);
});

test("the soft outer edge keeps its alpha", () => {
  const img = image([
    ".....",
    ".sss.",
    ".s#s.",
    ".sss.",
    ".....",
  ]);
  CutoutCleanup.fillHoles(img.rgba, img.width, img.height);
  assert.equal(img.at(1, 1), 200, "edge pixel touching the background is untouched");
  assert.equal(img.at(2, 2), 255);
});

test("contentBounds finds the visible subject (or null when empty)", () => {
  const img = image([
    "......",
    "..##..",
    "..#...",
    "......",
  ]);
  assert.deepEqual({ ...CutoutCleanup.contentBounds(img.rgba, img.width, img.height) }, { x: 2, y: 1, width: 2, height: 2 });
  assert.equal(CutoutCleanup.contentBounds(image(["..", ".."]).rgba, 2, 2), null);
});
