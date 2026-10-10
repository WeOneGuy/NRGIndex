const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, createUser, request } = require("../helpers");

const MONTHS = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];
// Прошлый месяц задаём от начала текущего — без «N дней назад».
const OLD_MONTH = "datetime('now', 'start of month', '-1 day')";

let ctx;
const ids = {};
const drinks = {};

const insertDrink = (db, slug, createdBy, { published = 1, old = false } = {}) =>
  db
    .prepare(
      `INSERT INTO drinks (slug, brand, name, flavor, created_by, is_published, created_at)
       VALUES (?, 'Test', ?, '', ?, ?, ${old ? OLD_MONTH : "datetime('now')"})`,
    )
    .run(slug, slug, createdBy, published).lastInsertRowid;

const insertRating = (db, drinkId, userId, tier, review = "", { old = false } = {}) =>
  db
    .prepare(
      `INSERT INTO ratings (drink_id, user_id, tier_id, review, updated_at)
       VALUES (?, ?, ?, ?, ${old ? OLD_MONTH : "datetime('now')"})`,
    )
    .run(drinkId, userId, tier, review);

const fetchTitles = async (base, username) => {
  const res = await request(base, "GET", `/api/public/profile/${username}`);
  assert.equal(res.status, 200, `профиль ${username} должен открываться`);
  return res.json.titles;
};

const itemIds = (titles) => titles.items.map((item) => item.id);

before(async () => {
  ctx = await startServer();
  for (const username of ["sanya", "kira", "marat", "boris", "ghost", "newbie", "lastmonth"]) {
    const user = await createUser(ctx.db, {
      username,
      password: `${username}-pass-123`,
      displayName: username,
    });
    ids[username] = user.id;
  }
  ctx.db.prepare("UPDATE users SET is_public = 0 WHERE id = ?").run(ids.ghost);

  // sanya — d1..d3, kira — d4, boris — d5; hidden — скрытая банка, её отзыв в 100 знаков не считается.
  drinks.d1 = insertDrink(ctx.db, "d1", ids.sanya);
  drinks.d2 = insertDrink(ctx.db, "d2", ids.sanya);
  drinks.d3 = insertDrink(ctx.db, "d3", ids.sanya);
  drinks.d4 = insertDrink(ctx.db, "d4", ids.kira);
  drinks.d5 = insertDrink(ctx.db, "d5", ids.boris);
  drinks.hidden = insertDrink(ctx.db, "hidden", ids.sanya, { published: 0 });

  insertRating(ctx.db, drinks.d1, ids.sanya, "S", "Лучший, возьму ящик");
  insertRating(ctx.db, drinks.d1, ids.kira, "A", "Ок");
  insertRating(ctx.db, drinks.d1, ids.marat, "B", "Норм");
  insertRating(ctx.db, drinks.d1, ids.ghost, "D");
  insertRating(ctx.db, drinks.d2, ids.sanya, "A", "Сладко, но норм");
  insertRating(ctx.db, drinks.d2, ids.kira, "C", "Так себе");
  insertRating(ctx.db, drinks.d3, ids.sanya, "C", "");
  insertRating(ctx.db, drinks.d3, ids.kira, "A", "Хорош");
  insertRating(ctx.db, drinks.d4, ids.sanya, "B", "Средняк");
  insertRating(ctx.db, drinks.d4, ids.boris, "A");
  insertRating(ctx.db, drinks.d5, ids.kira, "B", "Обычный");
  insertRating(ctx.db, drinks.d5, ids.boris, "S", "Топ");
  insertRating(ctx.db, drinks.hidden, ids.sanya, "S", "х".repeat(100));

  // lastmonth: своя старая банка и своя старая оценка — в текущий месяц не идут.
  drinks.old = insertDrink(ctx.db, "old-bank", ids.lastmonth, { old: true });
  insertRating(ctx.db, drinks.old, ids.lastmonth, "S", "Старый отзыв", { old: true });
});

after(async () => {
  await ctx.close();
});

