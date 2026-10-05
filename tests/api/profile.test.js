const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, createUser, request, login } = require("../helpers");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const { findSimilarDrinks } = require("../../server/lib/content");

let ctx;
let sanyaCookie;

const addDrink = (db, slug, brand, name, flavor, createdBy = null) =>
  db
    .prepare("INSERT INTO drinks (slug, brand, name, flavor, created_by) VALUES (?, ?, ?, ?, ?)")
    .run(slug, brand, name, flavor, createdBy).lastInsertRowid;
const rate = (db, drinkId, userId, tier, review = "") =>
  db.prepare("INSERT INTO ratings (drink_id, user_id, tier_id, review) VALUES (?, ?, ?, ?)").run(drinkId, userId, tier, review);

before(async () => {
  ctx = await startServer();
  const sanya = await createUser(ctx.db, { username: "sanya", password: "sanya-pass-123", displayName: "Саня Петров" });
  const kira = await createUser(ctx.db, { username: "kira", password: "kira-pass-123", displayName: "Кира" });
  const ghost = await createUser(ctx.db, { username: "ghost", password: "ghost-pass-123", displayName: "Призрак" });
  ctx.db.prepare("UPDATE users SET is_public = 0 WHERE id = ?").run(ghost.id);
  await createUser(ctx.db, { username: "mod", password: "mod-pass-123", role: "editor", displayName: "Модератор" });

  const burn = addDrink(ctx.db, "burn-apple-kiwi", "Burn", "Burn Apple Kiwi", "яблоко киви", sanya.id);
  const monster = addDrink(ctx.db, "monster-white", "Monster", "Monster Ultra White", "цитрус", kira.id);
  const volt = addDrink(ctx.db, "volt-original", "Volt", "Volt Original", "", kira.id);
  rate(ctx.db, burn, sanya.id, "S", "Лучший, возьму ящик");
  rate(ctx.db, monster, sanya.id, "D");
  rate(ctx.db, burn, kira.id, "A");
  rate(ctx.db, monster, kira.id, "D", "Сладко");
  rate(ctx.db, volt, ghost.id, "B");
  sanyaCookie = (await login(ctx.base, "sanya", "sanya-pass-123")).cookie;
});

after(async () => {
  await ctx.close();
});

test("профиль: статистика, распределение и согласие со столом", async () => {
  const res = await request(ctx.base, "GET", "/api/public/profile/sanya");
  assert.equal(res.status, 200);
  const { profile, stats, ratings } = res.json;
  assert.equal(profile.id, "sanya");
  assert.equal(profile.initials, "СП");
  assert.equal(stats.ratings, 2);
  assert.equal(stats.reviews, 1);
  assert.equal(stats.added, 1);
  assert.equal(stats.average, 3);
  assert.deepEqual(stats.distribution, { S: 1, A: 0, B: 0, C: 0, D: 1 });
  // S против A (1 тир) и D против D (0) → среднее расхождение 0.5 → 88%
  assert.equal(stats.agreement, 88);
  const burn = ratings.find((item) => item.drink === "burn-apple-kiwi");
  assert.equal(burn.othersAvg, 4);
  assert.equal(burn.addedByUser, true);
  assert.equal(burn.review, "Лучший, возьму ящик");
});

test("профиль: скрытый и несуществующий участник — 404, голос скрытого не влияет на стол", async () => {
  assert.equal((await request(ctx.base, "GET", "/api/public/profile/ghost")).status, 404);
  assert.equal((await request(ctx.base, "GET", "/api/public/profile/nobody")).status, 404);
  const kira = await request(ctx.base, "GET", "/api/public/profile/kira");
  assert.equal(kira.json.stats.ratings, 2);
  assert.equal(kira.json.ratings.find((item) => item.drink === "burn-apple-kiwi").othersAvg, 5);
});

test("профиль: пустой участник без оценок", async () => {
  await createUser(ctx.db, { username: "newbie", password: "newbie-pass-123", displayName: "Новичок" });
  const res = await request(ctx.base, "GET", "/api/public/profile/newbie");
  assert.equal(res.status, 200);
  assert.equal(res.json.stats.ratings, 0);
  assert.equal(res.json.stats.average, null);
  assert.equal(res.json.stats.agreement, null);
  const { activity } = res.json.stats;
  assert.deepEqual(activity.heatmap, []);
  assert.equal(activity.streak, 0);
  assert.equal(activity.bestWeekday, null);
  assert.equal(activity.topMonth, null);
  assert.equal(activity.lastAt, null);
});

