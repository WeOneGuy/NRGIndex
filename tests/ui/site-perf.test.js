// Оптимизации общения с сервером и базой: параллельные запросы, троттлинг
// продления сессии, keep-alive под прокси. Всё — исходниковые проверки, без сети.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("главная: роль и тирлист грузятся параллельно", () => {
  const app = read("public/app.js");
  assert.match(app, /Promise\.allSettled\(\[/);
  assert.match(app, /fetch\("api\/auth\/me"/);
  assert.match(app, /fetch\("api\/public\/summary"/);
});

test("профиль: карточка участника грузится параллельно со списком", () => {
  const profile = read("public/profile.js");
  assert.match(profile, /const profileRequest = username/);
  assert.match(profile, /await profileRequest/);
});

test("сессии: продление не чаще раза в 5 минут", () => {
  const auth = read("server/auth.js");
  assert.match(auth, /const touchIntervalMs = 5 \* 60 \* 1000/);
  assert.match(auth, /Date\.now\(\) - seenAt > touchIntervalMs/);
});

test("сервер: keep-alive под обратным прокси и optimize при остановке", () => {
  const index = read("server/index.js");
  assert.match(index, /server\.keepAliveTimeout = 65_000/);
  assert.match(index, /server\.headersTimeout = 70_000/);
  assert.match(index, /db\.pragma\("optimize"\)/);
});