test("титулы: семь титулов за месяц, порядок и подписи", async () => {
  const sanya = await fetchTitles(ctx.base, "sanya");
  assert.deepEqual(itemIds(sanya), ["rater", "detailed", "discoverer", "rebel"]);
  const byId = Object.fromEntries(sanya.items.map((item) => [item.id, item]));
  assert.equal(byId.rater.label, "Главный оцениватель");
  assert.equal(byId.rater.hint, "Больше всех оценок за месяц: 4");
  assert.equal(byId.detailed.label, "Самый подробный");
  // 41 знак: скрытая банка и её отзыв в 100 знаков не в счёте.
  assert.match(byId.detailed.hint, /41/);
  assert.equal(byId.discoverer.label, "Первооткрыватель");
  assert.equal(byId.discoverer.hint, "Больше всех новых банок: 3");
  assert.equal(byId.rebel.label, "Бунтарь");
  assert.match(byId.rebel.hint, /59/);

  const kira = await fetchTitles(ctx.base, "kira");
  assert.deepEqual(itemIds(kira), ["rater", "voice", "strict"]);
  const kiraById = Object.fromEntries(kira.items.map((item) => [item.id, item]));
  assert.equal(kiraById.rater.hint, "Больше всех оценок за месяц: 4");
  assert.equal(kiraById.voice.label, "Голос стола");
  assert.equal(kiraById.voice.hint, "Согласие со столом 63%");
  assert.equal(kiraById.strict.label, "Самый строгий");
  assert.equal(kiraById.strict.hint, "Средний балл 3,3 — ниже всех");

  const boris = await fetchTitles(ctx.base, "boris");
  assert.deepEqual(itemIds(boris), ["voice", "generous"]);
  const borisById = Object.fromEntries(boris.items.map((item) => [item.id, item]));
  assert.equal(borisById.voice.hint, "Согласие со столом 63%");
  assert.equal(borisById.generous.label, "Самый щедрый");
  assert.equal(borisById.generous.hint, "Средний балл 4,5 — выше всех");
});

test("титулы: ничьи отдают титул всем лидерам", async () => {
  const profiles = {};
  for (const username of ["sanya", "kira", "boris", "marat"]) {
    profiles[username] = await fetchTitles(ctx.base, username);
  }
  // sanya и kira — по 4 оценки, оба «Главные оцениватели».
  assert.deepEqual(itemIds(profiles.sanya).filter((id) => id === "rater"), ["rater"]);
  assert.deepEqual(itemIds(profiles.kira).filter((id) => id === "rater"), ["rater"]);
  assert.ok(!itemIds(profiles.boris).includes("rater"));
  // kira и boris — согласие 63%, оба «Голоса стола»; «Бунтарь» только у sanya (59%).
  assert.ok(itemIds(profiles.kira).includes("voice"));
  assert.ok(itemIds(profiles.boris).includes("voice"));
  assert.ok(!itemIds(profiles.sanya).includes("voice"));
  const rebels = Object.entries(profiles)
    .filter(([, titles]) => itemIds(titles).includes("rebel"))
    .map(([username]) => username);
  assert.deepEqual(rebels, ["sanya"]);
  // sanya со средним 3,5 — не край, extremes не его.
  assert.ok(!itemIds(profiles.sanya).includes("strict"));
  assert.ok(!itemIds(profiles.sanya).includes("generous"));
});

test("титулы: месяц, пустые участники и прошлый месяц", async () => {
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const sanya = await fetchTitles(ctx.base, "sanya");
  assert.deepEqual(sanya.month, { key: monthKey, label: MONTHS[now.getUTCMonth()] });
  // marat — 1 оценка (не максимум, пороги не взяты), newbie — пусто,
  // lastmonth — только прошлый месяц.
  for (const username of ["marat", "newbie", "lastmonth"]) {
    const titles = await fetchTitles(ctx.base, username);
    assert.deepEqual(titles.items, [], `${username} должен быть без титулов`);
    assert.deepEqual(titles.month, { key: monthKey, label: MONTHS[now.getUTCMonth()] });
  }
});

test("титулы: тихий стол — одиночка без голоса, при повторе голос есть, бунтаря нет", async () => {
  const quiet = await startServer();
  try {
    const first = await createUser(quiet.db, {
      username: "quiet",
      password: "quiet-pass-123",
      displayName: "Тихий",
    });
    const second = await createUser(quiet.db, {
      username: "second",
      password: "second-pass-123",
      displayName: "Второй",
    });
    const q1 = insertDrink(quiet.db, "q1", first.id);
    const q2 = insertDrink(quiet.db, "q2", first.id);
    insertRating(quiet.db, q1, first.id, "A", "Норм и вкусно");
    insertRating(quiet.db, q2, first.id, "B", "Средне");

    // В зачёте для сравнения он один: голос/бунтарь/средние не вручаются.
    const firstOnly = await fetchTitles(quiet.base, "quiet");
    assert.deepEqual(itemIds(firstOnly), ["rater", "detailed", "discoverer"]);
    assert.deepEqual((await fetchTitles(quiet.base, "second")).items, []);

    // Оба ставят одинаковые оценки на те же банки: согласие 100%, минимум не меньше максимума.
    insertRating(quiet.db, q1, second.id, "A");
    insertRating(quiet.db, q2, second.id, "B");
    const after = await fetchTitles(quiet.base, "quiet");
    const afterSecond = await fetchTitles(quiet.base, "second");
    assert.ok(itemIds(after).includes("voice"));
    assert.ok(itemIds(afterSecond).includes("voice"));
    assert.ok(!itemIds(after).includes("rebel"));
    assert.ok(!itemIds(afterSecond).includes("rebel"));
  } finally {
    await quiet.close();
  }
});
