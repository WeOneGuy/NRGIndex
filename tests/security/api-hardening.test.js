// Динамические проверки защиты: заголовки, матрица доступа, CSRF, обход пути,
// инъекции, XSS-данные, IDOR, утечки хешей и cookie. Поднимает свой сервер.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, createUser, request, login } = require("../helpers");

let ctx;
let adminCookie;
let editorCookie;
let userCookie;
let otherCookie;

before(async () => {
  ctx = await startServer();
  await createUser(ctx.db, { username: "admin", password: "admin-pass-123", role: "admin", displayName: "Админ" });
  await createUser(ctx.db, { username: "editor", password: "editor-pass-123", role: "editor" });
  await createUser(ctx.db, { username: "sanya", password: "sanya-pass-123", role: "user" });
  await createUser(ctx.db, { username: "other", password: "other-pass-123", role: "user" });
  adminCookie = (await login(ctx.base, "admin", "admin-pass-123")).cookie;
  editorCookie = (await login(ctx.base, "editor", "editor-pass-123")).cookie;
  userCookie = (await login(ctx.base, "sanya", "sanya-pass-123")).cookie;
  otherCookie = (await login(ctx.base, "other", "other-pass-123")).cookie;
});

after(() => ctx.close());

test("security: заголовки безопасности на страницах и API", async () => {
  const page = await fetch(`${ctx.base}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-powered-by"), null, "сервер не должен светить x-powered-by");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  const csp = page.headers.get("content-security-policy") || "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/, "wasm-декодер в браузере требует wasm-unsafe-eval");
  assert.match(csp, /script-src-attr 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  const api = await fetch(`${ctx.base}/api/health`);
  assert.equal(api.headers.get("cache-control"), "no-store");
});

test("security: матрица доступа для API и админ-страниц", async () => {
  const cases = [
    ["GET", "/api/admin/data", null, 401],
    ["GET", "/api/admin/data", userCookie, 403],
    ["GET", "/api/admin/database", userCookie, 403],
    ["GET", "/api/cabinet/me", null, 401],
    ["POST", "/api/uploads", null, 401],
    ["POST", "/api/admin/drinks", userCookie, 403],
    ["PUT", "/api/admin/settings", editorCookie, 403],
    ["DELETE", "/api/admin/users/1", editorCookie, 403],
  ];
  for (const [method, url, cookie, expected] of cases) {
    const res = await request(ctx.base, method, url, { cookie, body: method === "GET" ? undefined : {} });
    assert.equal(res.status, expected, `${method} ${url} → ${res.status}, ждали ${expected}`);
  }
  for (const url of ["/admin", "/admin.js"]) {
    const anon = await fetch(`${ctx.base}${url}`, { redirect: "manual" });
    assert.equal(anon.status, 302, `${url} для анонима`);
    const asUser = await fetch(`${ctx.base}${url}`, { headers: { cookie: userCookie }, redirect: "manual" });
    assert.equal(asUser.status, 302, `${url} для пользователя`);
  }
  const asAdmin = await fetch(`${ctx.base}/admin`, { headers: { cookie: adminCookie }, redirect: "manual" });
  assert.equal(asAdmin.status, 200, "админ должен открывать /admin");
});

test("security: мутации без CSRF-заголовка отклоняются", async () => {
  const mutations = [
    ["POST", "/api/auth/logout"],
    ["POST", "/api/cabinet/drinks"],
    ["PUT", "/api/cabinet/ratings/any"],
    ["POST", "/api/uploads"],
    ["PUT", "/api/admin/settings"],
    ["DELETE", "/api/admin/drinks/1"],
  ];
  for (const [method, url] of mutations) {
    const res = await request(ctx.base, method, url, { cookie: adminCookie, body: {}, csrf: false });
    assert.equal(res.status, 403, `${method} ${url} без заголовка → ${res.status}`);
  }
  const badOrigin = await request(ctx.base, "POST", "/api/auth/logout", {
    cookie: adminCookie,
    body: {},
    headers: { origin: "https://evil.example" },
  });
  assert.equal(badOrigin.status, 403, "чужой Origin должен отклоняться");
});

test("security: обход пути не работает", async () => {
  const targets = [
    "/uploads/..%2f..%2fpackage.json",
    "/uploads/%2e%2e/%2e%2e/etc/passwd",
    "/assets/..%2f..%2fserver%2fapp.js",
  ];
  for (const url of targets) {
    const res = await fetch(`${ctx.base}${url}`);
    assert.ok([403, 404].includes(res.status), `${url} → ${res.status}`);
  }
});

test("security: SQL-инъекции не проходят и не ломают API", async () => {
  for (const username of ["' OR 1=1 --", "'; DROP TABLE users; --", '" OR ""="']) {
    const res = await request(ctx.base, "POST", "/api/auth/login", {
      body: { username, password: "x" },
    });
    assert.ok([400, 401].includes(res.status), `${username} → ${res.status}`);
  }
  const slug = await request(ctx.base, "PUT", "/api/cabinet/ratings/x%27%20OR%201%3D1--", {
    cookie: userCookie,
    body: { tier: "S" },
  });
  assert.equal(slug.status, 404);
  const me = await request(ctx.base, "GET", "/api/auth/me", { cookie: adminCookie });
  assert.equal(me.json.user.username, "admin", "таблица users должна остаться рабочей");
});

test("security: вредоносные данные не попадают в HTML страниц", async () => {
  const payload = {
    brand: '<script>alert("brand")</script>',
    name: '<img src=x onerror="window.__xss=1">',
    flavor: '"><svg onload="window.__xss=2">',
    edition: "<iframe src=javascript:alert(3)>",
    review: "<body onload=window.__xss=4>",
  };
  const created = await request(ctx.base, "POST", "/api/admin/drinks", {
    cookie: adminCookie,
    body: payload,
  });
  assert.equal(created.status, 201);
  const summary = await (await fetch(`${ctx.base}/api/public/summary`)).text();
  assert.ok(summary.includes("onerror"), "API отдаёт данные как JSON (без исполнения)");
  const page = await (await fetch(`${ctx.base}/`)).text();
  for (const marker of ["__xss", "onerror=", "onload=", "<script>alert"]) {
    assert.ok(!page.includes(marker), `в HTML не должно быть ${marker}`);
  }
  await request(ctx.base, "DELETE", `/api/admin/drinks/${created.json.drink.id}`, {
    cookie: adminCookie,
  });
});

test("security: чужой напиток нельзя править или удалять", async () => {
  const mine = await request(ctx.base, "POST", "/api/cabinet/drinks", {
    cookie: userCookie,
    body: { brand: "IDOR", name: "IDOR Drink", flavor: "Тест", tier: "B" },
  });
  assert.equal(mine.status, 201);
  const slug = mine.json.drink.slug;
  const stolenDelete = await request(ctx.base, "DELETE", `/api/cabinet/drinks/${slug}`, {
    cookie: otherCookie,
  });
  assert.equal(stolenDelete.status, 404);
  const stolenPatch = await request(ctx.base, "PATCH", `/api/cabinet/drinks/${slug}`, {
    cookie: otherCookie,
    body: { brand: "Hack", name: "Hack", flavor: "x", tier: "S" },
  });
  assert.ok([403, 404].includes(stolenPatch.status));
  const own = await request(ctx.base, "DELETE", `/api/cabinet/drinks/${slug}`, {
    cookie: userCookie,
  });
  assert.equal(own.status, 200);
});

test("security: API не отдаёт хеши паролей и токены", async () => {
  const auth = await login(ctx.base, "admin", "admin-pass-123");
  const raw = JSON.stringify(auth.res.json);
  assert.ok(!raw.includes("scrypt$"), "хеш пароля не должен попадать в ответ");
  assert.ok(!raw.includes("password_hash"));
  const me = await request(ctx.base, "GET", "/api/auth/me", { cookie: adminCookie });
  assert.ok(!JSON.stringify(me.json).includes("scrypt$"));
});

test("security: cookie сессии помечена HttpOnly и SameSite", async () => {
  const auth = await login(ctx.base, "admin", "admin-pass-123");
  const cookies = (auth.res.setCookie || []).join("; ");
  assert.match(cookies, /HttpOnly/i);
  assert.match(cookies, /SameSite=Lax/i);
});

test("security: SVG и HTML в загрузках отклоняются", async () => {
  for (const dataUrl of [
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:text/html;base64,PGI+SGk8L2I+",
  ]) {
    const res = await request(ctx.base, "POST", "/api/uploads", {
      cookie: userCookie,
      body: { dataUrl },
    });
    assert.equal(res.status, 400, dataUrl);
  }
});
