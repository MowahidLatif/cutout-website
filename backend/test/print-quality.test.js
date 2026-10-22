const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { SRC, loadFrontend } = require("./helpers");

const backend = require(path.join(SRC, "services/pricing"));
const frontend = loadFrontend("js/pricing.js").Pricing;

test("the reported example: 588×900 at 6 ft scores low", () => {
  assert.deepEqual(backend.printQuality({ widthPx: 588, heightPx: 900, heightIn: 72 }), { ppi: 13, score: 26, grade: "low", issue: null });
});

test("images under 1000 px can't score above fair, whatever the size", () => {
  const q = backend.printQuality({ widthPx: 588, heightPx: 900, heightIn: 24 }); // 38 ppi would be "good"
  assert.equal(q.score, 59);
  assert.equal(q.grade, "fair");
});

test("a modern phone photo at 6 ft scores great", () => {
  const q = backend.printQuality({ widthPx: 3024, heightPx: 4032, heightIn: 72 });
  assert.equal(q.score, 100);
  assert.equal(q.grade, "great");
});

test("grade boundaries (by score)", () => {
  assert.equal(backend.qualityGrade(90), "great");
  assert.equal(backend.qualityGrade(89), "good");
  assert.equal(backend.qualityGrade(60), "good");
  assert.equal(backend.qualityGrade(59), "fair");
  assert.equal(backend.qualityGrade(36), "fair");
  assert.equal(backend.qualityGrade(35), "low");
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
