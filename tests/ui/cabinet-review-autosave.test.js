const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const cabinetSource = read("public/cabinet.js");
const cabinetHtml = read("public/cabinet.html");
const stylesSource = read("public/styles.css");

test("автосохранение отзыва: таймер 3 секунды", () => {
  assert.match(cabinetSource, /const REVIEW_AUTOSAVE_MS = 3000/);
  assert.match(cabinetSource, /window\.setTimeout\([\s\S]*?REVIEW_AUTOSAVE_MS\)/);
});

test("поле отзыва обновляет состояние и сохраняется по input/change", () => {
  const start = cabinetSource.indexOf('const reviewInput = row.querySelector("[data-m-review]")');
  assert.notEqual(start, -1);
  const handler = cabinetSource.slice(start, cabinetSource.indexOf("const rating = state.mine.find", start));
  assert.match(handler, /reviewInput\.addEventListener\("input", \(\) => \{/);
  assert.match(handler, /scheduleMineReviewSave\(slug\)/);
  assert.match(handler, /reviewInput\.addEventListener\("change", \(\) => \{/);
  assert.match(handler, /void saveMineReview\(slug\)/);
  assert.doesNotMatch(cabinetSource, /\[data-m-review\]"\)\.onchange/);
});

test("saveMineReview шлёт тир и отзыв без refreshAll", () => {
  const start = cabinetSource.indexOf("const saveMineReview = async");
  assert.notEqual(start, -1);
  const fn = cabinetSource.slice(start, cabinetSource.indexOf("const scheduleMineReviewSave", start));
  assert.doesNotMatch(fn, /refreshAll\(/);
  assert.match(fn, /api\("PUT", `api\/cabinet\/ratings\/\$\{encodeURIComponent\(slug\)\}`/);
  assert.match(fn, /tier: item\.tier \|\| "B",\s*review,/);
  assert.match(fn, /toast\("Изменения сохранены"\)/);
  assert.match(fn, /toastError\(error\.message\)/);
});

test("общий тост вместо локального cab-toast", () => {
  assert.match(cabinetHtml, /<script src="toast\.js"><\/script>/);
  assert.doesNotMatch(cabinetHtml, /cab-toast/);
  assert.doesNotMatch(cabinetSource, /cab-toast/);
  assert.doesNotMatch(stylesSource, /cab-toast/);
});
