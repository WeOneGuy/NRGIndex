const sharp = require("sharp");
const {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  PlanarYUVLuminanceSource,
} = require("@zxing/library");
const { readBarcodes } = require("zxing-wasm/reader");
const { badRequest } = require("./errors");

const OFF_BASE = "https://world.openfoodfacts.org/api/v2/product";
const CRPT_URL = "https://mobile.api.crpt.ru/mobile/check";
const TRUEMARK_URL = "https://truemark.ru/wp-json/truemark/v1/chz2";
const BARCODE_LIST_URL = "https://barcode-list.ru/barcode/RU/%D0%BF%D0%BE%D0%B8%D1%81%D0%BA.htm";
const UA = "NRGIndex/2.0 (energy drink tier list)";
const OFF_TIMEOUT_MS = 8000;
const CRPT_TIMEOUT_MS = 5000;
const BL_TIMEOUT_MS = 8000;

const digits = (value) => String(value || "").replace(/\D/g, "");

// mod-10 GTIN: валидны 8/12/13/14 цифр (EAN-8, UPC-A, EAN-13, GTIN-14).
function validGtin(value) {
  const clean = digits(value);
  if (![8, 12, 13, 14].includes(clean.length)) return false;
  let sum = 0;
  const body = clean.slice(0, -1).split("").reverse();
  for (let i = 0; i < body.length; i++) sum += Number(body[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(clean.at(-1));
}

// Канонический код для базы и Open Food Facts: 12 → 13, 14 с ведущим 0 → 13.
function normalizeGtin(value) {
  const clean = digits(value);
  if (!validGtin(clean)) return null;
  if (clean.length === 14 && clean.startsWith("0")) return clean.slice(1);
  if (clean.length === 12) return `0${clean}`;
  return clean;
}

// Data Matrix Честного знака: 01<GTIN14>21<серийник>… — берём GTIN.
function gtinFromDataMatrix(value) {
  const match = String(value || "").match(/01(\d{14})/);
  if (!match || !validGtin(match[1])) return null;
  return normalizeGtin(match[1]);
}

function parseScanCode(value) {
  // trim убирает пробелы по краям, но сохраняет GS (\x1D) и весь серийник.
  const raw = String(value || "").trim().replace(/^\]d2/, "").replace(/\{GS\}/g, "\x1D").replace(/^\x1D/, "");
  if (!raw) throw badRequest("Пустой код");
  if (/^\d{8,14}$/.test(raw)) {
    const gtin = normalizeGtin(raw);
    if (!gtin) throw badRequest("Штрих-код не проходит проверку контрольной цифры");
    return { kind: "ean", gtin, raw };
  }
  const gtin = gtinFromDataMatrix(raw);
  if (gtin) return { kind: "datamatrix", gtin, raw };
  throw badRequest("Это не штрих-код и не код Честного знака");
}

// Для формы: пусто → "", иначе канонический GTIN или 400.
function barcodeField(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const gtin = normalizeGtin(raw);
  if (!gtin) throw badRequest("Штрих-код должен быть EAN/UPC (8–14 цифр) с верной контрольной цифрой");
  return gtin;
}

async function lookupOpenFoodFacts(gtin, { fetchImpl = fetch } = {}) {
  const url =
    `${OFF_BASE}/${encodeURIComponent(gtin)}.json` +
    "?fields=product_name,product_name_ru,brands,quantity,product_quantity,product_quantity_unit,image_front_url,categories,nutriments";
  const res = await fetchImpl(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(OFF_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const p = data?.status === 1 ? data.product : null;
  if (!p) return null;
  const name = String(p.product_name_ru || p.product_name || "").trim();
  const brands = String(p.brands || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!name && !brands.length) return null;
  const n = p.nutriments || {};
  const volume =
    String(p.quantity || "").trim() ||
    (p.product_quantity ? `${p.product_quantity} ${p.product_quantity_unit || ""}`.trim() : "");
  return {
    source: "openfoodfacts",
    brand: brands[0] || name.split(/\s+/)[0] || "",
    name: name || brands[0],
    flavor: "",
    volume,
    image: /^https:\/\/images\.openfoodfacts\.org\//.test(p.image_front_url || "") ? p.image_front_url : "",
    caffeineMg: Math.round((Number(n.caffeine_serving) || 0) * 1000),
    kcal: Math.round(Number(n["energy-kcal_serving"]) || 0),
    sugarG: Math.round(Number(n.sugars_serving) || 0),
  };
}

// Неофициальный consumer-API: не ответил/ошибка/не нашёл — молча null.
async function lookupChestnyZnak(rawCode, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(CRPT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": UA,
      },
      body: new URLSearchParams({ cis: String(rawCode || "") }).toString(),
      signal: AbortSignal.timeout(CRPT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || data.success === false) return null;
    // Потребительский API отвечает и на неизвестные коды: codeFounded=false —
    // это не товар, а лишь разобранный GTIN; без названия возвращать нечего.
    if (data.codeFounded === false) return null;
    const name = String(data.productName || data.product_name || data.name || data.product?.name || "").trim();
    const brand = String(data.brand || data.brandName || data.product?.brand || "").trim();
    if (!name && !brand) return null;
    const gtin = normalizeGtin(data.gtin || data.codeResolveData?.gtin || "");
    return { source: "crpt", brand, name, flavor: "", gtin: gtin || "" };
  } catch {
    return null;
  }
}

// Атрибут «Вкус» иногда содержит тип товара («Энергетический напиток Берн»),
// а не вкус: такой мусор в flavor не пускаем.
const CATEGORY_FLAVOR_RE = /^\s*(?:энергетическ(?:ий|ого)\s+)?напиток(?![\p{L}\p{N}_])/iu;

function parseTrueMarkResponse(data) {
  const m = data?.m;
  if (data?.ok === false || data?.codeFounded === false || m?.codeFounded === false) return null;
  const good = Array.isArray(m?.catalogData) ? m.catalogData[0] : null;
  if (!good) return null;
  const text = (value) => typeof value === "string" ? value.trim() : "";
  const name = text(good.good_name);
  const brand = text(good.brand_name);
  if (!name && !brand) return null;
  const attrs = Array.isArray(good.good_attrs) ? good.good_attrs : [];
  const rawFlavor = text(attrs.find((attr) => attr?.attr_name === "Вкус")?.attr_value);
  const flavor = CATEGORY_FLAVOR_RE.test(rawFlavor) ? "" : rawFlavor;
  let image = "";
  try {
    const rawImage = text(good.good_img);
    const url = new URL(rawImage.startsWith("//") ? `https:${rawImage}` : rawImage);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) image = url.href;
  } catch {
    // Некорректная картинка не мешает вернуть остальные данные товара.
  }
  return { source: "truemark", name, brand, flavor, image };
}

async function lookupTrueMark(rawCode, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${TRUEMARK_URL}?code=${encodeURIComponent(rawCode)}`, {
      headers: { "user-agent": UA, referer: "https://truemark.ru/proverka-koda-markirovki/", accept: "application/json" },
      signal: AbortSignal.timeout(CRPT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseTrueMarkResponse(await res.json());
  } catch {
    return null;
  }
}

const ENTITIES = { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", nbsp: " " };

function decodeEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

const stripTags = (value) =>
  decodeEntities(String(value || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

// barcode-list.ru: российская база штрих-кодов — выручает там, где Open Food Facts
// по российским банкам пуст. Таблица randomBarcodes: «№ | код | наименование | ед. | рейтинг»,
// строки отсортированы по рейтингу. Название берём из <title> — там человеческая
// капитализация, а строку таблицы используем как проверку, что код вообще нашёлся.
function parseBarcodeListPage(html, gtin) {
  const text = String(html || "");
  const code = digits(gtin);
  if (!code || !text.includes('class="randomBarcodes"')) return null;
  let rowName = "";
  for (const row of text.matchAll(/<tr class="(?:even|odd)[^"]*">([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => stripTags(cell[1]));
    if (cells.length < 3 || digits(cells[1]) !== code || !cells[2]) continue;
    rowName = cells[2];
    break;
  }
  if (!rowName) return null;
  const title = stripTags((text.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "")
    .replace(/\s*-\s*Штрих-код:.*$/i, "")
    .trim();
  return { source: "barcode-list", name: title || rowName };
}

async function lookupBarcodeList(gtin, { fetchImpl = fetch } = {}) {
  const url = `${BARCODE_LIST_URL}?barcode=${encodeURIComponent(digits(gtin))}`;
  const res = await fetchImpl(url, {
    headers: { "user-agent": UA, accept: "text/html" },
    signal: AbortSignal.timeout(BL_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const html = await res.text();
  return parseBarcodeListPage(html, gtin);
}

// Читаем код с фото сами: обычный кадр, контрастный и инвертированный, каждый —
// в четырёх поворотах. Так переживают блики, тени и съёмку «вверх ногами» —
// то, на чём спотыкается единственная попытка камерного API.
const DECODE_FORMATS = [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128,
  BarcodeFormat.DATA_MATRIX,
];
const DECODE_MAX_SIDE = 1600;

// zxing-wasm: сильнее старого JS-порта на зашумлённых Data Matrix.
const WASM_FORMATS = ["DataMatrix", "EAN13", "EAN8", "UPCA", "UPCE", "Code128"];
const WASM_FORMAT_NAMES = {
  DataMatrix: "data_matrix",
  EAN13: "ean_13",
  EAN8: "ean_8",
  UPCA: "upc_a",
  UPCE: "upc_e",
  Code128: "code_128",
};

async function decodeWithZxingWasm(image) {
  const results = await readBarcodes(new Uint8Array(image), {
    formats: WASM_FORMATS,
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    tryDenoise: true,
    maxNumberOfSymbols: 1,
    textMode: "Plain",
  });
  const result = results?.find((item) => item?.isValid && item.text);
  if (!result) return null;
  return {
    code: String(result.text),
    format: WASM_FORMAT_NAMES[result.format] || String(result.format || "").toLowerCase(),
  };
}

// Otsu: гистограмма серого и порог между «тёмным» и «светлым».
function otsuThreshold(gray) {
  const histogram = new Array(256).fill(0);
  for (const value of gray) histogram[value]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let dark = 0;
  let sumDark = 0;
  let best = 0;
  let threshold = 0;
  for (let i = 0; i < 256; i++) {
    dark += histogram[i];
    if (!dark) continue;
    const light = total - dark;
    if (!light) break;
    sumDark += i * histogram[i];
    const between = dark * light * (sumDark / dark - (sum - sumDark) / light) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

// Три фиксированные попытки: оригинал, Otsu и Otsu с инверсией. Инверсия
// обязательна для бликующей банки: без неё Data Matrix не читается.
async function decodeWithWasmVariants(prepared) {
  const direct = await decodeWithZxingWasm(prepared);
  if (direct) return direct;
  const { data, info } = await sharp(prepared).grayscale().raw().toBuffer({ resolveWithObject: true });
  const threshold = otsuThreshold(data);
  for (const invert of [false, true]) {
    const pixels = Buffer.from(data.map((value) => ((value > threshold) !== invert ? 255 : 0)));
    const png = await sharp(pixels, { raw: { width: info.width, height: info.height, channels: 1 } })
      .png()
      .toBuffer();
    const found = await decodeWithZxingWasm(png);
    if (found) return found;
  }
  return null;
}

function decodePrepared(raw, info, hints) {
  const source = new PlanarYUVLuminanceSource(
    Uint8ClampedArray.from(raw),
    info.width,
    info.height,
    0,
    0,
    info.width,
    info.height,
    false,
  );
  const reader = new MultiFormatReader();
  try {
    reader.setHints(hints);
    const result = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(source)));
    return {
      code: String(result.getText() || ""),
      format: String(BarcodeFormat[result.getBarcodeFormat()] || "").toLowerCase(),
    };
  } catch {
    return null;
  } finally {
    reader.reset();
  }
}

// Прогрев wasm-декодера при старте: первый вызов компилирует модуль (~1–2 c),
// поэтому холодный старт сервера делает это заранее и fire-and-forget.
async function warmBarcodeDecoder() {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } })
    .png()
    .toBuffer();
  await decodeWithZxingWasm(png);
}

async function decodeBarcodeImage(buffer, { maxSide = DECODE_MAX_SIDE } = {}) {
  // Кадр держим в PNG: повороты raw-буфера sharp делает некорректно.
  const prepared = await sharp(buffer, { failOn: "error" })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();

  const wasm = await decodeWithWasmVariants(prepared).catch(() => null);
  if (wasm) return wasm;

  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, DECODE_FORMATS);
  hints.set(DecodeHintType.TRY_HARDER, true);

  for (const upscale of [false, true]) {
    let source = prepared;
    if (upscale) {
      const meta = await sharp(prepared).metadata();
      const side = Math.max(meta.width, meta.height);
      const enlarged = Math.min(2400, side * 2);
      if (enlarged <= side) break;
      source = await sharp(prepared).resize({ width: enlarged, height: enlarged, fit: "inside" }).png().toBuffer();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.DATA_MATRIX]);
    }
    for (const rotation of upscale ? [0] : [0, 180, 90, 270]) {
      const frame = rotation ? await sharp(source).rotate(rotation).png().toBuffer() : source;
      const base = () => sharp(frame).grayscale().normalise();
      const variants = [
        await base().raw().toBuffer({ resolveWithObject: true }),
        await base().linear(1.6, -40).sharpen().raw().toBuffer({ resolveWithObject: true }),
        await base().negate().raw().toBuffer({ resolveWithObject: true }),
      ];
      for (const variant of variants) {
        const found = decodePrepared(variant.data, variant.info, hints);
        if (found?.code) return found;
      }
    }
  }
  return null;
}

module.exports = {
  validGtin,
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
  decodeBarcodeImage,
  warmBarcodeDecoder,
};
