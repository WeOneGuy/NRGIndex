const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { startServer, createUser, request, login } = require("../helpers");

let testImageDataUrl;
const hexToRgb = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));

let ctx;
let adminCookie;
let editorCookie;
let userCookie;
let createdDrink;

before(async () => {
  const width = 60;
  const height = 60;
  const raw = Buffer.alloc(width * height * 4, 255);
  for (let y = 15; y < 45; y++) {
    for (let x = 18; x < 42; x++) {
      const offset = (y * width + x) * 4;
      raw[offset] = 30;
      raw[offset + 1] = 90;
      raw[offset + 2] = 220;
      raw[offset + 3] = 255;
    }
  }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
  testImageDataUrl = `data:image/png;base64,${png.toString("base64")}`;

  ctx = await startServer();
  await createUser(ctx.db, { username: "admin", password: "admin-pass-123", role: "admin", displayName: "Админ" });
  await createUser(ctx.db, { username: "editor", password: "editor-pass-123", role: "editor", displayName: "Редактор" });
  await createUser(ctx.db, { username: "sanya", password: "sanya-pass-123", role: "user", displayName: "Саша" });
  await createUser(ctx.db, { username: "other", password: "other-pass-123", role: "user", displayName: "Другой" });

  adminCookie = (await login(ctx.base, "admin", "admin-pass-123")).cookie;
  editorCookie = (await login(ctx.base, "editor", "editor-pass-123")).cookie;
  userCookie = (await login(ctx.base, "sanya", "sanya-pass-123")).cookie;
});

after(async () => {
  await ctx.close();
});

test("health отдаёт версию", async () => {
  const res = await request(ctx.base, "GET", "/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
});

test("публичная сводка: тиры, участники, пустые напитки", async () => {
  const res = await request(ctx.base, "GET", "/api/public/summary");
  assert.equal(res.status, 200);
  assert.equal(res.json.tiers.length, 5);
  assert.equal(res.json.participants.length, 4);
  assert.equal(res.json.drinks.length, 0);
  assert.match(res.json.updatedAt, /^\d{2}\.\d{2}\.\d{4}$/);
  assert.equal(res.json.participants[0].role, "");
  assert.ok(res.json.participants[0].color.startsWith("#"));
});

test("статичные страницы отдаются", async () => {
  for (const page of ["/", "/cabinet.html", "/styles.css"]) {
    const res = await fetch(ctx.base + page);
    assert.equal(res.status, 200, `${page} должен отдаваться`);
  }
  const adminPage = await fetch(ctx.base + "/admin", { redirect: "manual" });
  assert.equal(adminPage.status, 302);
});

test("логин: неверный пароль и отсутствие полей", async () => {
  const wrong = await request(ctx.base, "POST", "/api/auth/login", {
    body: { username: "admin", password: "nope" },
  });
  assert.equal(wrong.status, 401);
  const empty = await request(ctx.base, "POST", "/api/auth/login", { body: {} });
  assert.equal(empty.status, 400);
});

test("rate-limit: после 5 неудач — 429", async () => {
  for (let i = 0; i < 5; i++) {
    const res = await request(ctx.base, "POST", "/api/auth/login", {
      body: { username: "bruteforce", password: "bad" },
    });
    assert.equal(res.status, 401);
  }
  const blocked = await request(ctx.base, "POST", "/api/auth/login", {
    body: { username: "bruteforce", password: "bad" },
  });
  assert.equal(blocked.status, 429);
});

test("CSRF: без заголовка и с чужим Origin — отказ", async () => {
  const noHeader = await request(ctx.base, "POST", "/api/auth/login", {
    body: { username: "admin", password: "admin-pass-123" },
    csrf: false,
  });
  assert.equal(noHeader.status, 403);

  const badOrigin = await request(ctx.base, "POST", "/api/auth/login", {
    body: { username: "admin", password: "admin-pass-123" },
    headers: { origin: "https://evil.example" },
  });
  assert.equal(badOrigin.status, 403);
});

test("сессия: me и logout", async () => {
  const me = await request(ctx.base, "GET", "/api/auth/me", { cookie: adminCookie });
  assert.equal(me.json.user.role, "admin");

  const anon = await request(ctx.base, "GET", "/api/auth/me");
  assert.equal(anon.json.user, null);

  const logout = await request(ctx.base, "POST", "/api/auth/logout", { cookie: editorCookie });
  assert.equal(logout.status, 200);
  const afterLogout = await request(ctx.base, "GET", "/api/auth/me", { cookie: editorCookie });
  assert.equal(afterLogout.json.user, null);

  editorCookie = (await login(ctx.base, "editor", "editor-pass-123")).cookie;
});

test("смена пароля: старый перестаёт работать", async () => {
  await createUser(ctx.db, { username: "passuser", password: "old-pass-123", role: "user" });
  const { cookie } = await login(ctx.base, "passuser", "old-pass-123");

  const wrongCurrent = await request(ctx.base, "POST", "/api/auth/password", {
    cookie,
    body: { currentPassword: "nope", newPassword: "new-pass-123" },
  });
  assert.equal(wrongCurrent.status, 401);

  const changed = await request(ctx.base, "POST", "/api/auth/password", {
    cookie,
    body: { currentPassword: "old-pass-123", newPassword: "new-pass-123" },
  });
  assert.equal(changed.status, 200);

  const oldLogin = await login(ctx.base, "passuser", "old-pass-123");
  assert.equal(oldLogin.res.status, 401);
  const newLogin = await login(ctx.base, "passuser", "new-pass-123");
  assert.equal(newLogin.res.status, 200);
});

test("загрузки: аноним 401, валидный PNG 201 c авто-цветом в webp, мусор 400", async () => {
  const anon = await request(ctx.base, "POST", "/api/uploads", { body: { dataUrl: testImageDataUrl } });
  assert.equal(anon.status, 401);

  const ok = await request(ctx.base, "POST", "/api/uploads", {
    cookie: userCookie,
    body: { dataUrl: testImageDataUrl },
  });
  assert.equal(ok.status, 201);
  assert.match(ok.json.path, /^\/uploads\/[a-z0-9-]+\.webp$/);
  assert.equal(ok.json.accent.length, 2);
  const [r, g, b] = hexToRgb(ok.json.accent[0]);
  assert.ok(b > r + 40 && b > g, `акцент должен быть синеватым: ${ok.json.accent[0]}`);

  const served = await fetch(ctx.base + ok.json.path);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/webp");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");

  const bad = await request(ctx.base, "POST", "/api/uploads", {
    cookie: userCookie,
    body: { dataUrl: "data:text/plain;base64,aGk=" },
  });
  assert.equal(bad.status, 400);
});

