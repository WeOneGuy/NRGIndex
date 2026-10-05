// Поведенческие тесты доски: поиск, фильтр тиров, диплинк /d/:slug.
// public/app.js исполняется в vm с минимальными DOM-заглушками.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP = fs.readFileSync(path.join(__dirname, "..", "..", "public", "app.js"), "utf8");
const ROULETTE = fs.readFileSync(path.join(__dirname, "..", "..", "public", "roulette.js"), "utf8");

function makeSummary() {
  return {
    site: { title: "NRG / INDEX", description: "тест" },
    updatedAt: "01.01.2026",
    tiers: [
      { id: "S", title: "Supreme", note: "", score: 5 },
      { id: "A", title: "Excellent", note: "", score: 4 },
      { id: "B", title: "Good", note: "", score: 3 },
    ],
    participants: [{ id: "sanya", name: "Саня", initials: "СЯ", role: "", color: "#ff0000" }],
    drinks: [
      {
        id: "burn-original",
        brand: "Burn",
        name: "Burn Original",
        flavor: "оригинал",
        edition: "",
        image: "assets/burn-original.png",
        accent: ["#ff4f79", "#ff7448"],
        ratings: { sanya: { tier: "S", review: "" } },
        related: [],
      },
      {
        id: "volt-mango",
        brand: "Volt",
        name: "Volt Mango",
        flavor: "манго-лайм",
        edition: "",
        image: "assets/volt-mango-lime.png",
        accent: ["#ff4f79", "#ff7448"],
        ratings: { sanya: { tier: "A", review: "" } },
        related: [],
      },
    ],
  };
}

function element() {
  return {
    innerHTML: "",
    textContent: "",
    dataset: {},
    value: "",
    classList: { add() {}, remove() {}, toggle() {} },
    style: { setProperty() {} },
    addEventListener() {},
    insertAdjacentHTML() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    scrollIntoView() {},
    showModal() {},
    close() {},
    getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0 }),
    open: false,
    animate() {},
  };
}

