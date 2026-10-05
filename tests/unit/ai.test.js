const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeParsed,
  parseDrinkText,
  parseRatingText,
  transcribeAudio,
  normalizeBaseUrl,
  normalizeUsage,
  estimateCostUsd,
  providerFailureDetail,
  audioFormat,
  decodeAudio,
  searchCanImages,
  searchGoogleCse,
  searchDuckDuckGo,
  photoTerms,
  SYSTEM_PROMPT,
} = require("../../server/lib/ai");

const chatReply = (payload, usage) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }], usage }),
});

test("normalizeParsed не выдумывает отзыв и вкус", () => {
  const clean = normalizeParsed({ name: "Monster White" });
  assert.equal(clean.brand, "Monster");
  assert.equal(clean.flavor, "");
  assert.equal(clean.edition, "");
  assert.equal(clean.review, "");
  assert.equal(clean.tier, "B");
  assert.equal(clean.tierGuessed, true);
});

test("normalizeParsed сохраняет заполненные поля и явный тир", () => {
  const clean = normalizeParsed({
    brand: "Burn",
    name: "Burn Original",
    flavor: "Классика",
    edition: "Чёрная банка",
    review: "Норм",
    tier: "a",
  });
  assert.deepEqual(clean, {
    brand: "Burn",
    name: "Burn Original",
    flavor: "Классика",
    edition: "Чёрная банка",
    review: "Норм",
    tier: "A",
    tierGuessed: false,
  });
});

test("промпт запрещает выдумывать мнение", () => {
  assert.match(SYSTEM_PROMPT, /Ничего не выдумывай/);
  assert.match(SYSTEM_PROMPT, /review = ""/);
  assert.match(SYSTEM_PROMPT, /tier = null/);
});

test("промпт делит марку и линейку: Lit/Adrenaline Rush", () => {
  assert.match(SYSTEM_PROMPT, /торговая марка целиком/);
  assert.match(SYSTEM_PROMPT, /Adrenaline Rush/);
  assert.match(SYSTEM_PROMPT, /brand «Lit», name «Lit Energy»/);
  assert.match(SYSTEM_PROMPT, /через запятую/);
  assert.match(SYSTEM_PROMPT, /клубника · каламанси/);
});

test("parseDrinkText делает один запрос на base URL и оставляет пустыми неизвестные поля", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return chatReply({ brand: "Monster", name: "Monster White", flavor: "", edition: "", review: "", tier: null });
  };
  const result = await parseDrinkText("монстр белый", {
    key: "test-key",
    baseUrl: "https://llm.example/v1",
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://llm.example/v1/chat/completions");
  assert.equal(result.review, "");
  assert.equal(result.tierGuessed, true);
});

test("parseDrinkText достаёт JSON даже с мусором вокруг", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'Вот:\n```json\n{"brand":"Burn","name":"Burn Apple Kiwi","tier":"A","review":"Вкусный"}\n```' } }],
    }),
  });
  const result = await parseDrinkText("берн яблоко киви, вкусный, A", { key: "k", fetchImpl });
  assert.equal(result.tier, "A");
  assert.equal(result.review, "Вкусный");
});

test("parseDrinkText: черновик из QR не теряется, модель уточняет поля", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return chatReply({ brand: "", name: "", flavor: "манго", edition: "", review: "огонь", tier: "A" });
  };
  const result = await parseDrinkText("вкус огонь, тир А", {
    key: "k",
    fetchImpl,
    draft: { brand: "Burn", name: "Burn Original", flavor: "энергетический напиток Берн", edition: "" },
  });
  assert.equal(result.brand, "Burn");
  assert.equal(result.name, "Burn Original");
  assert.equal(result.flavor, "манго");
  assert.equal(result.tier, "A");
  assert.match(calls[0].messages[1].content, /Черновик/);
  assert.match(calls[0].messages[1].content, /Burn Original/);
});

test("parseDrinkText: с фото сообщение уходит частями text + image_url", async () => {
  let body;
  const fetchImpl = async (url, options) => {
    body = JSON.parse(options.body);
    return chatReply({ brand: "Burn", name: "Burn", review: "", tier: null });
  };
  const photo = "data:image/png;base64,iVBORw0KGgo=";
  await parseDrinkText("что за банка", { key: "k", fetchImpl, imageDataUrl: photo });
  assert.equal(body.messages[1].content[0].type, "text");
  assert.equal(body.messages[1].content[1].type, "image_url");
  assert.equal(body.messages[1].content[1].image_url.url, photo);
});

