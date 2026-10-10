const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("профиль: ежемесячные титулы рендерятся возле имени", () => {
  const js = read("public/profile.js");
  const css = read("public/styles.css");
  assert.match(js, /const renderHero = \(\{ profile, stats, tiers, titles \}\)/);
  assert.match(js, /class="profile-titles"/);
  assert.match(js, /titles\.items/);
  assert.match(js, /esc\(title\.label\)/);
  assert.match(js, /esc\(title\.hint/);
  assert.match(js, /титулы · \$\{esc\(titles\.month\?\.label/);
  // строка титулов — между именем и должностью
  const h1 = js.indexOf("<h1>${esc(profile.name)}</h1>");
  const titles = js.indexOf("${titlesMarkup}");
  const role = js.indexOf('<p class="profile-role">');
  assert.ok(h1 > -1 && titles > h1 && role > titles, "порядок: имя → титулы → должность");
  assert.match(css, /\.profile-titles \{/);
  assert.match(css, /\.profile-title \{/);
});

test("профиль: пустой набор титулов ничего не рисует", () => {
  assert.match(read("public/profile.js"), /titles\?\.items\?\.length/);
});

test("профиль: подсказка титула открывается наведением и тапом", () => {
  const js = read("public/profile.js");
  const css = read("public/styles.css");
  assert.match(js, /class="profile-title-wrap"/);
  assert.match(js, /<button class="profile-title" type="button" aria-label=/);
  assert.match(js, /class="profile-tooltip" role="tooltip"/);
  assert.doesNotMatch(js, /profile-title" title=/);
  assert.match(js, /closest\("\.profile-title"\)/);
  assert.match(js, /classList\.toggle\("is-open"\)/);
  assert.match(js, /event\.key !== "Escape"/);
  assert.match(css, /\.profile-title-wrap \{ position: relative;/);
  assert.match(css, /\.profile-title-wrap:hover \.profile-tooltip,/);
  assert.match(css, /\.profile-title-wrap\.is-open \.profile-tooltip/);
  // фокус после тапа не должен удерживать подсказку: закрытие по Escape/повторному тапу
  assert.doesNotMatch(css, /profile-title-wrap:focus-within/);
});
