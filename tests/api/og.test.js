const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const sharp = require("sharp");
const { startServer } = require("../helpers");

let ctx;

before(async () => {
  ctx = await startServer();
  ctx.db
    .prepare(
      `INSERT INTO drinks (slug, brand, name, flavor, edition, image_path, accent_a, accent_b, is_published)
       VALUES ('test-og-drink', 'TestBrand', 'Test Can', 'юдзу', '', 'assets/adrenaline-mango.png', '#ff4f79', '#ff7448', 1)`,
    )
    .run();
});

after(async () => {
  await ctx.close();
});

async function pngMeta(res) {
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /image\/png/);
  const buf = Buffer.from(await res.arrayBuffer());
  return sharp(buf).metadata();
}

// fetch() в Node не даёт выставить If-None-Match — проверяем сырым http.
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

test("главная отдаёт OG/Twitter-теги и canonical", async () => {
  const res = await fetch(`${ctx.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
  const html = await res.text();
  assert.match(html, /<meta property="og:title"/);
  assert.match(html, /<meta property="og:image" content="http[^"]*\/og\/site\.png"/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<link rel="canonical"/);
});

test("карточка сайта 1200x630", async () => {
  const meta = await pngMeta(await fetch(`${ctx.base}/og/site.png`));
  assert.equal(meta.width, 1200);
  assert.equal(meta.height, 630);
});

test("OG: кэш-заголовки и 304 без повторной отдачи", async () => {
  const first = await fetch(`${ctx.base}/og/site.png`);
  assert.equal(first.status, 200);
  assert.match(first.headers.get("cache-control") || "", /public, max-age=600/);
  const etag = first.headers.get("etag");
  assert.ok(etag, "нужен ETag");
  assert.ok(first.headers.get("last-modified"), "нужен Last-Modified");
  await first.arrayBuffer();
  const second = await conditional(`${ctx.base}/og/site.png`, etag);
  assert.equal(second.status, 304);
  assert.equal(second.size, 0);
});

test("страница банки /d/:slug с OG на свою карточку", async () => {
  const res = await fetch(`${ctx.base}/d/test-og-drink`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Test Can/);
  assert.match(html, /\/og\/drink\/test-og-drink\.png/);
  assert.match(html, /<link rel="canonical" href="http[^"]*\/d\/test-og-drink">/);
});

test("карточка банки 1200x630", async () => {
  const meta = await pngMeta(await fetch(`${ctx.base}/og/drink/test-og-drink.png`));
  assert.equal(meta.width, 1200);
  assert.equal(meta.height, 630);
});

test("неизвестная банка: 404, но с базовыми OG-тегами", async () => {
  const res = await fetch(`${ctx.base}/d/no-such-drink`);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /<meta property="og:title"/);
});

test("неизвестная OG-картинка: 404", async () => {
  const res = await fetch(`${ctx.base}/og/drink/no-such-drink.png`);
  assert.equal(res.status, 404);
});