test("parseDrinkText: провайдер без vision — повтор без картинки", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (Array.isArray(body.messages[1].content)) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "No endpoints support image input" } }) };
    }
    return chatReply({ brand: "Burn", name: "Burn", review: "", tier: null });
  };
  const result = await parseDrinkText("берн", { key: "k", fetchImpl, imageDataUrl: "data:image/png;base64,iVBORw0KGgo=" });
  assert.equal(calls.length, 2);
  assert.equal(typeof calls[1].messages[1].content, "string");
  assert.equal(result.name, "Burn");
});

test("parseDrinkText без ключа сообщает об ошибке", async () => {
  await assert.rejects(() => parseDrinkText("тест", { key: "" }), /ключ/i);
});

test("parseRatingText: название банки уходит в контекст, «нет бренда» больше не стреляет", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return chatReply({ tier: null, review: "троечка, приторно, но бодрит" });
  };
  const result = await parseRatingText(
    "троечка, приторно, но бодрит",
    { brand: "Burn", name: "Tropic Blast", flavor: "манго" },
    { key: "test-key", baseUrl: "https://llm.example/v1", fetchImpl },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://llm.example/v1/chat/completions");
  const userMessage = calls[0].body.messages[1].content;
  assert.match(userMessage, /Burn Tropic Blast/);
  assert.match(userMessage, /вкус: манго/);
  assert.match(userMessage, /троечка, приторно/);
  assert.match(calls[0].body.messages[0].content, /tier/);
  assert.equal(result.review, "троечка, приторно, но бодрит");
  assert.equal(result.tier, "B");
  assert.equal(result.tierGuessed, true);
});

test("parseRatingText распознаёт явный тир из ответа модели", async () => {
  const fetchImpl = async () => chatReply({ tier: "A", review: "Бодрит, беру ещё" });
  const result = await parseRatingText("на четвёрочку, бодрит, беру ещё", { name: "Volt" }, { key: "k", fetchImpl });
  assert.deepEqual(result, { tier: "A", tierGuessed: false, review: "Бодрит, беру ещё" });
});

test("parseRatingText без названия банки — понятная ошибка", async () => {
  await assert.rejects(() => parseRatingText("норм", {}, { key: "k" }), /название банки/i);
});

test("parseDrinkText: ошибка провайдера несёт код, пояснение и тело ответа", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: "API key not valid" } }),
  });
  const error = await parseDrinkText("тест", { key: "bad", fetchImpl }).catch((err) => err);
  assert.match(error.message, /HTTP 401/);
  assert.match(error.message, /ключ ИИ неверный или отозван/);
  assert.match(error.message, /API key not valid/);
});

test("transcribeAudio: OpenRouter получает JSON с input_audio", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, body: JSON.parse(options.body), headers: options.headers };
    return { ok: true, json: async () => ({ text: " Burn манго, топчик " }) };
  };
  const text = await transcribeAudio(Buffer.alloc(500, 1), "audio/webm;codecs=opus", {
    key: "k",
    sttModel: "openai/whisper-large-v3-turbo",
    baseUrl: "https://openrouter.ai/api/v1",
    fetchImpl,
  });
  assert.equal(text, "Burn манго, топчик");
  assert.equal(captured.url, "https://openrouter.ai/api/v1/audio/transcriptions");
  assert.equal(captured.body.model, "openai/whisper-large-v3-turbo");
  assert.equal(captured.body.input_audio.format, "webm");
  assert.equal(captured.body.language, "ru");
  assert.ok(captured.body.input_audio.data.length > 0);
});

test("transcribeAudio: другой провайдер получает multipart", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, body: options.body };
    return { ok: true, json: async () => ({ text: "привет" }) };
  };
  await transcribeAudio(Buffer.alloc(500, 1), "audio/mp4", { key: "k", baseUrl: "https://api.groq.com/openai/v1", fetchImpl });
  assert.equal(captured.url, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.ok(captured.body instanceof FormData);
  assert.equal(captured.body.get("model"), "openai/whisper-large-v3-turbo");
});

test("transcribeAudio: пустой текст — ошибка", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ text: "" }) });
  await assert.rejects(
    () => transcribeAudio(Buffer.alloc(500, 1), "audio/webm", { key: "k", fetchImpl }),
    /речь/,
  );
});

