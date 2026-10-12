const test = require("node:test");
const assert = require("node:assert/strict");
const { findSimilarDrinks, matchWords } = require("../../server/lib/content");

// Лёгкий фейковый db: findSimilarDrinks зовёт только prepare(...).all(includeHidden).
// Флаг приходит параметром (? = 1), а не склейкой SQL — повторяем это в моке.
const makeDb = (rows) => ({
  prepare: (sql) => ({
    all: (includeHidden = 0) =>
      sql.includes("? = 1") && includeHidden ? rows : rows.filter((item) => item.is_published),
  }),
});

const row = (id, slug, brand, name, flavor, extra = {}) => ({
  id,
  slug,
  brand,
  name,
  flavor,
  edition: "",
  image_path: null,
  is_published: 1,
  ...extra,
});

const DB = makeDb([
  row(1, "burn-apple-kiwi", "Burn", "Burn Apple Kiwi", "яблоко киви"),
  row(2, "monster-white", "Monster", "Monster Ultra White", "цитрус"),
  row(3, "volt-original", "Volt", "Volt Original", ""),
  row(4, "gorilla-mango", "Gorilla", "Gorilla Mango", "манго"),
  row(5, "red-bull-blueberry", "Ред Булл", "Ред Булл Original", "черника"),
  row(6, "hidden-volt", "Volt", "Volt Hidden", "манго", { is_published: 0 }),
  row(7, "adrenaline-rush", "Adrenaline Rush", "Adrenaline Rush", ""),
  row(8, "torq-energy", "TORQ", "TORQ Energy", ""),
  row(9, "flash-up", "Flash Up", "Flash Up Energy", "клубника"),
  row(10, "burn-tropic", "Burn", "Burn Tropical Mix", "тропический микс"),
]);

test("matchWords: регистр, ё, транслит, без объёмов и шума", () => {
  const words = new Set(matchWords("Red Bull Ёж 500 мл energy"));
  assert.ok(words.has("red"));
  assert.ok(words.has("bull"));
  assert.ok(words.has("еж"));
  assert.equal(words.has("500"), false);
  assert.equal(words.has("energy"), false);
  assert.equal(words.has("мл"), false);
});

test("findSimilarDrinks: находит дубль по бренду и порядку слов", () => {
  const hits = findSimilarDrinks(DB, { brand: "burn", name: "Burn Kiwi Apple", flavor: "" });
  assert.equal(hits[0]?.slug, "burn-apple-kiwi");
});

test("findSimilarDrinks: только бренд совпадает с «голой» банкой бренда", () => {
  const hits = findSimilarDrinks(DB, { brand: "Volt", name: "Volt", flavor: "" });
  assert.equal(hits[0]?.slug, "volt-original");
});

test("findSimilarDrinks: опечатку бренда ловит fuzzy-Dice, а не жёсткий отсев", () => {
  const hits = findSimilarDrinks(DB, { brand: "Gorila", name: "Gorila Mango", flavor: "" });
  assert.equal(hits[0]?.slug, "gorilla-mango");
  assert.equal(hits[0]?.confidence, "high");
  assert.match(hits[0]?.reason, /бренд/);
});

test("findSimilarDrinks: транслит «Ред Булл» ↔ «Red Bull» сходится", () => {
  const hits = findSimilarDrinks(DB, { brand: "Red Bull", name: "Red Bull", flavor: "черника" });
  assert.equal(hits[0]?.slug, "red-bull-blueberry");
});

test("findSimilarDrinks: разные вкусы и чужой бренд не совпадают", () => {
  assert.deepEqual(findSimilarDrinks(DB, { brand: "Burn", name: "Burn Original", flavor: "" }), []);
  assert.deepEqual(findSimilarDrinks(DB, { brand: "Red Bull", name: "Red Bull Apple Kiwi" }), []);
});

test("findSimilarDrinks: тот же бренд с другим вкусом — не дубль", () => {
  assert.deepEqual(
    findSimilarDrinks(DB, { brand: "Monster", name: "Monster Ultra Paradise", flavor: "маракуйя" }),
    [],
  );
});

test("findSimilarDrinks: опечатку во вкусе ловит Dice — дубль находится", () => {
  const hits = findSimilarDrinks(DB, { brand: "Monster", name: "Monster Ultra Whit", flavor: "цитрус" });
  assert.equal(hits[0]?.slug, "monster-white");
  assert.equal(hits[0]?.confidence, "high");
});

test("findSimilarDrinks: скрытые банки видны только с includeHidden", () => {
  const query = { brand: "Volt", name: "Volt Hidden Mango", flavor: "манго" };
  const visible = findSimilarDrinks(DB, query);
  assert.equal(visible.some((hit) => hit.slug === "hidden-volt"), false);
  const hidden = findSimilarDrinks(DB, query, { includeHidden: true }).find((hit) => hit.slug === "hidden-volt");
  assert.ok(hidden);
  assert.equal(hidden.hidden, true);
});

test("findSimilarDrinks: STT-опечатки и транслит бренда ловит Левенштейн", () => {
  assert.equal(findSimilarDrinks(DB, { brand: "Бёрн", name: "Burn Apple Kiwi" })[0]?.slug, "burn-apple-kiwi");
  assert.equal(findSimilarDrinks(DB, { brand: "Берн", name: "Burn Apple Kiwi" })[0]?.slug, "burn-apple-kiwi");
  assert.equal(findSimilarDrinks(DB, { brand: "Торк", name: "TORQ Original" })[0]?.slug, "torq-energy");
  assert.equal(findSimilarDrinks(DB, { brand: "Флэш Ап", name: "клубника" })[0]?.slug, "flash-up");
});

test("findSimilarDrinks: перепутанные поля не мешают найти дубль", () => {
  assert.equal(
    findSimilarDrinks(DB, { brand: "Burn Tropical Mix", name: "Burn Tropical Mix" })[0]?.slug,
    "burn-tropic",
  );
  assert.equal(findSimilarDrinks(DB, { brand: "Adrenaline", name: "Rush" })[0]?.slug, "adrenaline-rush");
  assert.equal(
    findSimilarDrinks(DB, { brand: "adrenaline rush", name: "Adrenaline Rush" })[0]?.slug,
    "adrenaline-rush",
  );
});