test("редактор не может управлять пользователями", async () => {
  const res = await request(ctx.base, "POST", "/api/admin/users", {
    cookie: editorCookie,
    body: { username: "nope", displayName: "Нельзя", role: "admin" },
  });
  assert.equal(res.status, 403);
});

test("админ создаёт напиток, оценка из кабинета видна в сводке", async () => {
  const created = await request(ctx.base, "POST", "/api/admin/drinks", {
    cookie: adminCookie,
    body: {
      brand: "Adrenaline",
      name: "Adrenaline Rush",
      flavor: "Юдзу-клубника",
      edition: "Лимитка",
      imageDataUrl: testImageDataUrl,
      published: true,
    },
  });
  assert.equal(created.status, 201);
  createdDrink = created.json.drink;
  assert.match(createdDrink.slug, /^adrenaline-/);
  const [r, g, b] = hexToRgb(createdDrink.accent[0]);
  assert.ok(b > r + 40 && b > g, `акцент из картинки: ${createdDrink.accent[0]}`);

  const rated = await request(ctx.base, "PUT", `/api/cabinet/ratings/${createdDrink.slug}`, {
    cookie: userCookie,
    body: { tier: "S", review: "Топчик" },
  });
  assert.equal(rated.status, 200);

  const summary = await request(ctx.base, "GET", "/api/public/summary");
  const drink = summary.json.drinks.find((d) => d.id === createdDrink.slug);
  assert.equal(drink.ratings.sanya.tier, "S");
  assert.equal(drink.ratings.sanya.review, "Топчик");
  assert.equal(drink.image, createdDrink.image);
});

test("удаление тира, который используется — 409", async () => {
  const res = await request(ctx.base, "DELETE", "/api/admin/tiers/S", { cookie: adminCookie });
  assert.equal(res.status, 409);
});

