// Подтверждения сохранений: сам тост (поведение) и его подключение к действиям.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const TOAST = read("public/toast.js");
const CABINET = read("public/cabinet.js");
const ADMIN = read("admin/admin.js");
const CABINET_HTML = read("public/cabinet.html");
const ADMIN_HTML = read("admin/index.html");
const STYLES = read("public/styles.css");

function makeNode() {
  const children = [];
  const listeners = new Map();
  const node = {
    children,
    dataset: {},
    attributes: {},
    className: "",
    title: "",
    textContent: "",
    isConnected: true,
    offsetWidth: 0,
    classList: {
      add: (...names) => names.forEach((name) => node._classes.add(name)),
      remove: (...names) => names.forEach((name) => node._classes.delete(name)),
      contains: (name) => node._classes.has(name),
    },
    _classes: new Set(),
    setAttribute(name, value) {
      node.attributes[name] = value;
    },
    getAttribute(name) {
      return node.attributes[name];
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    dispatch(type) {
      listeners.get(type)?.({ target: node });
    },
    append(...items) {
      for (const item of items) {
        item.parent = node;
        children.push(item);
      }
    },
    remove() {
      const parent = node.parent;
      if (!parent) return;
      const index = parent.children.indexOf(node);
      if (index >= 0) parent.children.splice(index, 1);
      node.isConnected = false;
      node.parent = null;
    },
  };
  return node;
}

function createPage() {
  const body = makeNode();
  const document = {
    body,
    createElement: () => makeNode(),
  };
  const window = { setTimeout, clearTimeout };
  const context = vm.createContext({ window, document, console });
  vm.runInContext(TOAST, context);
  return { window, body };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("тост: контейнер с aria-live и текстом через textContent", () => {
  const page = createPage();
  const node = page.window.nrgToast("Отзыв сохранён");
  const stack = page.body.children[0];
  assert.equal(stack.getAttribute("role"), "status");
  assert.equal(stack.getAttribute("aria-live"), "polite");
  assert.equal(stack.children.length, 1);
  assert.equal(node.className, "nrg-toast nrg-toast--ok");
  assert.equal(node.children[1].textContent, "Отзыв сохранён");
  assert.doesNotMatch(TOAST, /innerHTML/, "тост не собирает HTML-строки");
});

test("тост: ошибка отличается цветом и знаком", () => {
  const page = createPage();
  const node = page.window.nrgToast.error("Не сохранилось");
  assert.equal(node.className, "nrg-toast nrg-toast--error");
  assert.equal(node.children[0].textContent, "!");
});

test("тост: одинаковое сообщение не дублируется", () => {
  const page = createPage();
  page.window.nrgToast("Отзыв сохранён");
  page.window.nrgToast("Отзыв сохранён");
  assert.equal(page.body.children[0].children.length, 1);
});

test("тост: на экране не больше трёх", () => {
  const page = createPage();
  for (const message of ["раз", "два", "три", "четыре"]) page.window.nrgToast(message);
  assert.equal(page.body.children[0].children.length, 3);
});

test("тост: исчезает сам и по клику", async () => {
  const page = createPage();
  page.window.nrgToast("сам", { duration: 20 });
  await sleep(300);
  assert.equal(page.body.children[0].children.length, 0);

  const node = page.window.nrgToast("клик");
  node.dispatch("click");
  assert.ok(node.classList.contains("is-leaving"));
  await sleep(300);
  assert.equal(page.body.children[0].children.length, 0);
});

test("кабинет: подтверждения висят на оценке, отзыве, банке, аватаре и пароле", () => {
  assert.match(CABINET, /toast\(String\(review\)\.trim\(\) \? "Отзыв сохранён" : "Отзыв убран"\)/);
  assert.match(CABINET, /отзыв: "Отзыв сохранён"/);
  assert.match(CABINET, /toast\(savedMessage\(changed\)\)/);
  assert.match(CABINET, /toast\("Оценка удалена"\)/);
  assert.match(CABINET, /toast\("Банка удалена из индекса"\)/);
  assert.match(CABINET, /toast\("Банка добавлена в индекс"\)/);
  assert.match(CABINET, /toast\("Аватар сохранён"\)/);
  assert.match(CABINET, /toast\("Пароль изменён"\)/);
  // Подсказка, что правка сохраняется сама, а не по кнопке.
  assert.match(CABINET_HTML, /Тир и отзыв сохраняются автоматически/);
});

test("админка: успешные сохранения дублируются тостом", () => {
  assert.match(ADMIN, /const status = \(id, message, isError = false, notify = false\)/);
  assert.match(ADMIN, /if \(notify && !isError\) window\.nrgToast\?\.\(message\.replace/);
  assert.match(ADMIN, /"Напиток сохранён ✓", false, true/);
  assert.match(ADMIN, /"Тир сохранён ✓", false, true/);
  assert.match(ADMIN, /"Настройки сохранены ✓", false, true/);
  assert.match(ADMIN, /Напиток скрыт с сайта/);
});

test("страницы подключают тост до своих скриптов", () => {
  const cabinetScript = CABINET_HTML.indexOf('<script src="toast.js"></script>');
  assert.notEqual(cabinetScript, -1);
  assert.ok(cabinetScript < CABINET_HTML.indexOf('<script src="cabinet.js"></script>'));
  const adminScript = ADMIN_HTML.indexOf('<script src="/toast.js"></script>');
  assert.notEqual(adminScript, -1);
  assert.ok(adminScript < ADMIN_HTML.indexOf('<script src="/admin.js"></script>'));
});

test("стили тоста общие для сайта и админки", () => {
  assert.match(STYLES, /\.nrg-toast-stack \{/);
  assert.match(STYLES, /\.nrg-toast--ok/);
  assert.match(STYLES, /\.nrg-toast--error/);
  assert.match(STYLES, /prefers-reduced-motion[^}]*\{[^}]*\.nrg-toast/);
});
