const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeGtin,
  gtinFromDataMatrix,
  parseScanCode,
  barcodeField,
  lookupOpenFoodFacts,
  lookupChestnyZnak,
  lookupTrueMark,
  parseTrueMarkResponse,
  lookupBarcodeList,
  parseBarcodeListPage,
} = require("../../server/lib/barcode");

test("normalizeGtin: канонизирует EAN/UPC/GTIN и режет неверные", () => {
  assert.equal(normalizeGtin("4680036912629"), "4680036912629");
  assert.equal(normalizeGtin("036000291452"), "0036000291452");
  assert.equal(normalizeGtin("04680036912629"), "4680036912629");
  assert.equal(normalizeGtin("96385074"), "96385074");
  assert.equal(normalizeGtin("4680036912620"), null);
  assert.equal(normalizeGtin("123"), null);
});

test("gtinFromDataMatrix: вытаскивает GTIN из кода Честного знака", () => {
  assert.equal(gtinFromDataMatrix("0104680036912629215Fabc"), "4680036912629");
  assert.equal(gtinFromDataMatrix("0104680036912620"), null);
  assert.equal(gtinFromDataMatrix("мусор"), null);
});

test("parseScanCode: различает EAN и Data Matrix, отклоняет мусор", () => {
  assert.deepEqual(parseScanCode("4680036912629"), { kind: "ean", gtin: "4680036912629", raw: "4680036912629" });
  const dm = parseScanCode("0104680036912629215Fabc");
  assert.equal(dm.kind, "datamatrix");
  assert.equal(dm.gtin, "4680036912629");
  assert.throws(() => parseScanCode("привет"), /не штрих-код/);
  assert.throws(() => parseScanCode("4680036912620"), /контрольной/);
});

test("barcodeField: пусто остаётся пустым, мусор отклоняется", () => {
  assert.equal(barcodeField(""), "");
  assert.throws(() => barcodeField("мусор"), /Штрих-код/);
});

test("TrueMark: полный GS1, GS в query и безопасные фиксированные заголовки", async () => {
  const raw = "0104680036912629215JuVJmTnOR:3H\x1D93kjJw";
  assert.deepEqual(parseScanCode(` ${raw} `), { kind: "datamatrix", gtin: "4680036912629", raw });
  for (const code of [raw, `]d2${raw}`, "0104680036912629215JuVJmTnOR:3H{GS}93kjJw", "]d20104680036912629215JuVJmTnOR:3H{GS}93kjJw"]) {
    assert.deepEqual(parseScanCode(code), { kind: "datamatrix", gtin: "4680036912629", raw });
  }
  const percentCode = "010468003691262921serial%1D%2B+/=:3H\x1D93test";
  assert.equal(parseScanCode(percentCode).raw, percentCode, "не декодируем URL и не меняем пунктуацию серийника");
  const data = { m: { codeFounded: true, catalogData: [{
    good_name: " Energy ", brand_name: " Brand ", good_img: " //example.com/can image.jpg ",
    good_attrs: [{ attr_name: "Цвет", attr_value: "красный" }, { attr_name: "Вкус", attr_value: " манго " }],
  }, { good_name: "Не этот товар" }] } };
  const found = await lookupTrueMark(raw, { fetchImpl: async (url, init) => {
    assert.equal(new URL(url).origin + new URL(url).pathname, "https://truemark.ru/wp-json/truemark/v1/chz2");
    assert.match(url, /%1D/);
    assert.equal(new URL(url).searchParams.get("code"), raw);
    assert.deepEqual(init.headers, {
      "user-agent": "NRGIndex/2.0 (energy drink tier list)", referer: "https://truemark.ru/proverka-koda-markirovki/", accept: "application/json",
    });
    return Response.json(data);
  } });
  assert.deepEqual(found, { source: "truemark", name: "Energy", brand: "Brand", flavor: "манго", image: "https://example.com/can%20image.jpg" });
  assert.equal(parseTrueMarkResponse({ ...data, codeFounded: false }), null);
  assert.equal(parseTrueMarkResponse({ ...data, ok: false }), null);
  assert.equal(parseTrueMarkResponse({ m: { ...data.m, codeFounded: false } }), null);
  for (const value of [null, {}, { m: { catalogData: [] } }, { m: { catalogData: [{}] } }]) {
    assert.equal(parseTrueMarkResponse(value), null);
  }
  for (const good_img of ["javascript:alert(1)", "data:image/png;base64,abc", "garbage", "https://user:pass@example.com/x"]) {
    assert.equal(parseTrueMarkResponse({ m: { catalogData: [{ good_name: "X", good_img }] } }).image, "");
  }
});

