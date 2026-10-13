// Админская карта базы: таблицы, колонки, ключи, счётчики и размер.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, createUser, request, login } = require("../helpers");

let ctx;
let adminCookie;
let userCookie;

before(async () => {
  ctx = await startServer();
  await createUser(ctx.db, { username: "admin", password: "admin-pass-123", role: "admin", displayName: "Админ" });
  await createUser(ctx.db, { username: "sanya", password: "sanya-pass-123", role: "user" });
  adminCookie = (await login(ctx.base, "admin", "admin-pass-123")).cookie;
  userCookie = (await login(ctx.base, "sanya", "sanya-pass-123")).cookie;
});

after(() => ctx.close());

test("база: админ видит таблицы, ключи и живые счётчики", async () => {
  const res = await request(ctx.base, "GET", "/api/admin/database", { cookie: adminCookie });
  assert.equal(res.status, 200);
  const { userVersion, sizeBytes, tables } = res.json;
  assert.ok(Number.isInteger(userVersion) && userVersion >= 1, "версия схемы должна вернуться");
  assert.ok(sizeBytes > 0, "размер базы должен быть больше нуля");

  const names = tables.map((table) => table.name);
  for (const name of [
    "users",
    "sessions",
    "tiers",
    "drinks",
    "drink_relations",
    "ratings",
    "settings",
    "audit_log",
    "login_attempts",
    "ai_usage",
  ]) {
    assert.ok(names.includes(name), `в карте нет таблицы ${name}`);
  }

  const byName = new Map(tables.map((table) => [table.name, table]));
  const users = byName.get("users");
  assert.equal(users.count, 2, "счётчик users должен быть живым");
  assert.ok(users.columns.find((column) => column.name === "id").pk, "users.id — первичный ключ");
  assert.ok(users.columns.find((column) => column.name === "username").unique, "users.username уникален");
  assert.ok(users.columns.find((column) => column.name === "role").notNull, "users.role обязателен");

  const sessions = byName.get("sessions");
  assert.ok(sessions.columns.find((column) => column.name === "user_id").notNull, "sessions.user_id обязателен");
  assert.ok(
    sessions.foreignKeys.some(
      (fk) => fk.column === "user_id" && fk.table === "users" && fk.columnTo === "id" && fk.onDelete === "CASCADE",
    ),
    "sessions.user_id → users.id (CASCADE)",
  );

  const ratings = byName.get("ratings");
  assert.deepEqual(
    ratings.foreignKeys.map((fk) => fk.table).sort(),
    ["drinks", "tiers", "users"],
    "ratings ссылается на drinks, tiers и users",
  );

  const relations = byName.get("drink_relations");
  assert.equal(
    relations.foreignKeys.filter((fk) => fk.table === "drinks").length,
    2,
    "у drink_relations две ссылки на drinks",
  );

  const audit = byName.get("audit_log");
  assert.ok(
    audit.foreignKeys.some((fk) => fk.table === "users" && fk.onDelete === "SET NULL"),
    "audit_log обнуляет автора при удалении пользователя",
  );
});

test("база: карта недоступна обычным пользователям и гостям", async () => {
  const user = await request(ctx.base, "GET", "/api/admin/database", { cookie: userCookie });
  assert.equal(user.status, 403);
  const anon = await request(ctx.base, "GET", "/api/admin/database", {});
  assert.equal(anon.status, 401);
});