test("кабинет: пользователь добавляет свой напиток с фото", async () => {
  const res = await request(ctx.base, "POST", "/api/cabinet/drinks", {
    cookie: userCookie,
    body: {
      brand: "Volt",
      name: "Volt Mango",
      flavor: "Манго",
      edition: "Классика",
      tier: "A",
      review: "Хорошо бодрит",
      imageDataUrl: testImageDataUrl,
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.drink.published, true);
  assert.match(res.json.drink.image, /^\/uploads\//);
  const [vr, vg, vb] = hexToRgb(res.json.drink.accent[0]);
  assert.ok(vb > vr + 40 && vb > vg, `акцент из картинки: ${res.json.drink.accent[0]}`);

  const slug = res.json.drink.slug;
  // «Сохранится всё»: тир, отзыв и фото реально записаны вместе с банкой.
  const mine = await request(ctx.base, "GET", "/api/cabinet/me", { cookie: userCookie });
  const saved = mine.json.ratings.find((rating) => rating.drink === slug);
  assert.equal(saved.tier, "A");
  assert.equal(saved.review, "Хорошо бодрит");
  assert.match(saved.image, /^\/uploads\//);
  const otherCookie = (await login(ctx.base, "other", "other-pass-123")).cookie;
  const forbidden = await request(ctx.base, "DELETE", `/api/cabinet/drinks/${slug}`, {
    cookie: otherCookie,
  });
  assert.equal(forbidden.status, 404);

  const patched = await request(ctx.base, "PATCH", `/api/cabinet/drinks/${slug}`, {
    cookie: userCookie,
    body: { brand: "Volt", name: "Volt Mango", flavor: "Манго-маракуйя", tier: "A", review: "" },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.drink.flavor, "Манго-маракуйя");

  // Частичный патч: только отзыв — тир, бренд и название не сбрасываются.
  const onlyReview = await request(ctx.base, "PATCH", `/api/cabinet/drinks/${slug}`, {
    cookie: userCookie,
    body: { review: "Манго-маракуйя — топ" },
  });
  assert.equal(onlyReview.status, 200);
  assert.equal(onlyReview.json.drink.brand, "Volt");
  assert.equal(onlyReview.json.drink.flavor, "Манго-маракуйя");

  const onlyTier = await request(ctx.base, "PATCH", `/api/cabinet/drinks/${slug}`, {
    cookie: userCookie,
    body: { tier: "S" },
  });
  assert.equal(onlyTier.status, 200);
  const kept = (await request(ctx.base, "GET", "/api/cabinet/me", { cookie: userCookie })).json.ratings.find(
    (rating) => rating.drink === slug,
  );
  assert.equal(kept.tier, "S", "тир обновился");
  assert.equal(kept.review, "Манго-маракуйя — топ", "отзыв не сбросился дефолтом");

  const removed = await request(ctx.base, "DELETE", `/api/cabinet/drinks/${slug}`, {
    cookie: userCookie,
  });
  assert.equal(removed.status, 200);
});

test("снятие с публикации скрывает напиток", async () => {
  const off = await request(ctx.base, "PATCH", `/api/admin/drinks/${createdDrink.id}`, {
    cookie: editorCookie,
    body: { published: false },
  });
  assert.equal(off.status, 200);
  let summary = await request(ctx.base, "GET", "/api/public/summary");
  assert.equal(summary.json.drinks.some((d) => d.id === createdDrink.slug), false);

  const on = await request(ctx.base, "PATCH", `/api/admin/drinks/${createdDrink.id}`, {
    cookie: editorCookie,
    body: { published: true },
  });
  assert.equal(on.status, 200);
  summary = await request(ctx.base, "GET", "/api/public/summary");
  assert.equal(summary.json.drinks.some((d) => d.id === createdDrink.slug), true);
});

test("published: строка «false» — 400, а не молчаливое true", async () => {
  const res = await request(ctx.base, "PATCH", `/api/admin/drinks/${createdDrink.id}`, {
    cookie: adminCookie,
    body: { published: "false" },
  });
  assert.equal(res.status, 400);
});

test("переобработка картинки: редактор может, акцент остаётся по банке", async () => {
  const res = await request(
    ctx.base,
    "POST",
    `/api/admin/drinks/${createdDrink.id}/reprocess-image`,
    { cookie: editorCookie },
  );
  assert.equal(res.status, 200);
  assert.match(res.json.drink.image, /^\/uploads\//);
  const [r, g, b] = hexToRgb(res.json.drink.accent[0]);
  assert.ok(b > r && b > g, `акцент остаётся синеватым: ${res.json.drink.accent[0]}`);
});

test("переобработка недоступна для картинок не из uploads", async () => {
  const created = await request(ctx.base, "POST", "/api/admin/drinks", {
    cookie: adminCookie,
    body: { brand: "Asset", name: "Asset Drink", flavor: "Тест", image: "/assets/favicon.svg" },
  });
  assert.equal(created.status, 201);
  const res = await request(
    ctx.base,
    "POST",
    `/api/admin/drinks/${created.json.drink.id}/reprocess-image`,
    { cookie: adminCookie },
  );
  assert.equal(res.status, 400);
});

test("пользователи: создание с временным паролем, роль, удаление", async () => {
  const created = await request(ctx.base, "POST", "/api/admin/users", {
    cookie: adminCookie,
    body: { username: "newbie", displayName: "Новичок", role: "user", title: "Соучастник" },
  });
  assert.equal(created.status, 201);
  assert.ok(created.json.tempPassword.length >= 10);

  const firstLogin = await login(ctx.base, "newbie", created.json.tempPassword);
  assert.equal(firstLogin.res.status, 200);
  assert.equal(firstLogin.res.json.user.mustChangePassword, true);

  const duplicate = await request(ctx.base, "POST", "/api/admin/users", {
    cookie: adminCookie,
    body: { username: "newbie", displayName: "Дубль" },
  });
  assert.equal(duplicate.status, 409);

  const promoted = await request(ctx.base, "PATCH", `/api/admin/users/${created.json.user.id}`, {
    cookie: adminCookie,
    body: { role: "editor", isActive: true },
  });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.json.user.role, "editor");

  const removed = await request(ctx.base, "DELETE", `/api/admin/users/${created.json.user.id}`, {
    cookie: adminCookie,
  });
  assert.equal(removed.status, 200);
});

test("нельзя убрать последнего админа и удалить себя", async () => {
  const selfDemote = await request(ctx.base, "PATCH", "/api/admin/users/1", {
    cookie: adminCookie,
    body: { role: "user" },
  });
  assert.equal(selfDemote.status, 409);

  const selfDelete = await request(ctx.base, "DELETE", "/api/admin/users/1", {
    cookie: adminCookie,
  });
  assert.equal(selfDelete.status, 409);
});

test("смена логина: себе и другому, занятый логин, сессия сохраняется", async () => {
  const taken = await request(ctx.base, "PATCH", "/api/admin/users/1", {
    cookie: adminCookie,
    body: { username: "Editor" },
  });
  assert.equal(taken.status, 409);

  const invalid = await request(ctx.base, "PATCH", "/api/admin/users/1", {
    cookie: adminCookie,
    body: { username: "a b" },
  });
  assert.equal(invalid.status, 400);

  const renamed = await request(ctx.base, "PATCH", "/api/admin/users/1", {
    cookie: adminCookie,
    body: { username: "Boss" },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.user.username, "boss");

  const stillIn = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  assert.equal(stillIn.status, 200);
  assert.equal(stillIn.json.me.username, "boss");

  assert.equal((await login(ctx.base, "admin", "admin-pass-123")).res.status, 401);
  // вход завершает прежние сессии — дальше работаем с новой кукой
  const bossLogin = await login(ctx.base, "boss", "admin-pass-123");
  assert.equal(bossLogin.res.status, 200);

  const back = await request(ctx.base, "PATCH", "/api/admin/users/1", {
    cookie: bossLogin.cookie,
    body: { username: "admin" },
  });
  assert.equal(back.status, 200);
  const adminLogin = await login(ctx.base, "admin", "admin-pass-123");
  assert.equal(adminLogin.res.status, 200);
  adminCookie = adminLogin.cookie;
});

test("настройки: редактору нельзя, админ меняет, ключ не утекает", async () => {
  const denied = await request(ctx.base, "PUT", "/api/admin/settings", {
    cookie: editorCookie,
    body: { siteTitle: "Хак" },
  });
  assert.equal(denied.status, 403);

  const updated = await request(ctx.base, "PUT", "/api/admin/settings", {
    cookie: adminCookie,
    body: { siteTitle: "NRG / INDEX", openrouterKey: "sk-test-secret", openrouterModel: "openai/gpt-4o-mini" },
  });
  assert.equal(updated.status, 200);

  const data = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  assert.equal(data.json.settings.openrouterKeySet, true);
  assert.equal(JSON.stringify(data.json.settings).includes("sk-test-secret"), false);

  const editorData = await request(ctx.base, "GET", "/api/admin/data", { cookie: editorCookie });
  assert.equal(editorData.json.audit.length, 0);
  assert.equal(JSON.stringify(editorData.json.settings).includes("sk-test-secret"), false);
  assert.ok(data.json.audit.length > 0);
});

test("аудит: редактор не видит, админ видит", async () => {
  const asEditor = await request(ctx.base, "GET", "/api/admin/data", { cookie: editorCookie });
  assert.equal(asEditor.status, 200);
  assert.equal(asEditor.json.audit.length, 0);
  assert.equal(asEditor.json.drinks.length >= 1, true);
});

test("скрытый пользователь исчезает из публичной сводки вместе с оценками", async () => {
  const sanya = ctx.db.prepare("SELECT id FROM users WHERE username = 'sanya'").get();
  const hidden = await request(ctx.base, "PATCH", `/api/admin/users/${sanya.id}`, {
    cookie: adminCookie,
    body: { isPublic: false },
  });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.json.user.isPublic, false);

  const summary = await request(ctx.base, "GET", "/api/public/summary");
  assert.equal(summary.json.participants.some((p) => p.id === "sanya"), false);
  const drink = summary.json.drinks.find((d) => d.id === createdDrink.slug);
  assert.equal("sanya" in drink.ratings, false);

  const back = await request(ctx.base, "PATCH", `/api/admin/users/${sanya.id}`, {
    cookie: adminCookie,
    body: { isPublic: true },
  });
  assert.equal(back.json.user.isPublic, true);
});

test("журнал: понятное описание и откат удаления оценки", async () => {
  const slug = createdDrink.slug;
  const set = await request(ctx.base, "PUT", `/api/cabinet/ratings/${slug}`, {
    cookie: userCookie,
    body: { tier: "A", review: "Хорош" },
  });
  assert.equal(set.status, 200);
  const del = await request(ctx.base, "DELETE", `/api/cabinet/ratings/${slug}`, { cookie: userCookie });
  assert.equal(del.status, 200);

  let data = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  const entry = data.json.audit.find((row) => row.action === "rating.delete");
  assert.match(entry.summary, /Удалил свою оценку/);
  assert.match(entry.details, /Была: A/);
  assert.equal(entry.canUndo, true);

  const earlier = data.json.audit.find((row) => row.action === "rating.set" && row.id < entry.id);
  assert.equal(earlier.canUndo, false, "более ранняя запись по тому же объекту заблокирована");

  const undo = await request(ctx.base, "POST", `/api/admin/audit/${entry.id}/undo`, { cookie: adminCookie });
  assert.equal(undo.status, 200);
  const summary = await request(ctx.base, "GET", "/api/public/summary");
  const drink = summary.json.drinks.find((d) => d.id === slug);
  assert.equal(drink.ratings.sanya.tier, "A");
  assert.equal(drink.ratings.sanya.review, "Хорош");

  const again = await request(ctx.base, "POST", `/api/admin/audit/${entry.id}/undo`, { cookie: adminCookie });
  assert.equal(again.status, 409);

  data = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  const undoRow = data.json.audit.find((row) => row.action === "audit.undo");
  assert.equal(undoRow.undoOf, entry.id);
  assert.ok(data.json.audit.find((row) => row.id === entry.id).undoneAt);
});

test("журнал: откат удаления напитка восстанавливает его вместе с оценками", async () => {
  const created = await request(ctx.base, "POST", "/api/admin/drinks", {
    cookie: adminCookie,
    body: { brand: "Tornado", name: "Tornado Storm", flavor: "Кола" },
  });
  const drink = created.json.drink;
  await request(ctx.base, "PUT", `/api/cabinet/ratings/${drink.slug}`, {
    cookie: userCookie,
    body: { tier: "C", review: "так себе" },
  });
  const removed = await request(ctx.base, "DELETE", `/api/admin/drinks/${drink.id}`, { cookie: adminCookie });
  assert.equal(removed.status, 200);

  const data = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  const entry = data.json.audit.find((row) => row.action === "admin.drink.delete" && row.entityId === drink.slug);
  assert.match(entry.summary, /Удалил напиток «Tornado Storm»/);
  assert.match(entry.details, /оценок: 1/);

  const editorUndo = await request(ctx.base, "POST", `/api/admin/audit/${entry.id}/undo`, { cookie: editorCookie });
  assert.equal(editorUndo.status, 403);

  const undo = await request(ctx.base, "POST", `/api/admin/audit/${entry.id}/undo`, { cookie: adminCookie });
  assert.equal(undo.status, 200);
  const summary = await request(ctx.base, "GET", "/api/public/summary");
  const back = summary.json.drinks.find((d) => d.id === drink.slug);
  assert.ok(back);
  assert.equal(back.ratings.sanya.tier, "C");
});

test("журнал: изменение напитка показывает «было → стало» и откатывается", async () => {
  const patched = await request(ctx.base, "PATCH", `/api/admin/drinks/${createdDrink.id}`, {
    cookie: adminCookie,
    body: { flavor: "Персик" },
  });
  assert.equal(patched.status, 200);
  const data = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  const entry = data.json.audit.find((row) => row.action === "admin.drink.update");
  assert.match(entry.details, /Вкус: «Юдзу-клубника» → «Персик»/);
  const undo = await request(ctx.base, "POST", `/api/admin/audit/${entry.id}/undo`, { cookie: adminCookie });
  assert.equal(undo.status, 200);
  const after = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  assert.equal(after.json.drinks.find((d) => d.id === createdDrink.id).flavor, "Юдзу-клубника");
});

test("настройки ИИ: base URL и STT-модель, кривой URL отклоняется", async () => {
  const bad = await request(ctx.base, "PUT", "/api/admin/settings", {
    cookie: adminCookie,
    body: { aiBaseUrl: "javascript:alert(1)" },
  });
  assert.equal(bad.status, 400);

  const ok = await request(ctx.base, "PUT", "/api/admin/settings", {
    cookie: adminCookie,
    body: { aiBaseUrl: "https://llm.example/v1/", sttModel: "" },
  });
  assert.equal(ok.status, 200);
  const data = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  assert.equal(data.json.settings.aiBaseUrl, "https://llm.example/v1");
  assert.equal(data.json.settings.sttModel, "openai/whisper-large-v3-turbo");
  const entry = data.json.audit.find((row) => row.action === "admin.settings.update");
  assert.match(entry.details, /Base URL: «https:\/\/openrouter.ai\/api\/v1» → «https:\/\/llm.example\/v1»/);
});

test("настройки ИИ: провайдер перерисовки валидируется и сохраняется", async () => {
  const bad = await request(ctx.base, "PUT", "/api/admin/settings", {
    cookie: adminCookie,
    body: { imageProvider: "dalle" },
  });
  assert.equal(bad.status, 400);

  const ok = await request(ctx.base, "PUT", "/api/admin/settings", {
    cookie: adminCookie,
    body: { imageProvider: "openrouter", openrouterImageModel: "openai/gpt-image-2.5-sunburst" },
  });
  assert.equal(ok.status, 200);
  const data = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  assert.equal(data.json.settings.imageProvider, "openrouter");
  assert.equal(data.json.settings.openrouterImageModel, "openai/gpt-image-2.5-sunburst");
  assert.equal(data.json.settings.defaults.openrouterImageModel, "openai/gpt-image-2.5-sunburst");
  await request(ctx.base, "PUT", "/api/admin/settings", { cookie: adminCookie, body: { imageProvider: "gemini" } });
});

test("настройки ИИ: промпты генерации сохраняются и сбрасываются", async () => {
  const set = await request(ctx.base, "PUT", "/api/admin/settings", {
    cookie: adminCookie,
    body: { openrouterImagePrompt: "Custom OR prompt", geminiImagePrompt: "Custom Gemini prompt" },
  });
  assert.equal(set.status, 200);
  let data = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  assert.equal(data.json.settings.openrouterImagePrompt, "Custom OR prompt");
  assert.equal(data.json.settings.geminiImagePrompt, "Custom Gemini prompt");

  const tooLong = await request(ctx.base, "PUT", "/api/admin/settings", {
    cookie: adminCookie,
    body: { openrouterImagePrompt: "x".repeat(4001) },
  });
  assert.equal(tooLong.status, 400);

  const reset = await request(ctx.base, "PUT", "/api/admin/settings", {
    cookie: adminCookie,
    body: { openrouterImagePrompt: "", geminiImagePrompt: "" },
  });
  assert.equal(reset.status, 200);
  data = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  assert.match(data.json.settings.openrouterImagePrompt, /transparent/i);
  assert.match(data.json.settings.geminiImagePrompt, /#00FF00/);
});

test("настройки ИИ: фото-шаблон загружается, отдаётся и сбрасывается", async () => {
  const bad = await request(ctx.base, "POST", "/api/admin/settings/image-template", {
    cookie: adminCookie,
    body: { dataUrl: "data:image/png;base64,AAAA" },
  });
  assert.equal(bad.status, 400);

  const upload = await request(ctx.base, "POST", "/api/admin/settings/image-template", {
    cookie: adminCookie,
    body: { dataUrl: testImageDataUrl },
  });
  assert.equal(upload.status, 201);
  assert.match(upload.json.path, /^\/uploads\/template-[a-z0-9-]+\.png$/);
  assert.ok(fs.existsSync(path.join(ctx.config.uploadsDir, path.basename(upload.json.path))));

  let data = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  assert.equal(data.json.settings.openrouterImageTemplate, upload.json.path);

  const reset = await request(ctx.base, "DELETE", "/api/admin/settings/image-template", { cookie: adminCookie });
  assert.equal(reset.status, 200);
  data = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  assert.equal(data.json.settings.openrouterImageTemplate, "");
});

test("ассортимент: гость не может, без ключа Gemini — 503", async () => {
  const guest = await request(ctx.base, "POST", "/api/cabinet/ai/assortment", {
    body: { imageDataUrl: testImageDataUrl },
  });
  assert.equal(guest.status, 401);
  const noKey = await request(ctx.base, "POST", "/api/cabinet/ai/assortment", {
    cookie: userCookie,
    body: { imageDataUrl: testImageDataUrl },
  });
  assert.equal(noKey.status, 503);
});

test("настройки ИИ: модель распознавания ассортимента сохраняется", async () => {
  const ok = await request(ctx.base, "PUT", "/api/admin/settings", {
    cookie: adminCookie,
    body: { geminiVisionModel: "gemini-3.8-flash" },
  });
  assert.equal(ok.status, 200);
  const data = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  assert.equal(data.json.settings.geminiVisionModel, "gemini-3.8-flash");
});

test("штрих-код: гость не может, мусор — 400", async () => {
  const guest = await request(ctx.base, "POST", "/api/cabinet/ai/barcode", { body: { code: "4680036912629" } });
  assert.equal(guest.status, 401);
  for (const code of ["привет", "4680036912620"]) {
    const bad = await request(ctx.base, "POST", "/api/cabinet/ai/barcode", { cookie: userCookie, body: { code } });
    assert.equal(bad.status, 400);
  }
});

test("штрих-код сохраняется у банки и повторный скан находит её без сети", async () => {
  const created = await request(ctx.base, "POST", "/api/cabinet/drinks", {
    cookie: userCookie,
    body: { brand: "Gorilla", name: "Gorilla Energy", flavor: "классика", tier: "B", review: "", barcode: "4680036912629" },
  });
  assert.equal(created.status, 201);
  const row = ctx.db.prepare("SELECT barcode FROM drinks WHERE slug = ?").get(created.json.drink.slug);
  assert.equal(row.barcode, "4680036912629");

  const found = await request(ctx.base, "POST", "/api/cabinet/ai/barcode", {
    cookie: userCookie,
    body: { code: "4680036912629" },
  });
  assert.equal(found.status, 200);
  assert.equal(found.json.inIndex.slug, created.json.drink.slug);
  assert.equal(found.json.product.source, "index");
  assert.equal(found.json.similar[0].slug, created.json.drink.slug);
  assert.match(found.json.similar[0].reason, /штрих-код/);

  const badBarcode = await request(ctx.base, "POST", "/api/cabinet/drinks", {
    cookie: userCookie,
    body: { brand: "X", name: "X", flavor: "y", tier: "B", barcode: "4680036912620" },
  });
  assert.equal(badBarcode.status, 400);
});

test("настройки ИИ: прокси — пароль скрыт, маска не затирает, журнал без секрета", async () => {
  const bad = await request(ctx.base, "PUT", "/api/admin/settings", {
    cookie: adminCookie,
    body: { aiProxyUrl: "ftp://x:21" },
  });
  assert.equal(bad.status, 400);

  const set = await request(ctx.base, "PUT", "/api/admin/settings", {
    cookie: adminCookie,
    body: { aiProxyUrl: "http://nrg:pr0xy-pass@10.0.0.5:3128" },
  });
  assert.equal(set.status, 200);
  let data = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  assert.equal(data.json.settings.aiProxyUrl, "http://nrg:***@10.0.0.5:3128");
  assert.equal(JSON.stringify(data.json).includes("pr0xy-pass"), false);

  // форма шлёт обратно замаскированный адрес — сохранённый пароль не должен пропасть
  const again = await request(ctx.base, "PUT", "/api/admin/settings", {
    cookie: adminCookie,
    body: { aiProxyUrl: data.json.settings.aiProxyUrl },
  });
  assert.equal(again.status, 200);
  assert.deepEqual(again.json.changed, []);

  const off = await request(ctx.base, "PUT", "/api/admin/settings", {
    cookie: adminCookie,
    body: { aiProxyUrl: "" },
  });
  assert.deepEqual(off.json.changed, ["ai_proxy_url"]);
  data = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  assert.equal(data.json.settings.aiProxyUrl, "");
  const entries = data.json.audit.filter((row) => row.action === "admin.settings.update");
  assert.ok(entries.some((row) => /Прокси для ИИ: (задан|убран)/.test(row.details)));
  assert.equal(entries.some((row) => row.details.includes("10.0.0.5")), false);
});

test("транскрибация: валидация входа", async () => {
  const anon = await request(ctx.base, "POST", "/api/cabinet/ai/transcribe", {
    body: { audio: "AAAA", mimeType: "audio/webm" },
  });
  assert.equal(anon.status, 401);
  const badType = await request(ctx.base, "POST", "/api/cabinet/ai/transcribe", {
    cookie: userCookie,
    body: { audio: Buffer.alloc(400).toString("base64"), mimeType: "text/html" },
  });
  assert.equal(badType.status, 400);
});

test("разбор отметки существующей банки: имя обязательно и тир с отзывом приходят от ИИ", async () => {
  const noName = await request(ctx.base, "POST", "/api/cabinet/ai/parse", {
    cookie: userCookie,
    body: { text: "норм", drink: { name: "" } },
  });
  assert.equal(noName.status, 400);

  // Локальный мок ИИ-провайдера: тест не ходит в сеть и видит, что именно уходит модели.
  const http = require("node:http");
  let providerBody = "";
  const provider = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      providerBody = body;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tier: "C", review: "Приторно, но пить можно" }) } }] }),
      );
    });
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = provider.address().port;
  const putSetting = (key, value) =>
    ctx.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  putSetting("parse_api_key", "test-key");
  putSetting("parse_base_url", `http://127.0.0.1:${providerPort}/v1`);
  putSetting("ai_proxy_url", "");

  try {
    const res = await request(ctx.base, "POST", "/api/cabinet/ai/parse", {
      cookie: userCookie,
      body: { text: "приторно, но пить можно", drink: { brand: "Burn", name: "Tropic", flavor: "манго" } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.parsed, { tier: "C", tierGuessed: false, review: "Приторно, но пить можно" });
    assert.deepEqual(res.json.similar, []);
    assert.match(providerBody, /Burn Tropic/);
    assert.match(providerBody, /приторно, но пить можно/);
  } finally {
    await new Promise((resolve) => provider.close(resolve));
  }
});

