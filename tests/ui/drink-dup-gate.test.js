const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("кабинет: блока проверки сверху и подтверждения «такого нет» больше нет", () => {
  const js = read("public/cabinet.js");
  const html = read("public/cabinet.html");
  assert.doesNotMatch(html, /dup-gate/, "гейт-контейнер удалён");
  assert.doesNotMatch(js, /dup-gate/, "из скрипта убраны ссылки на гейт");
  assert.doesNotMatch(html, /absence-ack/, "галочка «такого нет» удалена из разметки");
  assert.doesNotMatch(js, /absenceAck|showAbsenceAck|hideAbsenceAck/, "логика «такого нет» удалена");
  assert.doesNotMatch(html, /Такого энергоса нет в списке/, "текста подтверждения отсутствия нет");
  assert.doesNotMatch(html, /id="smart-form"[^>]*hidden/, "форма добавления не прячется");
  assert.match(html, /id="btn-camera"/, "кнопка камеры остаётся на месте");
  assert.match(html, /data-camera-mode="code"/, "режим скана штрих-кода остаётся");
});

test("предупреждение о совпадении живёт в карточке у кнопки «В индекс»", () => {
  const html = read("public/cabinet.html");
  const previewStart = html.indexOf('id="smart-preview"');
  assert.notEqual(previewStart, -1);
  const preview = html.slice(previewStart, html.indexOf("</form>", previewStart));
  for (const id of ["similar-box", "similar-ack", "similar-ack-wrap"]) {
    assert.ok(preview.includes(`id="${id}"`), `${id} должен быть в карточке превью`);
  }
  assert.ok(
    preview.indexOf('id="similar-box"') > preview.indexOf('id="btn-confirm"'),
    "предупреждение о совпадении — под кнопкой",
  );
  assert.match(html, /id="similar-box"[^>]*hidden/, "предупреждение скрыто по умолчанию");
  assert.match(html, /id="similar-ack-wrap"[^>]*hidden/, "галочка «это не он» скрыта по умолчанию");
});

test("гейт кнопки — только по найденным совпадениям", () => {
  const js = read("public/cabinet.js");
  assert.match(js, /pending\.similarCount = similar\.length/);
  assert.match(js, /pending\.duplicateAck = !similar\.length/);
  assert.match(js, /btn-confirm"\)\.disabled = pending\.similarCount > 0 && !pending\.duplicateAck/);
  assert.match(js, /similar-ack"\)\.addEventListener\("change"/);
  assert.match(js, /const syncConfirmState = \(\) =>/);
});

test("кабинет: подтверждение разных энергосов уходит на сервер, 409 показывает похожие", () => {
  const js = read("public/cabinet.js");
  assert.match(js, /body\.confirmDifferent = true/);
  assert.match(js, /error\.payload\?\.similar\?\.length/);
  assert.match(js, /renderSimilar\(error\.payload\.similar\)/);
});

test("сервер: защита от дублей включена до создания банки", () => {
  const server = read("server/routes/cabinet.js");
  assert.match(server, /confirmDifferent !== true/);
  assert.match(server, /штрих-код совпал/);
  assert.match(server, /includeHidden: true/);
  assert.match(server, /code: "duplicate"/);
});
