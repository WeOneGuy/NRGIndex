const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("кабинет: отдельного блока проверки сверху нет, форма и камера на месте", () => {
  const js = read("public/cabinet.js");
  const html = read("public/cabinet.html");
  assert.doesNotMatch(html, /dup-gate/, "гейт-контейнер удалён");
  assert.doesNotMatch(js, /dup-gate/, "из скрипта убраны ссылки на гейт");
  assert.doesNotMatch(js, /renderDupGateResults|DUP_GATE_PAGE/, "ручной поиск по индексу удалён");
  assert.doesNotMatch(html, /id="smart-form"[^>]*hidden/, "форма добавления не прячется");
  assert.match(html, /id="btn-camera"/, "кнопка камеры остаётся на месте");
  assert.match(html, /data-camera-mode="code"/, "режим скана штрих-кода остаётся");
});

test("предупреждение и подтверждение живут в карточке у кнопки «В индекс»", () => {
  const html = read("public/cabinet.html");
  const previewStart = html.indexOf('id="smart-preview"');
  assert.notEqual(previewStart, -1);
  const preview = html.slice(previewStart, html.indexOf("</form>", previewStart));
  for (const id of ["similar-box", "similar-ack", "absence-ack", "absence-ack-wrap"]) {
    assert.ok(preview.includes(`id="${id}"`), `${id} должен быть в карточке превью`);
  }
  const confirm = preview.indexOf('id="btn-confirm"');
  assert.ok(preview.indexOf('id="similar-box"') > confirm, "предупреждение о совпадении — под кнопкой");
  assert.ok(preview.indexOf('id="absence-ack-wrap"') > confirm, "галочка отсутствия — под кнопкой");
  assert.match(html, /id="similar-box"[^>]*hidden/, "предупреждение скрыто по умолчанию");
  assert.match(html, /id="similar-ack-wrap"[^>]*hidden/, "галочка «это не он» скрыта по умолчанию");
  assert.match(html, /id="absence-ack-wrap"[^>]*hidden/, "галочка отсутствия скрыта по умолчанию");
});

test("предупреждение — только при совпадении, подтверждение — только при отсутствии", () => {
  const js = read("public/cabinet.js");
  assert.match(js, /pending\.similarCount = similar\.length/);
  assert.match(js, /pending\.duplicateAck = !similar\.length/);
  assert.match(js, /if \(similar\.length\) hideAbsenceAck\(\)/);
  assert.match(js, /const showAbsenceAck = \(\) =>/);
  assert.match(js, /const hideAbsenceAck = \(\) =>/);
  assert.match(js, /if \(pending\.similarCount\) return;/);
});

test("галочка отсутствия появляется после неудачных автоматических проверок", () => {
  const js = read("public/cabinet.js");
  // ИИ-разбор не нашёл похожих
  assert.match(js, /if \(!\(similar \|\| \[\]\)\.length\) showAbsenceAck\(\)/);
  // штрих-код не нашёлся в индексе
  assert.match(js, /if \(!\(data\.similar \|\| \[\]\)\.length\) showAbsenceAck\(\)/);
  // попытка сохранить без проверки тоже показывает галочку
  assert.match(js, /!pending\.similarCount && !pending\.absenceAck/);
  // подтверждение обязательно для сохранения и сбрасывается после добавления
  assert.match(js, /pending\.absenceAck = event\.target\.checked/);
  assert.match(js, /const syncConfirmState = \(\) =>/);
  assert.match(js, /hideAbsenceAck\(\)/);
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