test("разбор с фото и черновиком из QR: модель видит картинку, поля не теряются", async () => {
  const http = require("node:http");
  let providerBody = "";
  const provider = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      providerBody = body;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ brand: "", name: "", flavor: "манго", edition: "", review: "огонь", tier: "A" }) } }],
        }),
      );
    });
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const putSetting = (key, value) =>
    ctx.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  putSetting("parse_api_key", "test-key");
  putSetting("parse_base_url", `http://127.0.0.1:${provider.address().port}/v1`);
  putSetting("ai_proxy_url", "");

  try {
    const res = await request(ctx.base, "POST", "/api/cabinet/ai/parse", {
      cookie: userCookie,
      body: {
        text: "вкус огонь, тир А",
        draft: { brand: "Burn", name: "Burn Original", flavor: "энергетический напиток Берн", edition: "" },
        imageDataUrl: testImageDataUrl,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.parsed.brand, "Burn");
    assert.equal(res.json.parsed.name, "Burn Original");
    assert.equal(res.json.parsed.flavor, "манго");
    assert.equal(res.json.parsed.tier, "A");
    assert.match(providerBody, /image_url/);
    assert.match(providerBody, /Burn Original/);
  } finally {
    await new Promise((resolve) => provider.close(resolve));
  }
});

test("логи: запросы к ИИ и серверные ошибки видны в админке, но не засоряют журнал действий", async () => {
  const http = require("node:http");
  let fail = false;
  const provider = http.createServer((req, res) => {
    res.writeHead(fail ? 500 : 200, { "content-type": "application/json" });
    res.end(
      fail
        ? JSON.stringify({ error: { message: "провайдер сломался" } })
        : JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ tier: "B", review: "Норм" }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001 },
          }),
    );
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const putSetting = (key, value) =>
    ctx.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  putSetting("parse_api_key", "test-key");
  putSetting("parse_base_url", `http://127.0.0.1:${provider.address().port}/v1`);
  putSetting("ai_proxy_url", "");

  try {
    const ok = await request(ctx.base, "POST", "/api/cabinet/ai/parse", {
      cookie: userCookie,
      body: { text: "приторно, но пить можно", drink: { brand: "Burn", name: "Tropic" } },
    });
    assert.equal(ok.status, 200);
    fail = true;
    const bad = await request(ctx.base, "POST", "/api/cabinet/ai/parse", {
      cookie: userCookie,
      body: { text: "приторно, но пить можно", drink: { brand: "Burn", name: "Tropic" } },
    });
    assert.equal(bad.status, 502);
  } finally {
    await new Promise((resolve) => provider.close(resolve));
  }

  const data = await request(ctx.base, "GET", "/api/admin/data", { cookie: adminCookie });
  const aiRow = data.json.logs.find((row) => row.entity === "ai" && row.action === "ai.parse");
  assert.ok(aiRow, "запрос к ИИ должен попасть в логи");
  assert.match(aiRow.summary, /Разбор текста/);
  assert.match(aiRow.details, /openai\/gpt-4o-mini/);
  assert.match(aiRow.details, /Токены: 15/);
  assert.match(aiRow.details, /Время: \d/);

  const errorRow = data.json.logs.find((row) => row.entity === "error");
  assert.ok(errorRow, "ошибка сервера должна попасть в логи");
  assert.match(errorRow.summary, /^Ошибка 502/);
  assert.match(errorRow.details, /POST \/api\/cabinet\/ai\/parse/);

  assert.equal(
    data.json.audit.some((row) => row.entity === "ai" || row.entity === "error"),
    false,
    "машинные логи не должны вытеснять журнал действий",
  );
});

