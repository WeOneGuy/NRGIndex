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
    { id: "sanya", name: "Саня", initials: "СЯ", role: "тестер", color: "#ff0000" },
    { id: "tier-only", name: "Тир", initials: "Т", role: "тестер", color: "#00ff00" },
    { id: "untried", name: "Новичок", initials: "Н", role: "тестер", color: "#0000ff" },
    { id: "bad", name: '<img src=x onerror="alert(1)">', initials: "Б", role: "<script>", color: "#123456" },
  ],
  drinks: [
    {
      id: "burn",
      brand: "Burn",
      name: "Burn",
      flavor: "манго",
      image: "assets/burn.png",
      accent: ["#ff4f79"],
      ratings: {
        sanya: { tier: "S", review: "вкусно <b>" },
        "tier-only": { tier: "A" },
        bad: { tier: "S", review: "<script>alert(1)</script>" },
      },
      related: [],
    },
  ],
});

test("отзыв с текстом получает кнопку «поделиться», без текста и без оценки — нет", () => {
  const dialog = loadDialog();
  const data = makeData();
  const html = dialog.html({ drink: data.drinks[0], data });
  assert.match(html, /data-share-review="sanya"/);
  assert.match(html, /class="review-share"/);
  assert.match(html, /title="Поделиться отзывом"/);
  assert.doesNotMatch(html, /data-share-review="tier-only"/);
  assert.doesNotMatch(html, /data-share-review="untried"/);
  assert.equal((html.match(/data-share-review=/g) || []).length, 2, "кнопка только у отзывов с текстом");
});

test("выбранный отзыв закрепляется сверху и исчезает из общего списка", () => {
  const dialog = loadDialog();
  const data = makeData();
  const html = dialog.html({ drink: data.drinks[0], data, sharedReview: "sanya" });
  assert.match(html, /class="shared-review"/);
  assert.match(html, /Отзыв, которым поделились/);
  assert.match(html, /review-row--pinned/);
  assert.equal(
    (html.match(/data-person-view="sanya"/g) || []).length,
    1,
    "закреплённый участник не должен дублироваться",
  );
});

test("главная и профиль передают review и строят ссылку на отзыв", () => {
  const app = read("public/app.js");
  const profile = read("public/profile.js");
  assert.match(app, /params\.get\("review"\)/);
  assert.match(app, /sharedReview/);
  assert.match(app, /\?review=/);
  assert.match(profile, /data-share-review/);
  assert.match(profile, /\?review=/);
});

test("стили кнопки отзыва и закреплённого блока на месте", () => {
  const css = read("public/styles.css");
  assert.match(css, /\.review-share\b/);
  assert.match(css, /\.shared-review\b/);
});

test("имя и отзыв экранируются в кнопке и закреплённом блоке", () => {
  const dialog = loadDialog();
  const data = makeData();
  const html = dialog.html({ drink: data.drinks[0], data, sharedReview: "bad" });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /onerror="alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /вкусно &lt;b&gt;/);
  assert.match(html, /data-share-review="bad"/);
});