test("normalizeBaseUrl, audioFormat, decodeAudio валидируют ввод", () => {
  assert.equal(normalizeBaseUrl("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/v1");
  assert.throws(() => normalizeBaseUrl("ftp://x"), /http/);
  assert.throws(() => normalizeBaseUrl("не адрес"), /Base URL/);
  assert.equal(audioFormat("audio/ogg;codecs=opus"), "ogg");
  assert.throws(() => audioFormat("text/plain"), /формат/);
  assert.throws(() => decodeAudio("aGk="), /короткая/);
  assert.equal(decodeAudio(Buffer.alloc(300).toString("base64")).length, 300);
});

test("photoTerms: слова без дублей и спецсимволов поиска", () => {
  assert.equal(photoTerms("Burn", "Burn Juicy Energy", 'малина "личи":'), "Burn Juicy Energy малина личи");
  assert.equal(photoTerms("", "  ", "x"), "");
});

test("searchCanImages ищет по бренду+названию+вкусу и сливает источники", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes("openfoodfacts")) {
      return {
        ok: true,
        json: async () => ({
          hits: [
            { brands: ["Volt"], product_name: "Volt Cola", image_front_url: "https://images.openfoodfacts.org/c.jpg" },
            { brands: "Volt", product_name: "Малина-личи", image_front_url: "https://images.openfoodfacts.org/a.jpg" },
            { brands: "Burn", product_name: "Малина", image_front_url: "https://images.openfoodfacts.org/b.jpg" },
            { brands: "Volt", image_front_url: "https://evil.example/x.jpg" },
          ],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        query: {
          pages: {
            1: { index: 2, title: "File:Doc.pdf", imageinfo: [{ mime: "application/pdf", url: "https://upload.wikimedia.org/d.pdf" }] },
            2: { index: 1, title: "File:Volt can.jpg", imageinfo: [{ mime: "image/jpeg", thumburl: "https://upload.wikimedia.org/v.jpg" }] },
          },
        },
      }),
    };
  };
  const images = await searchCanImages({ brand: "Volt", name: "Volt", flavor: "малина личи" }, { fetchImpl });
  assert.deepEqual(
    images.map((item) => item.url),
    ["https://images.openfoodfacts.org/a.jpg", "https://images.openfoodfacts.org/c.jpg", "https://upload.wikimedia.org/v.jpg"],
  );
  assert.equal(images[2].title, "Volt can");
  const off = decodeURIComponent(urls.find((url) => url.includes("openfoodfacts")));
  assert.match(off, /Volt малина личи/);
  // вкус в Commons не шлём — там по нему почти ничего нет
  assert.doesNotMatch(decodeURIComponent(urls.find((url) => url.includes("wikimedia"))), /малина/);
});

test("searchCanImages: один источник упал — отдаём второй, оба — 502", async () => {
  const offOnly = async (url) =>
    url.includes("wikimedia")
      ? { ok: false, status: 503 }
      : { ok: true, json: async () => ({ hits: [{ image_front_url: "https://images.openfoodfacts.org/b.jpg" }] }) };
  assert.equal((await searchCanImages("burn", { fetchImpl: offOnly })).length, 1);
  const down = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => searchCanImages("burn", { fetchImpl: down }), /недоступен/);
});

test("searchCanImages: PNG и «white background» с Commons идут первыми как stockHint", async () => {
  const fetchImpl = async (url) =>
    url.includes("openfoodfacts")
      ? { ok: true, json: async () => ({ hits: [{ brands: "Burn", image_front_url: "https://images.openfoodfacts.org/o.jpg" }] }) }
      : {
          ok: true,
          json: async () => ({
            query: {
              pages: {
                1: { index: 1, title: "File:Burn can.jpg", imageinfo: [{ mime: "image/jpeg", thumburl: "https://upload.wikimedia.org/j.jpg" }] },
                2: { index: 2, title: "File:Burn can.png", imageinfo: [{ mime: "image/png", thumburl: "https://upload.wikimedia.org/p.png" }] },
                3: { index: 3, title: "File:Burn on white background.jpg", imageinfo: [{ mime: "image/jpeg", thumburl: "https://upload.wikimedia.org/w.jpg" }] },
              },
            },
          }),
        };
  const images = await searchCanImages({ brand: "Burn", name: "Burn" }, { fetchImpl });
  assert.deepEqual(
    images.map((item) => [item.url.split("/").pop(), item.stockHint]),
    [["p.png", true], ["w.jpg", true], ["o.jpg", false], ["j.jpg", false]],
  );
});

