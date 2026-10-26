// Публичные служебные эндпоинты и кэш ответов: healthz, версия, ETag/304.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startServer } = require("../helpers");

let ctx;

// fetch() в Node (undici) выкидывает If-None-Match как forbidden request header,
// поэтому условный запрос делаем сырым http.request — как браузерный кэш.
function conditional(url, etag) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        headers: { "if-none-match": etag },
      },
      (res) => {
        let size = 0;
        res.on("data", (chunk) => (size += chunk.length));
        res.on("end", () => resolve({ status: res.statusCode, size }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  ctx = await startServer();
});

after(async () => {
  await ctx.close();
});

test("healthz: лёгкий ответ без БД и без кэша", async () => {
  const res = await fetch(`${ctx.base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("metrics: Prometheus-текст без кэша", async () => {
  const res = await fetch(`${ctx.base}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/plain/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const text = await res.text();
  assert.match(text, /nrgindex_up 1/);
  assert.match(text, /nrgindex_requests_total \d+/);
});

test("api/public/version: версия приложения", async () => {
  const res = await fetch(`${ctx.base}/api/public/version`);
  assert.equal(res.status, 200);
  assert.match((await res.json()).version, /^\d+\.\d+\.\d+$/);
});

test("публичный API: public, no-cache и 304 по ETag", async () => {
  const first = await fetch(`${ctx.base}/api/public/summary`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "public, no-cache");
  const etag = first.headers.get("etag");
  assert.ok(etag, "нужен ETag");
  await first.arrayBuffer();
  const second = await conditional(`${ctx.base}/api/public/summary`, etag);
  assert.equal(second.status, 304);
  assert.equal(second.size, 0);
});

test("приватный API остаётся no-store", async () => {
  const res = await fetch(`${ctx.base}/api/auth/me`);
  assert.equal(res.headers.get("cache-control"), "no-store");
});