async function runApp({ summary, pathname = "/", search = "" }) {
  const handlers = {};
  const byId = {
    "board-search": element(),
    "board-filters": element(),
    "hero-specimen": element(),
    "specimen-image": element(),
    "specimen-stamp": element(),
    "specimen-caption": element(),
  };
  byId["board-search"].addEventListener = (type, fn) => {
    handlers[type] = fn;
  };
  byId["board-filters"].addEventListener = (type, fn) => {
    handlers[`filters:${type}`] = fn;
  };
  const board = element();
  const dialog = element();
  const dialogHandlers = {};
  dialog.addEventListener = (type, fn) => {
    dialogHandlers[type] = fn;
  };
  const dialogContent = element();
  let modalOpened = false;
  dialog.showModal = () => {
    modalOpened = true;
  };
  const urls = [];
  const rootProps = {};
  const rootClasses = new Set();
  const sandbox = {
    document: {
      documentElement: {
        style: { setProperty: (key, value) => (rootProps[key] = value) },
        classList: {
          add: (name) => rootClasses.add(name),
          remove: (name) => rootClasses.delete(name),
          toggle: (name, on) => (on ? rootClasses.add(name) : rootClasses.delete(name)),
        },
      },
      querySelector: (sel) => {
        if (sel === "#tier-board") return board;
        if (sel === "#drink-dialog") return dialog;
        if (sel === "#dialog-content") return dialogContent;
        if (sel === ".cursor-aura") return null;
        if (sel === ".brand__name") return null;
        if (sel === ".marquee__track") return null;
        if (sel === 'meta[name="description"]') return null;
        return element();
      },
      querySelectorAll: (sel) => {
        if (sel === "[data-tier-filter]") return [];
        return [];
      },
      getElementById: (id) => byId[id] || null,
      addEventListener: () => {},
      body: { classList: { add() {}, remove() {} } },
    },
    window: {
      clearTimeout: clearTimeout,
      setTimeout: setTimeout,
      addEventListener: () => {},
      matchMedia: () => ({ matches: true }),
    },
    location: { pathname, search, hash: "", origin: "http://localhost" },
    history: { replaceState: (_, __, url) => urls.push(url) },
    navigator: {},
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
    },
    URLSearchParams,
    encodeURIComponent,
    fetch: async () => ({ ok: true, json: async () => summary }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // как на странице: барабан рулетки подключается до app.js
  vm.runInContext(ROULETTE, sandbox, { filename: "roulette.js" });
  vm.runInContext(APP, sandbox, { filename: "app.js" });
  // ждём fetch + debounce renderBoard (170мс)
  await new Promise((resolve) => setTimeout(resolve, 400));
  return {
    board,
    handlers,
    urls,
    modalOpened,
    dialogHandlers,
    location: sandbox.location,
    rootProps,
    rootClasses,
    searchEl: byId["board-search"],
    dialogContent,
    specimen: {
      card: byId["hero-specimen"],
      image: byId["specimen-image"],
      stamp: byId["specimen-stamp"],
      caption: byId["specimen-caption"],
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("поиск оставляет только подходящие банки", async () => {
  const { board, handlers, searchEl } = await runApp({ summary: makeSummary() });
  assert.match(board.innerHTML, /Burn Original/);
  assert.match(board.innerHTML, /Volt Mango/);

  searchEl.value = "манго";
  handlers.input();
  await sleep(300);
  assert.doesNotMatch(board.innerHTML, /Burn Original/);
  assert.match(board.innerHTML, /Volt Mango/);

  searchEl.value = "";
  handlers.input();
  await sleep(300);
  assert.match(board.innerHTML, /Burn Original/);
  assert.match(board.innerHTML, /Volt Mango/);
});

test("фильтр тира показывает только свой тир", async () => {
  const { board, handlers } = await runApp({ summary: makeSummary() });
  const chip = element();
  chip.dataset.tierFilter = "S";
  handlers["filters:click"]({ target: { closest: () => chip } });
  await sleep(300);
  assert.match(board.innerHTML, /Burn Original/);
  assert.doesNotMatch(board.innerHTML, /Volt Mango/);
  assert.match(board.innerHTML, /ничего не найдено|пока пусто/);
});

test("диплинк /d/:slug открывает диалог", async () => {
  const { modalOpened, urls } = await runApp({ summary: makeSummary(), pathname: "/d/volt-mango" });
  assert.equal(modalOpened, true);
  assert.ok(urls[urls.length - 1].endsWith("/d/volt-mango"));
});

test("диплинк из профиля: закрытие карточки возвращает в профиль, а не на главную", async () => {
  const { dialogHandlers, location: loc, modalOpened } = await runApp({
    summary: makeSummary(),
    pathname: "/d/burn-original",
    search: "?from=profile&u=sanya",
  });
  assert.equal(modalOpened, true);
  assert.equal(typeof dialogHandlers.close, "function", "закрытие диалога должно быть перехвачено");
  dialogHandlers.close();
  assert.equal(loc.href, "/profile.html?u=sanya", "крестик возвращает на профиль автора");
});

test("диплинк без метки профиля: закрытие чистит URL на главную", async () => {
  const { dialogHandlers, location: loc, urls } = await runApp({ summary: makeSummary(), pathname: "/d/volt-mango" });
  dialogHandlers.close();
  assert.ok(urls[urls.length - 1] === "/", "обычный диплинк закрывается на /");
  assert.equal(loc.href, undefined);
});

test("карточка: не пробовавшие — внизу, под оценившими", async () => {
  const summary = makeSummary();
  summary.participants = [
    { id: "kira", name: "Кира", initials: "КИ", role: "", color: "#00ff00" },
    { id: "sanya", name: "Саня", initials: "СЯ", role: "", color: "#ff0000" },
  ];
  const { dialogContent } = await runApp({ summary, pathname: "/d/burn-original" });
  const html = dialogContent.innerHTML;
  const rated = html.indexOf("Саня");
  const subhead = html.indexOf("Ещё не пробовали · 1");
  const untried = html.indexOf("Кира");
  assert.ok(rated !== -1 && subhead !== -1 && untried !== -1, "все части должны быть в карточке");
  assert.ok(rated < subhead, "оценивший идёт до заголовка группы");
  assert.ok(subhead < untried, "не пробовавшая идёт после заголовка");
  assert.match(html, /review-row is-untried/);
});

test("карточка: если оценили все, заголовка «ещё не пробовали» нет", async () => {
  const summary = makeSummary();
  summary.drinks[0].ratings.kira = { tier: "B", review: "норм" };
  summary.participants = [
    { id: "kira", name: "Кира", initials: "КИ", role: "", color: "#00ff00" },
    { id: "sanya", name: "Саня", initials: "СЯ", role: "", color: "#ff0000" },
  ];
  const { dialogContent } = await runApp({ summary, pathname: "/d/burn-original" });
  assert.doesNotMatch(dialogContent.innerHTML, /Ещё не пробовали/);
});

test("витрина: показывает S-тир из общего стола, а не первую банку списка", async () => {
  const { specimen } = await runApp({ summary: makeSummary() });
  assert.equal(specimen.stamp.textContent, "S");
  assert.match(specimen.caption.innerHTML, /BURN ORIGINAL/);
  assert.equal(specimen.image.src, "assets/burn-original.png");
});

test("витрина: S-тир на втором месте вытесняет первую банку списка", async () => {
  const summary = makeSummary();
  summary.drinks[0].ratings = { sanya: { tier: "B", review: "" } };
  summary.drinks[1].ratings = { sanya: { tier: "S", review: "" } };
  const { specimen } = await runApp({ summary });
  assert.equal(specimen.stamp.textContent, "S");
  assert.match(specimen.caption.innerHTML, /VOLT MANGO/);
});

test("витрина: без S-тира ничего не выдумывает", async () => {
  const summary = makeSummary();
  summary.drinks[0].ratings = { sanya: { tier: "A", review: "" } };
  summary.drinks[1].ratings = { sanya: { tier: "B", review: "" } };
  const { specimen } = await runApp({ summary });
  assert.match(specimen.caption.innerHTML, /ПОКА НЕТ S/);
});

test("витрина: аура курсора и «разложенная» берут цвета у банки на витрине", async () => {
  const summary = makeSummary();
  summary.drinks[0].accent = ["#12ab34", "#56cd78"];
  const { rootProps, specimen } = await runApp({ summary });
  assert.match(specimen.caption.innerHTML, /BURN ORIGINAL/);
  assert.equal(rootProps["--can-a"], "#12ab34", "цвет A должен уходить на страницу");
  assert.equal(rootProps["--can-b"], "#56cd78", "цвет B должен уходить на страницу");

  // Без S-тира возвращаем базовые цвета.
  const empty = makeSummary();
  empty.drinks[0].ratings = { sanya: { tier: "A", review: "" } };
  empty.drinks[1].ratings = { sanya: { tier: "B", review: "" } };
  const { rootProps: emptyProps } = await runApp({ summary: empty });
  assert.equal(emptyProps["--can-a"], "#ff4f79");
  assert.equal(emptyProps["--can-b"], "#ff7448");
});

test("витрина: после раскраски включается html.can-ready — аура появляется уже в цвете", async () => {
  const { rootClasses } = await runApp({ summary: makeSummary() });
  assert.ok(rootClasses.has("can-ready"), "после раскраски витрины ставим html.can-ready");
});