test("providerFailureDetail достаёт текст ошибки из JSON провайдера", async () => {
  const res = new Response(
    JSON.stringify({ success: false, error: "Access denied by security policy." }),
    { status: 403 },
  );
  assert.equal(await providerFailureDetail(res), "Access denied by security policy.");
});

test("providerFailureDetail чистит HTML и режет длину", async () => {
  const html = new Response("<html><head><title>Blocked</title></head><body>no</body></html>", {
    status: 403,
  });
  const detail = await providerFailureDetail(html);
  assert.ok(detail.includes("Blocked"));
  assert.ok(!detail.includes("<"));
  const long = new Response("z".repeat(400), { status: 500 });
  assert.equal((await providerFailureDetail(long, 50)).length, 50);
});

test("providerFailureDetail: пустое тело — пустая строка", async () => {
  assert.equal(await providerFailureDetail(new Response("", { status: 500 })), "");
});

test("searchGoogleCse: маппит items, режет мусор и ставит stockHint", async () => {
  let seenUrl = "";
  const fetchImpl = async (url) => {
    seenUrl = url;
    return {
      ok: true,
      json: async () => ({
        items: [
          { link: "https://example.com/burn.jpg", title: "Burn can on white background", snippet: "product shot" },
          { link: "ftp://example.com/x.jpg", title: "мусор" },
          { link: "https://example.com/other.png", title: "Burn fan photo" },
        ],
      }),
    };
  };
  const items = await searchGoogleCse("Burn", { key: "k", cx: "cx", fetchImpl });
  assert.match(decodeURIComponent(seenUrl), /Burn energy drink can/);
  assert.match(seenUrl, /searchType=image/);
  assert.deepEqual(
    items.map((item) => [item.url.split("/").pop(), item.source, item.stockHint]),
    [["burn.jpg", "google", true], ["other.png", "google", false]],
  );
});

test("searchGoogleCse: без ключа не дёргает сеть, ошибка HTTP несёт статус", async () => {
  let called = false;
  await assert.rejects(
    searchGoogleCse("Burn", { key: "", cx: "cx", fetchImpl: async () => ((called = true), {}) }),
    /не настроен/,
  );
  assert.equal(called, false);
  const bad = async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ error: { message: "API key not valid." } }),
  });
  const error = await searchGoogleCse("Burn", { key: "bad", cx: "cx", fetchImpl: bad }).catch((e) => e);
  assert.equal(error.status, 403);
  assert.match(error.message, /API key not valid/);
});

test("searchCanImages: с ключами Google идёт первым, без ключей Google не трогаем", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes("customsearch")) {
      return {
        ok: true,
        json: async () => ({ items: [{ link: "https://example.com/g.jpg", title: "Burn can" }] }),
      };
    }
    if (url.includes("openfoodfacts")) {
      return {
        ok: true,
        json: async () => ({ hits: [{ brands: "Burn", image_front_url: "https://images.openfoodfacts.org/o.jpg" }] }),
      };
    }
    return { ok: true, json: async () => ({ query: { pages: {} } }) };
  };
  const withGoogle = await searchCanImages({ brand: "Burn", name: "Burn" }, { fetchImpl, googleKey: "k", googleCx: "cx" });
  assert.equal(withGoogle[0].source, "google");
  assert.ok(urls.some((url) => url.includes("customsearch")));

  urls.length = 0;
  await searchCanImages({ brand: "Burn", name: "Burn" }, { fetchImpl });
  assert.ok(!urls.some((url) => url.includes("customsearch")));
});

test("searchCanImages: гугл и дак идут через proxyFetchImpl, остальные — через fetchImpl", async () => {
  const direct = [];
  const viaProxy = [];
  const fetchImpl = async (url) => {
    direct.push(url);
    if (url.includes("openfoodfacts")) {
      return {
        ok: true,
        json: async () => ({ hits: [{ brands: "Burn", image_front_url: "https://images.openfoodfacts.org/o.jpg" }] }),
      };
    }
    return { ok: true, json: async () => ({ query: { pages: {} } }) };
  };
  const proxyFetchImpl = async (url) => {
    viaProxy.push(url);
    if (url.includes("duckduckgo.com/?")) {
      return { ok: true, text: async () => '<html><body vqd="7-123abc"></body></html>' };
    }
    if (url.includes("i.duckduckgo.com")) {
      return { ok: true, json: async () => ([{ image: "https://example.com/d.jpg", title: "Burn can" }]) };
    }
    return { ok: true, json: async () => ({ items: [{ link: "https://example.com/g.jpg", title: "Burn can" }] }) };
  };
  const images = await searchCanImages(
    { brand: "Burn", name: "Burn" },
    { fetchImpl, proxyFetchImpl, googleKey: "k", googleCx: "cx" },
  );
  assert.deepEqual(images.map((item) => item.source), ["google", "duckduckgo", "openfoodfacts"]);
  assert.ok(viaProxy.some((url) => url.includes("customsearch")));
  assert.ok(viaProxy.some((url) => url.includes("duckduckgo")));
  assert.ok(!direct.some((url) => url.includes("customsearch")));
  assert.ok(!direct.some((url) => url.includes("duckduckgo")));
});