test("parseTrueMarkResponse: тип товара в атрибуте «Вкус» не становится вкусом", () => {
  const junk = parseTrueMarkResponse({
    m: { catalogData: [{ good_name: "Burn", brand_name: "Берн", good_attrs: [{ attr_name: "Вкус", attr_value: "Энергетический напиток Берн" }] }] },
  });
  assert.equal(junk.flavor, "");
  const real = parseTrueMarkResponse({
    m: { catalogData: [{ good_name: "Burn", brand_name: "Берн", good_attrs: [{ attr_name: "Вкус", attr_value: "манго" }] }] },
  });
  assert.equal(real.flavor, "манго");
});

test("TrueMark: HTTP, JSON и сетевая ошибка возвращают null", async () => {
  for (const fetchImpl of [
    async () => new Response("error", { status: 503 }),
    async () => new Response("not json"),
    async () => { throw new Error("network down"); },
  ]) assert.equal(await lookupTrueMark("0104680036912629215Fabc", { fetchImpl }), null);
});

test("lookupOpenFoodFacts: товар, нет товара и HTTP-ошибка", async () => {
  const product = {
    status: 1,
    product: {
      product_name: "Gorilla energy drink",
      quantity: "450 ml",
      image_front_url: "https://images.openfoodfacts.org/x.jpg",
      nutriments: { caffeine_serving: 0.135, "energy-kcal_serving": 225, sugars_serving: 54 },
    },
  };
  const fetchImpl = async () => ({ ok: true, json: async () => product });
  const found = await lookupOpenFoodFacts("4680036912629", { fetchImpl });
  assert.equal(found.source, "openfoodfacts");
  assert.equal(found.brand, "Gorilla");
  assert.equal(found.name, "Gorilla energy drink");
  assert.equal(found.volume, "450 ml");
  assert.equal(found.image, "https://images.openfoodfacts.org/x.jpg");
  assert.equal(found.caffeineMg, 135);
  assert.equal(found.kcal, 225);
  assert.equal(found.sugarG, 54);

  assert.equal(await lookupOpenFoodFacts("4680036912629", { fetchImpl: async () => ({ ok: true, json: async () => ({ status: 0 }) }) }), null);
  assert.equal(await lookupOpenFoodFacts("4680036912629", { fetchImpl: async () => ({ ok: false }) }), null);
});

test("lookupChestnyZnak: GTIN из ответа, отказ и ошибка сети", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ success: true, productName: "X", brand: "Y", codeResolveData: { gtin: "04680036912629" } }),
  });
  const found = await lookupChestnyZnak("0104680036912629215Fabc", { fetchImpl });
  assert.equal(found.source, "crpt");
  assert.equal(found.gtin, "4680036912629");
  assert.equal(found.name, "X");
  assert.equal(found.brand, "Y");

  assert.equal(
    await lookupChestnyZnak("0104680036912629215Fabc", { fetchImpl: async () => ({ ok: true, json: async () => ({ success: false }) }) }),
    null,
  );
  assert.equal(
    await lookupChestnyZnak("0104680036912629215Fabc", {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ codeFounded: false, codeResolveData: { gtin: "04680036912629" } }),
      }),
    }),
    null,
    "неизвестный код Честного знака — не товар",
  );
  assert.equal(
    await lookupChestnyZnak("0104680036912629215Fabc", {
      fetchImpl: async () => {
        throw new Error("network down");
      },
    }),
    null,
  );
});

test("barcode-list: разбирает страницу с товаром и берёт читаемое название", () => {
  const html = `<!doctype html><html><head>
    <title>Напиток энергитический Адреналин Раш жб 0.25л - Штрих-код: 4600494223013</title></head>
    <body><table class="randomBarcodes"><tr><th>№</th><th>Штрих-код</th></tr>
    <tr class="even"><td>1</td><td>4600494223013</td><td>НАПИТОК ЭНЕРГИТИЧЕСКИЙ АДРЕНАЛИН РАШ ЖБ 0.25Л</td><td>ШТ.</td><td>581</td></tr>
    <tr class="odd"><td>3</td><td>4600494223013</td><td>НАПИТОК АДРЕНАЛИН РАШ</td><td>ШТ</td><td>5</td></tr>
    </table></body></html>`;
  assert.deepEqual(parseBarcodeListPage(html, "4600494223013"), {
    source: "barcode-list",
    name: "Напиток энергитический Адреналин Раш жб 0.25л",
  });
});

test("barcode-list: без таблицы или чужого кода — null", () => {
  assert.equal(parseBarcodeListPage("<html><body>ничего не нашлось</body></html>", "4600494223013"), null);
  const other = `<table class="randomBarcodes"><tr class="odd"><td>1</td><td>1111111111116</td><td>ЧУЖОЙ ТОВАР</td><td>ШТ</td><td>1</td></tr></table>`;
  assert.equal(parseBarcodeListPage(other, "4600494223013"), null);
});

