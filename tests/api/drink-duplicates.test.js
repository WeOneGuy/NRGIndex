const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, createUser, request, login } = require("../helpers");

let ctx;
let cookie;

const insertDrink = (fields) => {
  const info = ctx.db
    .prepare(
      `INSERT INTO drinks (slug, brand, name, flavor, edition, barcode, is_published)
       VALUES (@slug, @brand, @name, @flavor, @edition, @barcode, @is_published)`,
    )
    .run({
      slug: "",
      brand: "",
      name: "",
      flavor: "",
      edition: "",
      barcode: "",
      is_published: 1,
      ...fields,
    });
  return info.lastInsertRowid;
};

before(async () => {
  ctx = await startServer();
  await createUser(ctx.db, { username: "sanya", password: "sanya-pass-123", displayName: "Саша" });
  cookie = (await login(ctx.base, "sanya", "sanya-pass-123")).cookie;
  insertDrink({ slug: "burn-tropic", brand: "Burn", name: "Tropic", flavor: "манго", barcode: "4680036912629" });
  insertDrink({ slug: "monster-ultra", brand: "Monster", name: "Ultra", flavor: "цитрус", is_published: 0 });
  insertDrink({ slug: "torq-energy", brand: "TORQ", name: "TORQ Energy" });
});

after(async () => {
  await ctx.close();
});

const add = (body, c = cookie) => request(ctx.base, "POST", "/api/cabinet/drinks", { body, cookie: c });

test("без входа новый энергос не добавить", async () => {
  const res = await add({ brand: "Burn", name: "Tropic", flavor: "манго", tier: "B" }, "");
  assert.equal(res.status, 401);
});

test("похожий энергос без подтверждения не заводится — сервер отдаёт похожие", async () => {
  const before = ctx.db.prepare("SELECT COUNT(*) AS n FROM drinks").get().n;
  const res = await add({ brand: "Burn", name: "Tropic", flavor: "манго", tier: "B" });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, "duplicate");
  assert.ok(Array.isArray(res.json.similar) && res.json.similar.length > 0);
  assert.ok(res.json.similar.some((drink) => drink.slug === "burn-tropic"));
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM drinks").get().n, before, "дубль не создан");
});

test("с явным подтверждением «это другой энергос» дубль создаётся", async () => {
  const res = await add({
    brand: "Burn",
    name: "Tropic",
    flavor: "манго",
    tier: "B",
    confirmDifferent: true,
  });
  assert.equal(res.status, 201);
});

test("совпадение штрих-кода блокирует даже при другом названии", async () => {
  const res = await add({ brand: "Burn", name: "Tropic Light", flavor: "лайм", barcode: "4680036912629", tier: "B" });
  assert.equal(res.status, 409);
  assert.ok(res.json.similar.some((drink) => drink.reason === "штрих-код совпал"));
});

test("скрытая банка тоже считается дублем", async () => {
  const res = await add({ brand: "Monster", name: "Ultra", flavor: "цитрус", tier: "B" });
  assert.equal(res.status, 409);
  assert.ok(res.json.similar.some((drink) => drink.slug === "monster-ultra" && drink.hidden === true));
});

test("другой вкус того же бренда проходит без ложных срабатываний", async () => {
  const res = await add({ brand: "Burn", name: "Original", flavor: "классика", tier: "B" });
  assert.equal(res.status, 201);
});

test("после подтверждения штрих-кода банка всё-таки создаётся", async () => {
  const res = await add({
    brand: "Burn",
    name: "Tropic Light",
    flavor: "лайм",
    barcode: "4680036912629",
    tier: "B",
    confirmDifferent: true,
  });
  assert.equal(res.status, 201);
});

test("опечатка бренда без штрих-кода всё равно ловится", async () => {
  const res = await add({ brand: "Торк", name: "TORQ Original", tier: "B" });
  assert.equal(res.status, 409);
  assert.ok(res.json.similar.some((drink) => drink.slug === "torq-energy"));
});