test("CSP разрешает blob: для аудио", async () => {
  const res = await fetch(`${ctx.base}/cabinet.html`);
  assert.match(res.headers.get("content-security-policy"), /media-src 'self' blob:/);
});

test("несуществующий файл в /uploads отдаёт 404", async () => {
  const res = await fetch(`${ctx.base}/uploads/nope.png`);
  assert.equal(res.status, 404);
});

test("вход со второго устройства не выкидывает из первого", async () => {
  const first = await login(ctx.base, "editor", "editor-pass-123");
  const second = await login(ctx.base, "editor", "editor-pass-123");
  const oldMe = await request(ctx.base, "GET", "/api/auth/me", { cookie: first.cookie });
  assert.equal(oldMe.json.user.username, "editor");
  const newMe = await request(ctx.base, "GET", "/api/auth/me", { cookie: second.cookie });
  assert.equal(newMe.json.user.username, "editor");
  editorCookie = second.cookie;
});

test("сессия и кука продлеваются активностью, но не дёргаются на каждый запрос", async () => {
  await createUser(ctx.db, { username: "slide-user", password: "slide-pass-123" });
  const { cookie } = await login(ctx.base, "slide-user", "slide-pass-123");
  // Эмулируем возврат пользователя спустя двое суток простоя.
  ctx.db
    .prepare(
      "UPDATE sessions SET last_seen_at = datetime('now', '-2 days') WHERE user_id = (SELECT id FROM users WHERE username = 'slide-user')",
    )
    .run();

  const me = await request(ctx.base, "GET", "/api/auth/me", { cookie });
  assert.equal(me.json.user.username, "slide-user");

  const row = ctx.db
    .prepare("SELECT expires_at FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'slide-user')")
    .get();
  const leftDays = (Date.parse(row.expires_at.replace(" ", "T") + "Z") - Date.now()) / 86400000;
  assert.ok(leftDays > 0.9, `срок должен продлиться почти до TTL, осталось ${leftDays}`);

  const cookies = (me.setCookie || []).join("; ");
  assert.match(cookies, /nrg_session=/);
  assert.match(cookies, /Max-Age=\d+/i);

  // Сразу следующий запрос куку не переставляет — Set-Cookie не сыпется на каждый чих.
  const again = await request(ctx.base, "GET", "/api/auth/me", { cookie });
  assert.equal(again.json.user.username, "slide-user");
  const repeated = (again.setCookie || []).filter((c) => c.startsWith("nrg_session="));
  assert.equal(repeated.length, 0);
});