test("lookupBarcodeList: ходит за HTML и переживает ошибку", async () => {
  const calls = [];
  const html = `<html><head><title>Флеш Ап Апельсиновый ритм 0.45л. жб - Штрих-код: 4600682003106</title></head>
    <body><table class="randomBarcodes"><tr class="even"><td>1</td><td>4600682003106</td><td>ФЛЕШ АП АПЕЛЬСИНОВЫЙ РИТМ</td><td>ШТ.</td><td>260</td></tr></table></body></html>`;
  const found = await lookupBarcodeList("4600682003106", {
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      assert.match(String(init?.headers?.["user-agent"]), /NRGIndex/);
      return new Response(html, { status: 200 });
    },
  });
  assert.equal(found.name, "Флеш Ап Апельсиновый ритм 0.45л. жб");
  assert.match(calls[0], /barcode-list\.ru/);
  assert.match(calls[0], /barcode=4600682003106/);

  assert.equal(await lookupBarcodeList("4600682003106", { fetchImpl: async () => new Response("no", { status: 500 }) }), null);
});

// Заводских энкодеров в zxing-js нет, поэтому рисуем код сами (tests/helpers/ean13.js).
test("ean13-хелпер: контрольная цифра по спецификации", () => {
  const { checkDigit } = require("../helpers/ean13");
  assert.equal(checkDigit("468003691262"), "9");
});

test("decodeBarcodeImage: читает фото в поворотах, инверсии и смазанное", async () => {
  const sharp = require("sharp");
  const { ean13Png } = require("../helpers/ean13");
  const { decodeBarcodeImage } = require("../../server/lib/barcode");

  const png = await ean13Png("468003691262");
  const variants = [
    ["прямо", png],
    ["вверх ногами", await sharp(png).rotate(180).toBuffer()],
    ["снято боком", await sharp(png).rotate(90).toBuffer()],
    ["снято боком 270", await sharp(png).rotate(270).toBuffer()],
    ["инверсия", await sharp(png).negate().toBuffer()],
    ["смазанное фото", await sharp(png).blur(1.1).jpeg({ quality: 60 }).toBuffer()],
    ["тёмное фото", await sharp(png).linear(0.6, -40).toBuffer()],
  ];
  for (const [label, buffer] of variants) {
    const found = await decodeBarcodeImage(buffer);
    assert.equal(found?.code, "4680036912629", `${label}: код должен читаться`);
    assert.equal(found?.format, "ean_13");
  }

  const blank = await sharp({
    create: { width: 800, height: 240, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();
  assert.equal(await decodeBarcodeImage(blank), null, "пустой кадр ничего не выдумывает");
});

test("decodeBarcodeImage: реальный GS1 Data Matrix с GS", async () => {
  const { dataMatrixPng } = require("../helpers/datamatrix");
  const { decodeBarcodeImage } = require("../../server/lib/barcode");
  const expected = "0104680036912629215JuVJmTnOR:3H\x1D93kjJw";
  for (const image of [
    await dataMatrixPng({ scale: 12 }),
    await require("sharp")(await dataMatrixPng({ scale: 12 })).rotate(180).toBuffer(),
    await require("sharp")(await dataMatrixPng({ scale: 12 })).negate().toBuffer(),
    await require("sharp")(await dataMatrixPng({ scale: 12 })).resize(320, 320).toBuffer(),
  ]) {
    // zxing-wasm в Plain-режиме не отдаёт начальный FNC1: внутренний GS на месте.
    assert.deepEqual(await decodeBarcodeImage(image), { code: expected, format: "data_matrix" });
  }
});

test("decodeBarcodeImage: реальное фото Data Matrix с крышки банки", async () => {
  const { readFile } = require("node:fs/promises");
  const path = require("node:path");
  const { decodeBarcodeImage } = require("../../server/lib/barcode");
  const found = await decodeBarcodeImage(
    await readFile(path.join(__dirname, "..", "fixtures", "dm-can-top.jpg")),
  );
  assert.deepEqual(found, { code: "0104680036912629215JuVJmTnOR:3H\x1D93kjJw", format: "data_matrix" });
});

test("GS1 fixture → parseScanCode → TrueMark: только начальный FNC1 удаляется", async () => {
  const { dataMatrixPng } = require("../helpers/datamatrix");
  const { decodeBarcodeImage } = require("../../server/lib/barcode");
  const expected = "0104680036912629215JuVJmTnOR:3H\x1D93kjJw";
  const decoded = await decodeBarcodeImage(await dataMatrixPng());
  assert.equal(decoded.code, expected);
  // parseScanCode принимает и сырой код, и вариант с начальным FNC1, и scanner-префикс.
  for (const code of [decoded.code, `\x1D${decoded.code}`, `]d2${decoded.code}`, `]d2\x1D${decoded.code}`]) {
    const scan = parseScanCode(code);
    assert.equal(scan.raw, expected);
    await lookupTrueMark(scan.raw, { fetchImpl: async (url) => {
      assert.equal(new URL(url).searchParams.get("code"), expected);
      return Response.json({ codeFounded: false });
    } });
  }
});
