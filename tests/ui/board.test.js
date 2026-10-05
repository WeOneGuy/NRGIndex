const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "..", "..", "public", "app.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "..", "public", "index.html"), "utf8");
const rouletteSource = fs.readFileSync(path.join(__dirname, "..", "..", "public", "roulette.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(__dirname, "..", "..", "public", "styles.css"), "utf8");
const profileSource = fs.readFileSync(path.join(__dirname, "..", "..", "public", "profile.js"), "utf8");

test("доска: строка поиска и фильтры тиров в разметке", () => {
  assert.match(indexHtml, /id="board-search"/);
  assert.match(indexHtml, /id="board-filters"/);
  for (const tier of ["all", "S", "A", "B", "C", "D"]) {
    assert.match(indexHtml, new RegExp(`data-tier-filter="${tier}"`));
  }
});

test("доска: поиск фильтрует по бренду/названию/вкусу", () => {
  assert.match(appSource, /let searchQuery = ""/);
  assert.match(appSource, /matchesSearch\(entry\.drink\)/);
  assert.match(appSource, /drink\.brand, drink\.name, drink\.flavor, drink\.edition/);
  assert.match(appSource, /ничего не найдено — ослабьте фильтры/);
  assert.match(appSource, /найдено: \$\{shown\}/);
});

test("доска: фильтр тиров переключает чипы", () => {
  assert.match(appSource, /tierFilter = button\.dataset\.tierFilter/);
  assert.match(appSource, /querySelectorAll\("\[data-tier-filter\]"\)/);
});

test("доска: карточка не крутится за курсором — бейджи тира/оценки не мерцают", () => {
  assert.doesNotMatch(appSource, /setProperty\("--r[xy]"/);
  assert.doesNotMatch(appSource, /is-tilting/);
  assert.match(appSource, /attachCards/);
});

test("диплинк: /d/:slug открывает карточку, закрытие чистит URL", () => {
  assert.match(appSource, /location\.pathname\.match\(\/\^\\\/d\\\//);
  assert.match(appSource, /history\.replaceState\(null, "", `\/d\/\$\{encodeURIComponent\(drink\.id\)\}`\)/);
  assert.match(appSource, /if \(!location\.pathname\.startsWith\("\/d\/"\)\) return;/);
  assert.match(appSource, /history\.replaceState\(null, "", "\/"\)/);
});

test("диалог: повторное открытие и закрытие с клавиатуры не ломают карточку", () => {
  assert.match(appSource, /if \(!dialog\.open\) dialog\.showModal\(\)/);
  assert.match(appSource, /if \(event\.target === dialog\) closeDialog\(\)/);
  assert.doesNotMatch(appSource, /event\.clientX < rect\.left/);
});

test("рулетка: под тирлистом, фильтры по тирам и «не пробовал»", () => {
  assert.ok(indexHtml.indexOf('id="roulette"') > indexHtml.indexOf('id="tier-board"'));
  for (const tier of ["S", "A", "B", "C", "D"]) assert.match(indexHtml, new RegExp(`data-roll-tier="${tier}"`));
  assert.match(appSource, /!untriedOnly \|\| !drink\.ratings\?\.\[currentUser\?\.username\]/);
  assert.match(appSource, /setupRoulette\(\);/);
});

test("рулетка: общий барабан, без откатов и прыжка на повторном спине", () => {
  assert.match(indexHtml, /src="roulette\.js"/);
  assert.ok(indexHtml.indexOf("roulette.js") < indexHtml.indexOf("app.js"), "барабан подключён до app.js");
  assert.match(appSource, /NrgRoulette\.create/);
  assert.doesNotMatch(appSource, /randInt\(6, 30\)/); // осадка-откат убрана
  assert.doesNotMatch(appSource, /settle/);
  assert.doesNotMatch(rouletteSource, /overshoot|settle/);
  assert.match(rouletteSource, /cubic-bezier\(\.15,\.75,\.25,1\)/);
  assert.match(rouletteSource, /randInt\(\.\.\.DURATION\)/);
  assert.match(rouletteSource, /translateX/);
  assert.match(rouletteSource, /onWinner/);
});

test("диалог: кнопка копирования ссылки на банку", () => {
  assert.match(appSource, /data-share-drink/);
  assert.match(appSource, /navigator\.clipboard\.writeText\(url\)/);
  assert.match(appSource, /\/d\/\$\{encodeURIComponent\(button\.dataset\.shareDrink\)\}/);
});

test("профиль: карточки ведут на /d/:slug", () => {
  assert.match(profileSource, /const drinkLink = \(slug\)/);
  assert.match(profileSource, /href="\$\{esc\(drinkLink\(rating\.drink\)\)\}"/);
  assert.doesNotMatch(profileSource, /\?drink=\$/);
});

test("главная: ссылка на профиль одна — в чипе участника, без дубля в описании", () => {
  assert.match(appSource, /class="view-chip__profile" href="profile\.html\?u=/);
  assert.doesNotMatch(appSource, /Профиль и отзывы/);
  assert.doesNotMatch(appSource, /viewDescription\.insertAdjacentHTML/);
});

test("главная: критичные шрифты предзагружаются", () => {
  for (const hash of [
    "xn7gYHE41ni1AdIRggOxSuXd",
    "xn7gYHE41ni1AdIRggexSg",
    "co3bmX5slCNuHLi8bLeY9MK7whWMhyjYrXtKgS4",
    "co3bmX5slCNuHLi8bLeY9MK7whWMhyjYqXtK",
  ]) {
    assert.match(
      indexHtml,
      new RegExp(`rel="preload"[^>]*${hash}\\.woff2`),
      `${hash} должен предзагружаться`,
    );
  }
});

test("витрина: главный энергос — только S-тир, без номера и хардкода", () => {
  assert.doesNotMatch(indexHtml, /adrenaline-yuzu-strawberry-calamansi/);
  assert.match(indexHtml, /id="hero-specimen"/);
  assert.match(indexHtml, /id="specimen-image"/);
  assert.match(indexHtml, /id="specimen-stamp"/);
  assert.match(indexHtml, /id="specimen-caption"/);
  assert.doesNotMatch(indexHtml, /specimen-index/);
  assert.match(appSource, /const specimenCandidates/);
  assert.match(appSource, /average\.tier === "S"/);
  assert.doesNotMatch(appSource, /specimen-index/);
  assert.match(appSource, /SPECIMEN_ROTATE_MS/);
  assert.match(appSource, /prefers-reduced-motion/);
  assert.match(appSource, /setupSpecimen\(\)/);
});

test("главный экран: аура курсора и «разложенная» перетекают в цвет банки витрины", () => {
  assert.match(stylesSource, /@property --can-a \{ syntax: "<color>"/);
  assert.match(stylesSource, /@property --can-b \{ syntax: "<color>"/);
  assert.match(stylesSource, /:root \{ transition: --can-a/);
  assert.match(stylesSource, /var\(--can-a, #ff4f79\)/);
  assert.match(stylesSource, /\.hero__title em \{ color: var\(--can-a/);
  assert.match(appSource, /const rootStyle = document\.documentElement\.style;/);
  assert.match(appSource, /rootStyle\.setProperty\("--can-a", accentA\)/);
  assert.match(appSource, /rootStyle\.setProperty\("--can-b", accentB\)/);
});

test("профиль: карточки банок помечаются ?from=profile, закрытие возвращает в профиль", () => {
  assert.match(profileSource, /const drinkLink = \(slug\)/);
  assert.match(profileSource, /from=profile&u=/);
  assert.match(appSource, /params\.get\("from"\) === "profile"/);
  assert.match(appSource, /location\.href = back/);
});

test("главный экран: до данных нет розовой вспышки — нейтральные цвета и скрытая аура", () => {
  // До витрины --can-a/--can-b нейтральные (как текст), аура появляется только
  // с реальным цветом банки по html.can-ready.
  assert.match(stylesSource, /--can-a: var\(--paper\)/);
  assert.match(stylesSource, /--can-b: var\(--paper-2\)/);
  assert.match(stylesSource, /html\.can-ready \.cursor-aura \{ opacity: 1; \}/);
  assert.match(appSource, /classList\.add\("can-ready"\)/);
});

test("доска: оценка уводит в кабинет на нужную банку, без инлайн-формы", () => {
  assert.match(appSource, /cabinet\.html\?rate=\$\{encodeURIComponent\(drink\.id\)\}/);
  assert.match(appSource, /class="dialog-rate"/);
  assert.doesNotMatch(appSource, /data-quick-tier/);
  assert.doesNotMatch(appSource, /quick-save/);
  assert.match(stylesSource, /\.dialog-rate/);
});

test("доска: сотрудникам рядом кнопка правки банки в админке", () => {
  assert.match(appSource, /\["admin", "editor"\]\.includes\(currentUser\.role\)/);
  assert.match(appSource, /admin\?drink=\$\{encodeURIComponent\(drink\.id\)\}/);
});

test("витрина: смена банки анимируется, а не мигает", () => {
  assert.match(appSource, /classList\.add\("is-swapping"\)/);
  assert.match(appSource, /classList\.add\("is-entering"\)/);
  assert.match(stylesSource, /@keyframes specimen-can-in/);
  assert.match(stylesSource, /@keyframes specimen-badge-in/);
  assert.match(stylesSource, /\.specimen-card\.is-entering img/);
  assert.match(stylesSource, /\.specimen-card__halo::after/);
});