test("смена пароля сбрасывает сессии со всех устройств", async () => {
  await createUser(ctx.db, { username: "pass-user", password: "pass-user-123" });
  const first = await login(ctx.base, "pass-user", "pass-user-123");
  const second = await login(ctx.base, "pass-user", "pass-user-123");

  const change = await request(ctx.base, "POST", "/api/auth/password", {
    cookie: first.cookie,
    body: { currentPassword: "pass-user-123", newPassword: "pass-user-456" },
  });
  assert.equal(change.status, 200);

  for (const cookie of [first.cookie, second.cookie]) {
    const me = await request(ctx.base, "GET", "/api/auth/me", { cookie });
    assert.equal(me.json.user, null);
  }
});

test("API-ответы помечены no-store, страницы — нет", async () => {
  const api = await fetch(`${ctx.base}/api/auth/me`);
  assert.equal(api.headers.get("cache-control"), "no-store");
  const page = await fetch(`${ctx.base}/`);
  assert.notEqual(page.headers.get("cache-control"), "no-store");
});

test("спуф X-Forwarded-For не обходит лимит логина", async () => {
  for (let i = 0; i < 5; i++) {
    await request(ctx.base, "POST", "/api/auth/login", {
      body: { username: "xff-target", password: "bad" },
      headers: { "x-forwarded-for": "9.9.9.9" },
    });
  }
  const blocked = await request(ctx.base, "POST", "/api/auth/login", {
    body: { username: "xff-target", password: "bad" },
    headers: { "x-forwarded-for": "8.8.8.8" },
  });
  assert.equal(blocked.status, 429);
});

