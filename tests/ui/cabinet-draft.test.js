const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("черновик добавления сохраняется в localStorage по пользователю", () => {
  const js = read("public/cabinet.js");
  assert.match(js, /localStorage\.setItem/);
  assert.match(js, /localStorage\.removeItem/);
  assert.match(js, /DRAFT_STORAGE_KEY/);
  assert.match(js, /state\.me\?\.username/);
  assert.match(js, /const draftPayload = \(\) =>/);
  assert.match(js, /image: pending\.image/);
  assert.match(js, /original: pending\.original/);
  assert.match(js, /const saveDraft = \(\) =>/);
  assert.match(js, /const scheduleDraftSave = \(\) =>/);
});

test("черновик пишется при вводе и на закрытии страницы", () => {
  const js = read("public/cabinet.js");
  assert.match(js, /scheduleDraftSave\(\)/);
  assert.match(js, /beforeunload/);
  assert.match(js, /pagehide/);
  assert.match(js, /visibilitychange/);
});

test("при входе черновик восстанавливается, дубли перепроверяются", () => {
  const js = read("public/cabinet.js");
  assert.match(js, /const restoreDraft = \(\) =>/);
  assert.match(js, /await refreshAll\(\);\s*\n\s*restoreDraft\(\)/);
  assert.match(js, /pending\.similarCount = 0/);
  assert.match(js, /showDupAck\(\)/);
  assert.match(js, /Черновик восстановлен/);
});

test("после сохранения банки черновик стирается", () => {
  const js = read("public/cabinet.js");
  const reset = js.slice(js.indexOf("const resetSmart = () => {"));
  const body = reset.slice(0, reset.indexOf("\n  };"));
  assert.match(body, /clearDraft\(\)/);
});

test("кнопка отмены удаляет черновик после подтверждения", () => {
  const html = read("public/cabinet.html");
  const js = read("public/cabinet.js");
  assert.match(html, /id="btn-draft-cancel"/);
  assert.match(html, /Отменить/);
  assert.match(js, /const cancelDraft = async \(\) =>/);
  assert.match(js, /btn-draft-cancel"\)\.onclick/);
  assert.match(js, /window\.nrgConfirm\(\{/);
  assert.match(js, /Черновик удалён/);
});
