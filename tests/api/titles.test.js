const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, createUser, request } = require("../helpers");

// Прошлый месяц задаём от начала текущего — оценки и банки давностью больше
// месяца должны идти в зачёт: титулы считаются по всей истории.
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

const fetchProfile = async (base, username) => {
  const res = await request(base, "GET", `/api/public/profile/${username}`);
  assert.equal(res.status, 200, `профиль ${username} должен открываться`);
  return res.json;
};
const fetchTitles = async (base, username) => (await fetchProfile(base, username)).titles;
const itemIds = (titles) => titles.items.map((item) => item.id);
const byId = (titles) => Object.fromEntries(titles.items.map((item) => [item.id, item]));

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

  // lastmonth: своя старая банка и своя старая оценка — в зачёт идут, титулов не дают.
  drinks.old = insertDrink(ctx.db, "old-bank", ids.lastmonth, { old: true });
  insertRating(ctx.db, drinks.old, ids.lastmonth, "S", "Старый отзыв", { old: true });
});

after(async () => {
  await ctx.close();
});

test("титулы: считаются по всей истории и совпадают с цифрами профиля", async () => {
  const sanya = await fetchTitles(ctx.base, "sanya");
  assert.deepEqual(itemIds(sanya), ["rater", "detailed", "discoverer"]);
  const sanyaById = byId(sanya);
  assert.equal(sanyaById.rater.hint, "Больше всех оценок: 4");
  // 41 знак: скрытая банка и её отзыв в 100 знаков не в счёте.
  assert.match(sanyaById.detailed.hint, /41/);
  assert.equal(sanyaById.discoverer.hint, "Больше всех новых банок: 3");

  const kira = await fetchTitles(ctx.base, "kira");
  assert.deepEqual(itemIds(kira), ["rater", "voice", "strict"]);
  const kiraById = byId(kira);
  assert.equal(kiraById.voice.hint, "Согласие со столом 63%");
  assert.equal(kiraById.strict.hint, "Средний балл 3,3 — ниже всех");

  const boris = await fetchTitles(ctx.base, "boris");
  assert.deepEqual(itemIds(boris), ["voice", "generous"]);
  const borisById = byId(boris);
  assert.equal(borisById.voice.hint, "Согласие со столом 63%");
  assert.equal(borisById.generous.hint, "Средний балл 4,5 — выше всех");
});

test("титулы: строгий и щедрый — та же средняя, что в статистике профиля", async () => {
  const profiles = {};
  for (const username of ["sanya", "kira", "boris", "marat"]) {
    profiles[username] = await fetchProfile(ctx.base, username);
  }
  assert.equal(profiles.kira.stats.average, 3.25);
  const eligible = Object.entries(profiles)
    .filter(([, profile]) => profile.stats.ratings >= 2)
    .sort((a, b) => a[1].stats.average - b[1].stats.average);
  assert.equal(eligible[0][0], "kira", "самый строгий — у минимальной средней");
  assert.equal(eligible.at(-1)[0], "boris", "самый щедрый — у максимальной средней");
  assert.equal(byId(profiles.kira.titles).strict.hint, "Средний балл 3,3 — ниже всех");
});

test("титулы: больше трёх одному не достаётся, лишний не уходит следующему", async () => {
  const all = {};
  for (const username of ["sanya", "kira", "boris", "marat", "newbie", "lastmonth"]) {
    all[username] = await fetchTitles(ctx.base, username);
  }
  for (const [username, titles] of Object.entries(all)) {
    assert.ok(titles.items.length <= 3, `${username}: не больше трёх титулов`);
  }
  // sanya — лидер и по худшему согласию (59%), но у него уже три титула:
  // «бунтарь» не вручается никому, а не уходит следующему по метрике.
  assert.deepEqual(itemIds(all.sanya), ["rater", "detailed", "discoverer"]);
  assert.ok(!Object.values(all).some((titles) => itemIds(titles).includes("rebel")));
});

test("титулы: ничьи отдают титул всем лидерам", async () => {
  const sanya = await fetchTitles(ctx.base, "sanya");
  const kira = await fetchTitles(ctx.base, "kira");
  const boris = await fetchTitles(ctx.base, "boris");
  // sanya и kira — по 4 оценки, оба «Главные оцениватели».
  assert.ok(itemIds(sanya).includes("rater"));
  assert.ok(itemIds(kira).includes("rater"));
  assert.ok(!itemIds(boris).includes("rater"));
  // kira и boris — согласие 63%, оба «Голоса стола».
  assert.ok(itemIds(kira).includes("voice"));
  assert.ok(itemIds(boris).includes("voice"));
});

test("титулы: пустые и старые участники без титулов", async () => {
  // marat — 1 оценка (пороги не взяты), newbie — пусто,
  // lastmonth — одна старая оценка и одна старая банка.
  for (const username of ["marat", "newbie", "lastmonth"]) {
    assert.deepEqual((await fetchTitles(ctx.base, username)).items, [], `${username} должен быть без титулов`);
  }
});

test("титулы: оценки и банки прошлых месяцев идут в зачёт", async () => {
  const old = await startServer();
  try {
    const user = await createUser(old.db, {
      username: "oldmate",
      password: "oldmate-pass-123",
      displayName: "Старый",
    });
    const first = insertDrink(old.db, "o1", user.id, { old: true });
    const second = insertDrink(old.db, "o2", user.id, { old: true });
    insertRating(old.db, first, user.id, "A", "Давний отзыв", { old: true });
    insertRating(old.db, second, user.id, "B", "Норм", { old: true });
    const titles = await fetchTitles(old.base, "oldmate");
    assert.deepEqual(itemIds(titles), ["rater", "detailed", "discoverer"]);
  } finally {
    await old.close();
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

    // Оба ставят одинаковые оценки на те же банки: голос есть у обоих,
    // но у «quiet» уже три титула — «голос стола» уходит только второму.
    insertRating(quiet.db, q1, second.id, "A");
    insertRating(quiet.db, q2, second.id, "B");
    const after = await fetchTitles(quiet.base, "quiet");
    const afterSecond = await fetchTitles(quiet.base, "second");
    assert.deepEqual(itemIds(after), ["rater", "detailed", "discoverer"]);
    assert.deepEqual(itemIds(afterSecond), ["rater", "voice"]);
    // Средние совпали: минимум не меньше максимума, «бунтарь» никому не вручается.
    assert.ok(!itemIds(after).includes("rebel"));
    assert.ok(!itemIds(afterSecond).includes("rebel"));
  } finally {
    await quiet.close();
  }
});
