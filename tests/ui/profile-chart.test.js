const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("профиль: бары растут от отдельной шкалы, максимум — во всю высоту", () => {
  const js = read("public/profile.js");
  const css = read("public/styles.css");
  // переменная высоты — на самом баре, иначе JS прочитает пустое значение
  assert.match(js, /class="dist-bar" style="--tier-color:\$\{tierColor\(tier\.id\)\};--i:\$\{index\};--h:/);
  assert.match(js, /class="dist-bar__plot"/);
  assert.match(js, /bar\.style\.getPropertyValue\("--h"\)/);
  assert.match(js, /querySelectorAll\("\.dist-bar"\)/);
  // fill абсолютный внутри шкалы, число — над верхом бара
  assert.match(css, /\.dist-bar__plot \{ position: relative; flex: 1; min-height: 0; width: 100%; \}/);
  assert.match(css, /\.dist-bar__fill \{ position: absolute; left: 0; right: 0; bottom: 0;/);
  assert.match(css, /\.dist-bar__count \{ position: absolute; left: 0; right: 0; bottom: calc\(var\(--h, 0%\) \+ \.3rem\);/);
});