test("сессия истекает после длительного простоя", async () => {
  await createUser(ctx.db, { username: "idle-user", password: "idle-pass-123" });
  const { cookie } = await login(ctx.base, "idle-user", "idle-pass-123");
  ctx.db.prepare("UPDATE sessions SET last_seen_at = datetime('now', '-40 days')").run();
  const me = await request(ctx.base, "GET", "/api/auth/me", { cookie });
  assert.equal(me.json.user, null);
});

test("CSP разрешает blob: для картинок и медиа (превью фото и голос)", async () => {
  const res = await fetch(`${ctx.base}/`);
  const csp = res.headers.get("content-security-policy") || "";
  const part = (name) => csp.split(";").find((piece) => piece.trim().startsWith(name)) || "";
  assert.ok(part("img-src").includes("blob:"), `img-src должен разрешать blob: (${part("img-src")})`);
  assert.ok(part("media-src").includes("blob:"), `media-src должен разрешать blob: (${part("media-src")})`);
});

test("шрифты отдаются локально и кешируются надолго", async () => {
  const page = await fetch(`${ctx.base}/`);
  const html = await page.text();
  assert.ok(html.includes("fonts/fonts.css"), "страница должна подключать локальные шрифты");
  assert.ok(!html.includes("fonts.googleapis.com"), "внешние Google Fonts больше не нужны");

  const css = await fetch(`${ctx.base}/fonts/fonts.css`);
  assert.equal(css.status, 200);
  assert.ok((await css.text()).includes("@font-face"));

  const font = await fetch(`${ctx.base}/fonts/xn7gYHE41ni1AdIRggexSg.woff2`);
  assert.equal(font.status, 200);
  assert.ok((font.headers.get("cache-control") || "").includes("immutable"));
});

test("текстовые ответы сжимаются gzip", async () => {
  const res = await fetch(`${ctx.base}/styles.css`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "gzip");
});
