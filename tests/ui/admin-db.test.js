// Вкладка «База данных» в админке: карта таблиц с колонками и связями.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("админка: вкладка «База данных» только для админов", () => {
  const html = read("admin/index.html");
  assert.match(html, /data-tab="database"[^>]*data-admin-only/);
  assert.match(html, /id="tab-database"/);
  assert.match(html, /id="db-map"/);
  assert.match(html, /id="db-links"/);
  assert.match(html, /id="db-summary"/);
  assert.match(html, /\.db-card \{ position: absolute/);
  assert.match(html, /\.db-link\.is-nullable \{ stroke-dasharray/);
});

test("админка: карта строится из API и рисует связи без внешних библиотек", () => {
  const js = read("admin/admin.js");
  assert.match(js, /api\/admin\/database/);
  assert.match(js, /const dbCard = \(table\)/);
  assert.match(js, /const drawDbLinks = \(cardByTable\)/);
  assert.match(js, /const layoutDbMap = \(\)/);
  assert.match(js, /if \(tab === "database"\) loadDatabase\(\)/);
  assert.match(js, /marker-end="url\(#db-arrow\)"/);
  assert.match(js, /const DB_NOTES = \{/);
  assert.match(js, /const fmtBytes = \(bytes\)/);
  assert.doesNotMatch(read("admin/index.html"), /<script[^>]+https?:/);
});

test("админка: карта экранирует имена таблиц и колонок", () => {
  const js = read("admin/admin.js");
  assert.match(js, /data-table="\$\{esc\(table\.name\)\}"/);
  assert.match(js, /<code>\$\{esc\(column\.name\)\}<\/code>/);
  assert.match(js, /esc\(`ссылка на \$\{fk\.table\}\.\$\{fk\.columnTo\}`\)/);
});
