const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { SRC, loadFrontend } = require("./helpers");

const backend = require(path.join(SRC, "services/pricing"));
const frontend = loadFrontend("js/pricing.js").Pricing;

test("the reported example: 588×900 at 6 ft is low quality", () => {
  assert.deepEqual(backend.printQuality({ widthPx: 588, heightPx: 900, heightIn: 72 }), { ppi: 13, grade: "low" });
});

test("a modern phone photo at 6 ft is great", () => {
  assert.equal(backend.printQuality({ widthPx: 3024, heightPx: 4032, heightIn: 72 }).grade, "great");
});

test("grade boundaries", () => {
  assert.equal(backend.qualityGrade(50), "great");
  assert.equal(backend.qualityGrade(49), "good");
  assert.equal(backend.qualityGrade(30), "good");
  assert.equal(backend.qualityGrade(29), "fair");
  assert.equal(backend.qualityGrade(18), "fair");
  assert.equal(backend.qualityGrade(17), "low");
});

test("a stretched (unlocked) width lowers quality along that axis", () => {
  const natural = backend.printQuality({ widthPx: 3000, heightPx: 4000, heightIn: 72 });
  const stretched = backend.printQuality({ widthPx: 3000, heightPx: 4000, heightIn: 72, widthIn: 96 });
  assert.ok(stretched.ppi < natural.ppi);
});

test("browser and server agree on 5,000 random photos and sizes", () => {
  for (let i = 0; i < 5000; i++) {
    const p = {
      widthPx: 50 + Math.floor(Math.random() * 8000),
      heightPx: 50 + Math.floor(Math.random() * 8000),
      heightIn: 12 + Math.floor(Math.random() * 85),
      widthIn: Math.random() < 0.5 ? null : 6 + Math.floor(Math.random() * 91),
    };
    // The frontend runs in a vm sandbox (another JS realm), so compare as JSON.
    assert.equal(JSON.stringify(frontend.printQuality(p)), JSON.stringify(backend.printQuality(p)), JSON.stringify(p));
  }
});
