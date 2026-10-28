// Прокси фото: если внешний сайт принимает соединение и молчит, пользователь
// должен получить 504 с понятным кодом, а не внутреннюю ошибку 500.
// Таймаут уменьшен до 150 мс, чтобы тест не ждал настоящие 10 секунд.
process.env.PHOTO_PROXY_TIMEOUT_MS = "150";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { startServer, createUser, login } = require("../helpers");

let ctx;
let cookie;
let silentServer;
let silentBase;
const sockets = new Set();

before(async () => {
  ctx = await startServer();
  await createUser(ctx.db, { username: "photo-user", password: "photo-pass-123" });
  const session = await login(ctx.base, "photo-user", "photo-pass-123");
  assert.equal(session.res.status, 200, "логин должен пройти");
  cookie = session.cookie;
  assert.ok(cookie, "нужна сессионная кука");

  // TCP-сервер принимает соединение и не отвечает ни байтом — так ведут себя
  // «висящие» CDN, из-за которых photo-proxy раньше отдавал 500 через 15 с.
  silentServer = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise((resolve) => silentServer.listen(0, "127.0.0.1", resolve));
  silentBase = `http://127.0.0.1:${silentServer.address().port}`;
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await new Promise((resolve) => silentServer.close(resolve));
  await ctx.close();
});

test("photo-proxy: молчащий источник — 504 photo_timeout, не 500", async () => {
  const target = `${silentBase}/slow.jpg`;
  const url = `${ctx.base}/api/cabinet/ai/photo-proxy?url=${encodeURIComponent(target)}`;
  const res = await fetch(url, { headers: { cookie } });

  assert.equal(res.status, 504);
  const body = await res.json();
  assert.equal(body.code, "photo_timeout");
  assert.match(body.error, /Источник фото не ответил/);
  assert.match(body.requestId, /^[0-9a-f]{12}$/);
});