test("профиль: активность — сетка дней, серия и инсайты", async () => {
  const res = await request(ctx.base, "GET", "/api/public/profile/sanya");
  assert.equal(res.status, 200);
  const { activity } = res.json.stats;
  assert.equal(activity.heatmap.length, 1, "вся активность сани — сегодня");
  assert.deepEqual(activity.heatmap[0], {
    date: new Date().toISOString().slice(0, 10),
    ratings: 2,
    added: 1,
  });
  assert.equal(activity.streak, 1);
  assert.equal(activity.streakAlive, true);
  assert.equal(activity.bestWeekday, new Date().getUTCDay());
  assert.equal(activity.topMonth.count, 3);
  assert.match(activity.topMonth.label, /^[а-я]{3}$/);
  assert.equal(activity.last30, 2);
  assert.match(activity.lastAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("страница профиля отдаётся статикой", async () => {
  const res = await request(ctx.base, "GET", "/profile.html?u=sanya");
  assert.equal(res.status, 200);
  assert.match(res.text, /profile\.js/);
});

test("кабинет /me отдаёт название и картинку оценённых банок и флаг публичности", async () => {
  const res = await request(ctx.base, "GET", "/api/cabinet/me", { cookie: sanyaCookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.isPublic, true);
  const burn = res.json.ratings.find((item) => item.drink === "burn-apple-kiwi");
  assert.equal(burn.name, "Burn Apple Kiwi");
  assert.equal(burn.image, "assets/favicon.svg");
});

test("findSimilarDrinks находит дубль по бренду и вкусу, игнорирует регистр и порядок слов", () => {
  const hits = findSimilarDrinks(ctx.db, { brand: "burn", name: "Burn Kiwi Apple", flavor: "" });
  assert.equal(hits[0]?.slug, "burn-apple-kiwi");
});

test("findSimilarDrinks не путает разные вкусы и чужие бренды", () => {
  assert.deepEqual(findSimilarDrinks(ctx.db, { brand: "Burn", name: "Burn Original", flavor: "" }), []);
  assert.deepEqual(findSimilarDrinks(ctx.db, { brand: "Red Bull", name: "Red Bull Apple Kiwi" }), []);
});

test("findSimilarDrinks: только бренд совпадает с «голой» банкой бренда", () => {
  const hits = findSimilarDrinks(ctx.db, { brand: "Volt", name: "Volt", flavor: "" });
  assert.equal(hits[0]?.slug, "volt-original");
});

test("findSimilarDrinks: опечатку бренда ловит fuzzy-Dice, а не жёсткий отсев", () => {
  ctx.db
    .prepare("INSERT INTO drinks (slug, brand, name, flavor) VALUES (?, ?, ?, ?)")
    .run("gorilla-mango", "Gorilla", "Gorilla Mango", "манго");
  const hits = findSimilarDrinks(ctx.db, { brand: "Gorila", name: "Gorila Mango", flavor: "" });
  assert.equal(hits[0]?.slug, "gorilla-mango");
  assert.equal(hits[0]?.confidence, "high");
  assert.match(hits[0]?.reason, /бренд/);
});

test("findSimilarDrinks: транслит «Ред Булл» ↔ «Red Bull» сходится по словам", () => {
  ctx.db
    .prepare("INSERT INTO drinks (slug, brand, name, flavor) VALUES (?, ?, ?, ?)")
    .run("red-bull-blueberry", "Ред Булл", "Ред Булл Original", "черника");
  const hits = findSimilarDrinks(ctx.db, { brand: "Red Bull", name: "Red Bull", flavor: "черника" });
  assert.equal(hits[0]?.slug, "red-bull-blueberry");
});

test("findSimilarDrinks: скрытые банки не попадают к юзеру, но видны админу", () => {
  ctx.db
    .prepare("INSERT INTO drinks (slug, brand, name, flavor, is_published) VALUES (?, ?, ?, ?, 0)")
    .run("hidden-volt", "Volt", "Volt Hidden", "манго");
  const visible = findSimilarDrinks(ctx.db, { brand: "Volt", name: "Volt Hidden Mango", flavor: "манго" });
  assert.equal(visible.some((hit) => hit.slug === "hidden-volt"), false);
  const all = findSimilarDrinks(
    ctx.db,
    { brand: "Volt", name: "Volt Hidden Mango", flavor: "манго" },
    { includeHidden: true },
  );
  const hidden = all.find((hit) => hit.slug === "hidden-volt");
  assert.ok(hidden, "с includeHidden скрытая банка должна найтись");
  assert.equal(hidden.hidden, true);
});

test("профиль: история видна только сотруднику на профиле сотрудника", async () => {
  const { cookie: editorCookie } = await login(ctx.base, "mod", "mod-pass-123");
  const rated = await request(ctx.base, "PUT", "/api/cabinet/ratings/volt-original", {
    cookie: editorCookie,
    body: { tier: "A", review: "Нормально" },
  });
  assert.equal(rated.status, 200);
  const created = await request(ctx.base, "POST", "/api/cabinet/drinks", {
    cookie: editorCookie,
    body: { brand: "Adrenaline", name: "Adrenaline Test", flavor: "Тест", tier: "B" },
  });
  assert.equal(created.status, 201);
  const editorRating = await request(ctx.base, "PUT", "/api/cabinet/ratings/burn-apple-kiwi", {
    cookie: editorCookie,
    body: { tier: "S", review: "Огонь" },
  });
  assert.equal(editorRating.status, 200);

  // гости и обычные участники истории не видят нигде
  assert.deepEqual((await request(ctx.base, "GET", "/api/public/profile/mod")).json.history, []);
  assert.deepEqual(
    (await request(ctx.base, "GET", "/api/public/profile/mod", { cookie: sanyaCookie })).json.history,
    [],
  );
  assert.deepEqual(
    (await request(ctx.base, "GET", "/api/public/profile/sanya", { cookie: editorCookie })).json.history,
    [],
  );

  // сотрудник на профиле сотрудника — видит
  const res = await request(ctx.base, "GET", "/api/public/profile/mod", { cookie: editorCookie });
  assert.equal(res.status, 200);
  const history = res.json.history;
  assert.ok(Array.isArray(history) && history.length >= 3);
  const createdEntry = history.find((item) => item.action === "drink.create");
  assert.equal(createdEntry.slug, created.json.drink.slug);
  assert.match(createdEntry.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.ok(history.some((item) => item.action === "rating.set" && item.slug === "volt-original"));
  for (const item of history) {
    assert.ok(!item.action.includes("settings"), item.action);
    assert.ok(!item.action.includes("user"), item.action);
  }
});

test("профиль: история не смешивается между участниками", async () => {
  const { cookie: editorCookie } = await login(ctx.base, "mod", "mod-pass-123");
  await createUser(ctx.db, {
    username: "histempty",
    password: "histempty-123",
    role: "editor",
    displayName: "Пустой",
  });
  const empty = await request(ctx.base, "GET", "/api/public/profile/histempty", { cookie: editorCookie });
  assert.deepEqual(empty.json.history, []);
  const mod = await request(ctx.base, "GET", "/api/public/profile/mod", { cookie: editorCookie });
  assert.ok(mod.json.history.length > 0);
});

test("профиль: модерация и настройки в публичную историю не попадают", async () => {
  await createUser(ctx.db, {
    username: "auditor",
    password: "auditor-pass-123",
    role: "admin",
    displayName: "Аудитор",
  });
  const { cookie } = await login(ctx.base, "auditor", "auditor-pass-123");
  const settings = await request(ctx.base, "PUT", "/api/admin/settings", {
    cookie,
    body: { siteTitle: "NRG / INDEX" },
  });
  assert.equal(settings.status, 200);
  const kira = ctx.db.prepare("SELECT id FROM users WHERE username = 'kira'").get();
  const patched = await request(ctx.base, "PATCH", `/api/admin/users/${kira.id}`, {
    cookie,
    body: { title: "тест" },
  });
  assert.equal(patched.status, 200);
  const res = await request(ctx.base, "GET", "/api/public/profile/auditor", { cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.history, []);
});

test("профиль: история ограничена 30 записями", async () => {
  const user = ctx.db.prepare("SELECT id FROM users WHERE username = 'histempty'").get();
  const insert = ctx.db.prepare(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, details, summary)
     VALUES (?, 'rating.set', 'rating', 'burn-apple-kiwi', '', 'Поставил свою оценку B')`,
  );
  for (let i = 0; i < 35; i++) insert.run(user.id);
  const { cookie: editorCookie } = await login(ctx.base, "mod", "mod-pass-123");
  const res = await request(ctx.base, "GET", "/api/public/profile/histempty", { cookie: editorCookie });
  assert.equal(res.json.history.length, 30);
});

test("страница профиля: локальные шрифты без Google", async () => {
  const res = await request(ctx.base, "GET", "/profile.html");
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("/fonts/fonts.css"), "должен подключаться локальный fonts.css");
  assert.ok(!res.text.includes("fonts.googleapis.com"), "Google Fonts больше не нужны");
});

test("на участника можно нажать: ссылки на профиль со всех страниц", () => {
  const app = read("public/app.js");
  assert.match(app, /class="view-chip__profile" href="profile\.html\?u=/);
  // Карточка банки рендерится общим модулем (app.js и профиль).
  assert.match(read("public/drink-dialog.js"), /<a class="reviewer" href="profile\.html\?u=/);
  assert.match(read("public/cabinet.html"), /id="profile-link"/);
  assert.match(
    read("public/cabinet.js"),
    /profile\.html\?u=\$\{encodeURIComponent\(state\.me\.username\)\}/,
  );
  assert.match(
    read("admin/admin.js"),
    /profile\.html\?u=\$\{encodeURIComponent\(user\.username\)\}/,
  );
  assert.match(read("public/profile.html"), /id="profile-history-block"/);
  assert.match(read("public/profile.js"), /renderHistory/);
});
