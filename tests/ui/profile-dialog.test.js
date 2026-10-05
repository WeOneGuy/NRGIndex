const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function loadDialog() {
  const sandbox = { window: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("public/drink-dialog.js"), sandbox, { filename: "drink-dialog.js" });
  return sandbox.window.NrgDrinkDialog;
}

const makeData = () => ({
  tiers: [
    { id: "S", score: 5 },
    { id: "A", score: 4 },
  ],
  participants: [
    { id: "sanya", name: '<img src=x onerror="alert(1)">', initials: "СЯ", role: "тестер", color: "#ff0000" },
  ],
  drinks: [
    {
      id: "burn",
      brand: "Burn",
      name: "Burn <script>alert(1)</script>",
      flavor: "манго",
      image: "assets/burn.png",
      accent: ["#ff4f79"],
      ratings: { sanya: { tier: "S", review: 'вкусно <b>' } },
      related: ["volt"],
    },
    {
      id: "volt",
      brand: "Volt",
      name: "Volt",
      flavor: "лайм",
      image: "assets/volt.png",
      accent: ["#00ff00"],
      ratings: {},
      related: [],
    },
  ],
});

test("общий диалог: собирает карточку, отзывы, похожие и кнопки", () => {
  const dialog = loadDialog();
  const data = makeData();
  const html = dialog.html({ drink: data.drinks[0], data, currentUser: { role: "admin" } });
  assert.match(html, /Что сказали/);
  assert.match(html, /data-related-drink="volt"/);
  assert.match(html, /cabinet\.html\?rate=burn/);
  assert.match(html, /\/admin\?drink=burn/, "сотруднику — кнопка правки");
  assert.match(html, /data-share-drink="burn"/);
  assert.match(html, /Саня|СЯ/);
});

test("общий диалог: экранирует имена, отзывы и alt-тексты", () => {
  const dialog = loadDialog();
  const data = makeData();
  const html = dialog.html({ drink: data.drinks[0], data });
  assert.doesNotMatch(html, /<script>alert/, "имя банки должно быть экранировано");
  assert.doesNotMatch(html, /onerror="alert/, "имя участника должно быть экранировано");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /вкусно &lt;b&gt;/);
});

test("общий диалог: без данных возвращает пустую строку", () => {
  const dialog = loadDialog();
  assert.equal(dialog.html({ drink: null, data: null }), "");
  assert.equal(dialog.html({}), "");
});

test("профиль: карточка открывается на месте, без ухода на главную", () => {
  const html = read("public/profile.html");
  const js = read("public/profile.js");
  assert.match(html, /id="drink-dialog"/);
  assert.match(html, /src="drink-dialog\.js"/);
  assert.match(js, /window\.NrgDrinkDialog\.html\(\{ drink, data: summaryData, currentUser \}\)/);
  assert.match(js, /event\.preventDefault\(\)/);
  assert.match(js, /a\[data-drink\]/);
  assert.match(js, /data-drink="\$\{esc\(rating\.drink\)\}"/);
});