test("searchDuckDuckGo: токен со страницы, маппинг i.js, мусор режется", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes("i.duckduckgo.com")) {
      return {
        ok: true,
        json: async () => ([
          { image: "https://example.com/can.jpg", title: "Burn can isolated on white background", source: "shop" },
          { image: "data:image/gif;base64,x", title: "мусор" },
          { image: "https://example.com/fan.png", title: "Burn fan photo" },
        ]),
      };
    }
    return { ok: true, text: async () => "vqd='4-abc123'" };
  };
  const items = await searchDuckDuckGo("Burn", fetchImpl);
  assert.match(decodeURIComponent(seen[1]), /vqd=4-abc123/);
  assert.deepEqual(
    items.map((item) => [item.url.split("/").pop(), item.source, item.stockHint]),
    [["can.jpg", "duckduckgo", true], ["fan.png", "duckduckgo", false]],
  );
});

test("searchCanImages: дак упал (бот-стена/нет токена) — отдаём остальных, не 502", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("duckduckgo")) {
      return { ok: false, status: 202, text: async () => "" };
    }
    if (url.includes("openfoodfacts")) {
      return {
        ok: true,
        json: async () => ({ hits: [{ brands: "Burn", image_front_url: "https://images.openfoodfacts.org/o.jpg" }] }),
      };
    }
    return { ok: true, json: async () => ({ query: { pages: {} } }) };
  };
  const images = await searchCanImages({ brand: "Burn", name: "Burn" }, { fetchImpl });
  assert.ok(images.length > 0);
  assert.ok(images.every((item) => item.source !== "duckduckgo"));
});

test("usage: normalizeUsage приводит отчёты OpenRouter и Gemini к одному виду", () => {
  assert.deepEqual(
    normalizeUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.00123 }),
    { promptTokens: 100, completionTokens: 50, totalTokens: 150, costUsd: 0.00123 },
  );
  assert.deepEqual(
    normalizeUsage({ promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 }),
    { promptTokens: 7, completionTokens: 3, totalTokens: 10, costUsd: 0 },
  );
  assert.deepEqual(normalizeUsage(undefined), { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 });
});

test("usage: цена — приоритет отчёту провайдера, иначе таблица моделей", () => {
  assert.equal(estimateCostUsd("x/unknown", { promptTokens: 10, completionTokens: 0, totalTokens: 10, costUsd: 0.5 }), 0.5);
  assert.ok(Math.abs(estimateCostUsd("openai/gpt-4o-mini", { promptTokens: 1e6, completionTokens: 0, totalTokens: 1e6, costUsd: 0 }) - 0.15) < 1e-9);
  assert.ok(Math.abs(estimateCostUsd("gemini-2.5-flash", { promptTokens: 1e6, completionTokens: 1e6, totalTokens: 2e6, costUsd: 0 }) - 2.8) < 1e-9);
  assert.equal(estimateCostUsd("x/unknown", { promptTokens: 10, completionTokens: 0, totalTokens: 10, costUsd: 0 }), 0);
});

test("parseDrinkText отчитывается: onUsage получает токены и оценочную цену", async () => {
  const seen = [];
  await parseDrinkText("burn норм", {
    key: "k",
    model: "openai/gpt-4o-mini",
    baseUrl: "https://openrouter.example/v1",
    fetchImpl: async () => chatReply({ brand: "Burn", name: "Burn", tier: "B", review: "" }, { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 }),
    onUsage: (usage, model, kind) => seen.push({ usage, model, kind }),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "parse");
  assert.equal(seen[0].model, "openai/gpt-4o-mini");
  assert.equal(seen[0].usage.totalTokens, 1000);
  assert.ok(Math.abs(seen[0].usage.costUsd - 0.000195) < 1e-9);
});
