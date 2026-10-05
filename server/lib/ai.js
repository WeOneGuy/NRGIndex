const { ApiError, badRequest } = require("./errors");
const { getSetting } = require("../db");
const { proxiedFetch } = require("./proxy");
const { DEFAULT_OPENROUTER_IMAGE_MODEL, REDRAW_PROMPT: OPENROUTER_REDRAW_PROMPT } = require("./openrouter-image");
const { REDRAW_PROMPT: GEMINI_REDRAW_PROMPT, DEFAULT_VISION_MODEL } = require("./gemini");

const TIERS = ["S", "A", "B", "C", "D"];
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_STT_MODEL = "openai/whisper-large-v3-turbo";
const DEFAULT_TIER = "B";
const DEFAULT_IMAGE_PROVIDER = "gemini";
const IMAGE_PROVIDERS = ["gemini", "openrouter"];
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

const SYSTEM_PROMPT = [
  "Ты — парсер. Из сообщения пользователя про энергетик извлеки данные и верни СТРОГО JSON без пояснений и markdown:",
  '{"brand":"","name":"","flavor":"","edition":"","tier":"S|A|B|C|D|null","review":""}',
  "",
  "Правила:",
  "1. Ничего не выдумывай. Особенно мнение: ты не пробовал напиток, у тебя нет вкуса и оценок.",
  "2. review — только мнение самого автора из его сообщения: перескажи коротко (1–3 предложения, по-русски, от первого лица),",
  "   сохраняя его слова и смысл. Не добавляй ни одного впечатления, эпитета или вывода, которого нет в тексте.",
  "   Если автор не высказал мнения — review = \"\".",
  "3. tier — только если автор явно оценил напиток: прямо назвал тир (S/A/B/C/D) или однозначно выразил отношение",
  "   (восторг, «лучший» = S; хвалит, «возьму ещё» = A; «норм», «пойдёт» = B; «так себе», «на любителя» = C; ругает, «не бери» = D).",
  "   Если оценки нет — tier = null. Не выводи тир из репутации бренда.",
  "4. brand — торговая марка целиком, всеми её словами (Adrenaline Rush, Burn, Monster, Lit).",
  "   Не обрезай марку до первого слова и не дописывай в неё линейку продукта.",
  "   name — полное название продукта без вкуса: марка + линейка (Lit Energy, Burn Apple Kiwi, Adrenaline Rush).",
  "   Вкус в name не дублируй. Если в тексте есть только бренд, name = бренд.",
  "   Можно исправить опечатки и транслитерацию до официального написания (берн → Burn, монстр → Monster).",
  "   Примеры: «Lit energy юдзу-сушняк» → brand «Lit», name «Lit Energy», flavor «юдзу-сушняк»;",
  "   «Adrenaline rush юдзу клубника каламанси» → brand «Adrenaline Rush», name «Adrenaline Rush», flavor «юдзу, клубника, каламанси».",
  "5. flavor — вкус по-русски, если он указан в тексте ИЛИ точно известен для этого конкретного продукта. Не угадывай; не уверен — \"\".",
  "   Если вкусов несколько — перечисли через « · » с пробелами (клубника · каламанси), а не через запятую.",
  "   Несколько вкусов перечисли через запятую.",
  "6. edition — серия/оформление банки, только если упомянуто в тексте или однозначно следует из названия (Zero, Ultra, лимитка). Иначе \"\".",
  "7. Пустая строка лучше выдуманного значения.",
  "8. Если приложено фото банки — рассмотри его и прочитай бренд, название, вкус и издание с этикетки. Фото важнее черновика и текста.",
  "9. Черновик — уже известные данные о банке (например, из QR-кода). Сохраняй поля черновика, если фото и текст их не уточняют.",
  "   Если поле черновика — явный мусор (например, вкус «энергетический напиток Берн»), исправь его по фото или тексту; если данных нет — верни пустую строку, не копируй мусор.",
].join("\n");

// Разбор отметки для банки, которая уже есть в индексе: название известно заранее,
// поэтому у модели просим только тир и отзыв — и не ругаемся, что нет бренда.
const RATING_PROMPT = [
  "Ты — парсер оценки энергетика. Тебе дают название банки и свободный текст пользователя.",
  'Верни СТРОГО JSON без пояснений и markdown: {"tier":"S|A|B|C|D|null","review":""}',
  "",
  "Правила:",
  "1. review — только мнение самого автора из его текста: коротко (1–3 предложения, по-русски, от первого лица),",
  "   сохраняя его слова и смысл. Ничего не выдумывай. Если мнения нет — review = \"\".",
  "2. tier — только если автор явно оценил: прямо назвал тир (S/A/B/C/D) или однозначно выразил отношение",
  "   (восторг, «лучший» = S; хвалит, «возьму ещё» = A; «норм», «пойдёт» = B; «так себе», «на любителя» = C; ругает, «не бери» = D).",
  "   Если оценки нет — tier = null. Не выводи тир из репутации бренда.",
  "3. Название банки уже известно — не переспрашивай его и не дублируй в отзыве.",
].join("\n");

function normalizeParsed(raw) {
  const parsed = raw && typeof raw === "object" ? raw : {};
  const tierRaw = String(parsed.tier ?? "").trim().toUpperCase();
  const tierGiven = TIERS.includes(tierRaw);
  const clean = {
    brand: String(parsed.brand || "").trim().slice(0, 80),
    name: String(parsed.name || "").trim().slice(0, 120),
    flavor: String(parsed.flavor || "").trim().slice(0, 160),
    edition: String(parsed.edition || "").trim().slice(0, 160),
    review: String(parsed.review || "").trim().slice(0, 600),
    tier: tierGiven ? tierRaw : DEFAULT_TIER,
    tierGuessed: !tierGiven,
  };
  if (!clean.name && clean.brand) clean.name = clean.brand;
  if (!clean.brand && clean.name) clean.brand = clean.name.split(/\s+/)[0];
  return clean;
}

// Поля, которые могли прийти из QR/штрих-кода: ИИ их уточняет, но не теряет.
const DRAFT_FIELDS = ["brand", "name", "flavor", "edition"];

function draftBlock(draft) {
  const source = draft && typeof draft === "object" ? draft : {};
  const labels = { brand: "бренд", name: "название", flavor: "вкус", edition: "издание" };
  const bits = [];
  for (const field of DRAFT_FIELDS) {
    const value = String(source[field] ?? "").trim().slice(0, 160);
    if (value) bits.push(`${labels[field]}: «${value}»`);
  }
  return bits.length ? `Черновик: ${bits.join(", ")}.` : "";
}

// Дополняем ответ модели черновиком: пустое поле не должно стирать данные из QR.
function mergeDraft(parsed, draft) {
  const merged = { ...(parsed && typeof parsed === "object" ? parsed : {}) };
  const source = draft && typeof draft === "object" ? draft : {};
  for (const field of DRAFT_FIELDS) {
    if (String(merged[field] ?? "").trim()) continue;
    const value = String(source[field] ?? "").trim();
    if (value) merged[field] = value;
  }
  return merged;
}

// Фото уходит тем же OpenAI-совместимым сообщением: content-части text + image_url.
function userContent(text, imageDataUrl) {
  if (!imageDataUrl) return text;
  return [
    { type: "text", text },
    { type: "image_url", image_url: { url: imageDataUrl } },
  ];
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest("Base URL должен быть полным адресом, например https://openrouter.ai/api/v1");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw badRequest("Base URL: только http или https");
  if (url.username || url.password) throw badRequest("Base URL не должен содержать логин/пароль");
  if (url.search || url.hash) throw badRequest("Base URL без ?query и #hash");
  return raw;
}

function aiSettings(db) {
  const proxyUrl = getSetting(db, "ai_proxy_url", "") || process.env.AI_PROXY_URL || "";
  const sttKey = getSetting(db, "openrouter_key", "") || process.env.OPENROUTER_KEY || "";
  const parseKey = getSetting(db, "parse_api_key", "") || getSetting(db, "text_api_key", "") || process.env.PARSE_API_KEY || sttKey;
  const parseBaseUrl = getSetting(db, "parse_base_url", "") || getSetting(db, "text_base_url", "") || process.env.PARSE_BASE_URL || getSetting(db, "ai_base_url", "") || process.env.AI_BASE_URL || DEFAULT_BASE_URL;
  const googleCseKey = getSetting(db, "google_cse_key", "") || process.env.GOOGLE_CSE_KEY || "";
  const googleCseCx = getSetting(db, "google_cse_cx", "") || process.env.GOOGLE_CSE_CX || "";
  const geminiKey = getSetting(db, "gemini_api_key", "") || process.env.GEMINI_API_KEY || "";
  return {
    key: sttKey,
    sttKey,
    parseKey,
    model: getSetting(db, "openrouter_model", "") || DEFAULT_MODEL,
    sttModel: getSetting(db, "stt_model", "") || DEFAULT_STT_MODEL,
    baseUrl: parseBaseUrl,
    parseBaseUrl,
    textApiKey: parseKey,
    textBaseUrl: parseBaseUrl,
    sttBaseUrl: DEFAULT_BASE_URL,
    proxyUrl,
    googleCseKey,
    googleCseCx,
    googleCseFromEnv: !getSetting(db, "google_cse_key", "") && Boolean(process.env.GOOGLE_CSE_KEY),
    geminiKey,
    geminiImageModel:
      getSetting(db, "gemini_image_model", "") || process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-lite-image",
    geminiFromEnv: !getSetting(db, "gemini_api_key", "") && Boolean(process.env.GEMINI_API_KEY),
    imageProvider: getSetting(db, "image_provider", "") || DEFAULT_IMAGE_PROVIDER,
    openrouterImageModel: getSetting(db, "openrouter_image_model", "") || DEFAULT_OPENROUTER_IMAGE_MODEL,
    openrouterImageTemplate: getSetting(db, "openrouter_image_template", ""),
    geminiImagePrompt: getSetting(db, "gemini_image_prompt", "") || GEMINI_REDRAW_PROMPT,
    geminiVisionModel: getSetting(db, "gemini_vision_model", "") || process.env.GEMINI_VISION_MODEL || DEFAULT_VISION_MODEL,
    openrouterImagePrompt: getSetting(db, "openrouter_image_prompt", "") || OPENROUTER_REDRAW_PROMPT,
    // все запросы к ИИ-провайдеру идут через этот fetch: прозрачно, с прокси или без
    fetchImpl: proxiedFetch(proxyUrl),
  };
}

const isOpenRouter = (baseUrl) => {
  try {
    return new URL(baseUrl).hostname.endsWith("openrouter.ai");
  } catch {
    return false;
  }
};

function requireKey(key) {
  if (!key) {
    throw new ApiError(503, "API-ключ ИИ не настроен (админка → Настройки)", "ai_not_configured");
  }
}

async function postWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new ApiError(504, "ИИ не ответил вовремя", "ai_timeout");
    const reason = String(error?.message || "").replace(/\s+/g, " ").slice(0, 160);
    throw new ApiError(
      502,
      reason.startsWith("прокси:")
        ? `Не удалось связаться с ИИ через ${reason}`
        : `Не удалось связаться с ИИ-провайдером${reason ? `: ${reason}` : ""}`,
      "ai_failed",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function providerFailureDetail(res, maxLength = 200) {
  let text = "";
  try {
    text = await res.text();
  } catch {
    return "";
  }
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  try {
    const json = JSON.parse(trimmed);
    const fromJson = json?.error?.message || json?.error || json?.message || json?.detail;
    if (fromJson) return String(fromJson).replace(/\s+/g, " ").slice(0, maxLength);
  } catch {
    /* тело не JSON */
  }
  const withoutTags = trimmed
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return withoutTags.slice(0, maxLength);
}

async function providerError(res, what) {
  const detail = await providerFailureDetail(res);
  const error = new ApiError(502, `${what}: HTTP ${res.status} — ${providerHint(res.status)}${detail ? ` (${detail})` : ""}`, "ai_failed");
  error.providerStatus = res.status;
  return error;
}

// Поясняем код провайдера человеческим языком, чтобы в UI было не просто «HTTP 401».
function providerHint(status) {
  if (status === 400) return "провайдер отклонил запрос (проверь модель и URL)";
  if (status === 401) return "ключ ИИ неверный или отозван";
  if (status === 402) return "у провайдера ИИ закончились средства";
  if (status === 403) return "доступ к модели запрещён";
  if (status === 404) return "модель или адрес ИИ не найдены";
  if (status === 408) return "провайдер ИИ не ответил вовремя";
  if (status === 429) return "лимит запросов к ИИ исчерпан";
  if (status >= 500) return "провайдер ИИ недоступен";
  return "провайдер ИИ ответил ошибкой";
}

const authHeaders = (key) => ({
  Authorization: `Bearer ${key}`,
  "X-Title": "NRG/INDEX",
});

// Ориентировочные цены, USD за 1M токенов (вход, выход). Точную стоимость шлёт
// провайдер в usage.cost (OpenRouter) — тогда таблица не нужна.
// ponytail: цены статичны; поправить в одном месте при смене моделей.
const MODEL_PRICES = [
  [/^openai\/gpt-4o-mini$/, [0.15, 0.6]],
  [/^gemini-[\d.]+-flash-lite/, [0.1, 0.4]],
  [/^gemini-[\d.]+-flash(?!-lite)/, [0.3, 2.5]],
];

// Приводит usage провайдера (OpenAI/OpenRouter или Gemini) к одному виду.
function normalizeUsage(raw) {
  const usage = raw && typeof raw === "object" ? raw : {};
  return {
    promptTokens: Number(usage.prompt_tokens ?? usage.promptTokenCount ?? 0) || 0,
    completionTokens: Number(usage.completion_tokens ?? usage.candidatesTokenCount ?? 0) || 0,
    totalTokens: Number(usage.total_tokens ?? usage.totalTokenCount ?? 0) || 0,
    costUsd: Number(usage.cost ?? 0) || 0,
  };
}

// Отчёт провайдера важнее таблицы; нет ни того ни другого — 0 (запрос всё равно посчитан).
function estimateCostUsd(model, usage) {
  if (usage.costUsd > 0) return usage.costUsd;
  const price = MODEL_PRICES.find(([pattern]) => pattern.test(model))?.[1];
  if (!price) return 0;
  return (usage.promptTokens / 1e6) * price[0] + (usage.completionTokens / 1e6) * price[1];
}

async function requestParsedJson(messages, { key, model, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch }) {
  const startedAt = Date.now();
  const res = await postWithTimeout(
    fetchImpl,
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(key) },
      body: JSON.stringify({ model: model || DEFAULT_MODEL, temperature: 0.1, messages }),
    },
    30_000,
  );
  if (!res.ok) throw await providerError(res, "ИИ ответил ошибкой");
  const json = await res.json();
  const raw = String(json?.choices?.[0]?.message?.content || "")
    .replace(/```json|```/g, "")
    .trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  try {
    const parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
    return { parsed, usage: { ...normalizeUsage(json?.usage), ms: Date.now() - startedAt } };
  } catch {
    throw new ApiError(502, "ИИ вернул не JSON, попробуйте переформулировать", "ai_bad_response");
  }
}

// Модели без поддержки картинок отвечают 4xx — тогда повторяем разбор без фото.
const VISION_UNSUPPORTED_STATUSES = new Set([400, 404, 415, 422]);

async function parseDrinkText(text, { key, parseKey, model, baseUrl, parseBaseUrl, draft, imageDataUrl, fetchImpl = fetch, onUsage } = {}) {
  const requestKey = parseKey || key;
  const requestBaseUrl = parseBaseUrl || baseUrl || DEFAULT_BASE_URL;
  requireKey(requestKey);
  const userText = String(text || "").slice(0, 4000);
  const context = draftBlock(draft);
  const prompt = context ? `${context}\nТекст: ${userText}` : userText;
  const request = (content) =>
    requestParsedJson(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
      { key: requestKey, model, baseUrl: requestBaseUrl, fetchImpl },
    );
  let result;
  try {
    result = await request(userContent(prompt, imageDataUrl));
  } catch (error) {
    if (!imageDataUrl || !VISION_UNSUPPORTED_STATUSES.has(error.providerStatus)) throw error;
    result = await request(prompt);
  }
  const clean = normalizeParsed(mergeDraft(result.parsed, draft));
  if (!clean.name) {
    throw new ApiError(502, "Не понял, что за напиток — назови хотя бы бренд", "ai_bad_response");
  }
  const modelUsed = model || DEFAULT_MODEL;
  onUsage?.({ ...result.usage, costUsd: estimateCostUsd(modelUsed, result.usage) }, modelUsed, "parse");
  return clean;
}

// Отметка существующей банки: контекст (бренд/название/вкус) добавляем сами,
// поэтому банка заведомо «известна» и 502 «назови хотя бы бренд» тут не случится.
async function parseRatingText(text, drink = {}, { key, parseKey, model, baseUrl, parseBaseUrl, fetchImpl = fetch, onUsage } = {}) {
  const requestKey = parseKey || key;
  const requestBaseUrl = parseBaseUrl || baseUrl || DEFAULT_BASE_URL;
  requireKey(requestKey);
  const userText = String(text || "").slice(0, 2000);
  const label = [drink.brand, drink.name].filter(Boolean).join(" ").trim() || String(drink.name || "").trim();
  if (!label) throw badRequest("Нужно название банки для разбора отметки");
  const { parsed, usage } = await requestParsedJson(
    [
      { role: "system", content: RATING_PROMPT },
      {
        role: "user",
        content: `Банка: ${label}${drink.flavor ? ` (вкус: ${drink.flavor})` : ""}\nТекст: ${userText}`,
      },
    ],
    { key: requestKey, model, baseUrl: requestBaseUrl, fetchImpl },
  );
  const clean = normalizeParsed(parsed);
  const modelUsed = model || DEFAULT_MODEL;
  onUsage?.({ ...usage, costUsd: estimateCostUsd(modelUsed, usage) }, modelUsed, "parse");
  return { tier: clean.tier, tierGuessed: clean.tierGuessed, review: clean.review };
}

const AUDIO_FORMATS = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
};

function audioFormat(mimeType) {
  const base = String(mimeType || "").split(";")[0].trim().toLowerCase();
  const format = AUDIO_FORMATS[base];
  if (!format) throw badRequest("Неподдерживаемый формат аудио");
  return format;
}

function decodeAudio(base64) {
  const clean = String(base64 || "").replace(/^data:[^,]*,/, "");
  if (!clean || !/^[A-Za-z0-9+/=\s]+$/.test(clean)) throw badRequest("Ожидается аудио в base64");
  const buffer = Buffer.from(clean, "base64");
  if (buffer.length < 200) throw badRequest("Запись слишком короткая");
  if (buffer.length > MAX_AUDIO_BYTES) throw badRequest("Запись слишком длинная (до 5 МБ)");
  return buffer;
}

const STT_CLEANUP_PROMPT = [
  "Ты аккуратно редактируешь результат распознавания русской речи.",
  "Исправь только очевидные ошибки распознавания, регистр и пунктуацию.",
  "Сохрани все исходные слова и смысл. Не добавляй факты, названия, оценки или слова, которых нет в исходнике.",
  "Если фраза неясна, оставь сомнительный фрагмент как есть. Верни только JSON без markdown: {\\\"text\\\":\\\"...\\\"}.",
].join("\n");

async function refineTranscription(text, { parseKey, textApiKey, parseBaseUrl, textBaseUrl, parseModel, model, fetchImpl = fetch, onUsage } = {}) {
  const key = parseKey || textApiKey;
  if (!key) return text;
  const baseUrl = parseBaseUrl || textBaseUrl || DEFAULT_BASE_URL;
  const modelUsed = parseModel || model || DEFAULT_MODEL;
  const { parsed: result, usage } = await requestParsedJson(
    [
      { role: "system", content: STT_CLEANUP_PROMPT },
      { role: "user", content: String(text).slice(0, 2000) },
    ],
    { key, model: modelUsed, baseUrl, fetchImpl },
  );
  onUsage?.({ ...usage, costUsd: estimateCostUsd(modelUsed, usage) }, modelUsed, "cleanup");
  const cleaned = String(result?.text ?? "").trim();
  if (!cleaned) throw new ApiError(502, "Модель исправления STT вернула пустой текст", "ai_bad_response");
  return cleaned.slice(0, 2000);
}

async function transcribeAudio(buffer, mimeType, { key, sttKey, sttModel, sttBaseUrl, baseUrl, parseKey, textApiKey, parseBaseUrl, textBaseUrl, parseModel, model: textModel, fetchImpl = fetch, onUsage, onError } = {}) {
  key = sttKey || key;
  const effectiveBaseUrl = sttBaseUrl || baseUrl || DEFAULT_BASE_URL;
  requireKey(key);
  const format = audioFormat(mimeType);
  const sttModelEffective = sttModel || DEFAULT_STT_MODEL;
  const url = `${effectiveBaseUrl}/audio/transcriptions`;
  let init;
  if (isOpenRouter(effectiveBaseUrl)) {
    init = {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(key) },
      body: JSON.stringify({
        model: sttModelEffective,
        input_audio: { data: buffer.toString("base64"), format },
        language: "ru",
        temperature: 0,
      }),
    };
  } else {
    // OpenAI-совместимые провайдеры принимают multipart/form-data
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: String(mimeType).split(";")[0] }), `voice.${format}`);
    form.append("model", sttModelEffective);
    form.append("language", "ru");
    form.append("temperature", "0");
    init = { method: "POST", headers: authHeaders(key), body: form };
  }
  const startedAt = Date.now();
  const res = await postWithTimeout(fetchImpl, url, init, 60_000);
  if (!res.ok) throw await providerError(res, "Распознавание речи не удалось");
  const json = await res.json();
  const text = String(json?.text || "").trim();
  if (!text) throw new ApiError(422, "В записи не удалось разобрать речь", "stt_empty");
  // Whisper не отдаёт токены — пишем запрос с нулями: счётчик запросов важен сам по себе.
  const sttUsage = { ...normalizeUsage(json?.usage), ms: Date.now() - startedAt };
  onUsage?.({ ...sttUsage, costUsd: estimateCostUsd(sttModelEffective, sttUsage) }, sttModelEffective, "stt");
  const rawText = text.slice(0, 2000);
  // Чистка речи — косметика: провайдер может быть не настроен, недоступен или
  // вернуть пустое. Тогда отдаём сырую расшифровку Whisper, а не валим ввод 502-й.
  try {
    return await refineTranscription(rawText, {
      parseKey,
      textApiKey,
      parseBaseUrl,
      textBaseUrl,
      parseModel,
      model: parseModel || textModel,
      fetchImpl,
      onUsage,
    });
  } catch (error) {
    console.warn("[nrgindex] stt cleanup skipped:", error?.message || error);
    onError?.(error, "cleanup");
    return rawText;
  }
}

const PHOTO_UA = "NRGIndex/2.0 (energy drink tier list)";
const PHOTO_TIMEOUT_MS = 8000;
const PHOTO_LIMIT = 24;
const RASTER_MIME = /^image\/(jpeg|png|webp)$/;

// Разбивает поля на уникальные слова без спецсимволов поискового синтаксиса.
function photoTerms(...parts) {
  const seen = new Set();
  const words = [];
  for (const word of parts.join(" ").split(/\s+/)) {
    const clean = word.replace(/[^\p{L}\p{N}'.-]/gu, "").slice(0, 40);
    const key = clean.toLowerCase();
    if (clean.length < 2 || seen.has(key)) continue;
    seen.add(key);
    words.push(clean);
  }
  return words.slice(0, 12).join(" ");
}

async function fetchJson(fetchImpl, url) {
  const res = await fetchImpl(url, {
    headers: { "user-agent": PHOTO_UA, accept: "application/json" },
    signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const lowerWords = (text) =>
  String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);

// Open Food Facts: фронтальные фото упаковок. Фильтр категории режет слишком много
// (у половины банок её нет), поэтому ищем шире, отсекаем чужие бренды и
// поднимаем выше те, где в названии совпали слова названия/вкуса.
async function searchOpenFoodFacts(terms, brand, fetchImpl) {
  const data = await fetchJson(
    fetchImpl,
    `https://search.openfoodfacts.org/search?q=${encodeURIComponent(terms)}` +
      "&page_size=30&fields=code,product_name,brands,image_front_url",
  );
  const brandWords = lowerWords(brand);
  const wanted = new Set(lowerWords(terms).filter((word) => !brandWords.includes(word)));
  return (data?.hits || [])
    .filter((hit) => /^https:\/\/images\.openfoodfacts\.org\//.test(hit?.image_front_url || ""))
    .map((hit, order) => {
      const brands = [].concat(hit.brands || []).join(", ");
      const name = String(hit.product_name || "");
      const nameWords = lowerWords(name);
      const brandMatches = lowerWords(brands).filter((word) => brandWords.includes(word)).length;
      const score = nameWords.filter((word) => wanted.has(word)).length + brandMatches * 3;
      return { hit, brands, name, score, order };
    })
    .filter(({ brands }) => {
      if (!brandWords.length) return true;
      const have = lowerWords(brands);
      return brandWords.some((word) => have.includes(word));
    })
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ hit, brands, name }) => ({
      url: hit.image_front_url,
      title: [brands, name].filter(Boolean).join(" · ").slice(0, 120),
      source: "openfoodfacts",
    }));
}

// Слова в названии/описании файла, намекающие на стоковый снимок на белом/прозрачном фоне.
const STOCK_HINT = /white[\s_-]*background|transparent|isolated|cut[\s_-]*out|packshot|product[\s_-]*shot|на[\s_]*белом|прозрачн/i;

// Отдельные «стоковые» запросы в Commons (filemime:png, "white background") проверял —
// тянут мусор (скриншоты, ожоги), а OR там ломает выдачу. Поэтому один запрос,
// а сток определяет браузер по пикселям рамки; stockHint только поднимает кандидатов.
async function searchWikimedia(terms, fetchImpl) {
  const data = await fetchJson(
    fetchImpl,
    "https://commons.wikimedia.org/w/api.php?action=query&format=json" +
      `&generator=search&gsrsearch=${encodeURIComponent(`${terms} energy drink`)}` +
      "&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=url%7Cmime&iiurlwidth=480",
  );
  return Object.values(data?.query?.pages || {})
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((page) => ({ page, info: page?.imageinfo?.[0] }))
    .filter(({ info }) => info && RASTER_MIME.test(info.mime || ""))
    .map(({ page, info }, order) => {
      const title = String(page.title || "").replace(/^File:/, "").replace(/\.\w+$/, "").slice(0, 120);
      const wanted = new Set(lowerWords(terms));
      const relevance = lowerWords(title).filter((word) => wanted.has(word)).length;
      return {
        url: info.thumburl || info.url,
        title,
        source: "wikimedia",
        // PNG на Commons почти всегда вырезка с альфой; плюс явные слова в названии
        stockHint: info.mime === "image/png" || STOCK_HINT.test(page.title || ""),
        relevance,
        order,
      };
    })
    .filter((item) => /^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(item.url));
}



// DuckDuckGo без ключа: сначала страница забирает токен vqd, потом i.js отдаёт JSON.
// Best-effort фолбэк: с серверных сетей Дак часто отвечает бот-стеной —
// тогда allSettled роняет источник молча, остальные отдают своё.
// Отдельный браузерный UA: дефолтный NRGIndex/2.0 Дак режет чаще.
const DDG_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function searchDuckDuckGo(terms, fetchImpl = fetch) {
  const query = `${terms} energy drink can`;
  const pageRes = await fetchImpl(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iar=images&iax=images&ia=images`, {
    headers: { "user-agent": DDG_UA, accept: "text/html" },
    signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
  });
  if (!pageRes.ok) throw new Error(`DuckDuckGo: HTTP ${pageRes.status}`);
  const page = await pageRes.text();
  const vqd = page.match(/vqd=["']([^"']+)["']/)?.[1];
  if (!vqd) throw new Error("DuckDuckGo: нет vqd-токена");
  const jsRes = await fetchImpl(
    `https://i.duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}` +
      `&vqd=${encodeURIComponent(vqd)}&f=,,,&p=1`,
    {
      headers: { "user-agent": DDG_UA, accept: "application/json" },
      signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
    },
  );
  if (!jsRes.ok) throw new Error(`DuckDuckGo: HTTP ${jsRes.status}`);
  const data = await jsRes.json();
  const wanted = new Set(lowerWords(terms));
  return (Array.isArray(data) ? data : data?.results || [])
    .filter((item) => /^https?:\/\//.test(item?.image || ""))
    .map((item, order) => {
      const title = String(item.title || item.source || "").slice(0, 120);
      const relevance = lowerWords(title).filter((word) => wanted.has(word)).length;
      return {
        url: item.image,
        title,
        source: "duckduckgo",
        stockHint: STOCK_HINT.test(title),
        relevance,
        order,
      };
    });
}

// Google Programmable Search (Custom Search JSON API): searchType=image.
// Бесплатно 100 запросов/день — при ~10/день хватает. Без ключа не работает:
// обычный поиск без ключа это скрапинг tbm=isch (429, капча, бан IP), в прод нельзя.
async function searchGoogleCse(terms, { key, cx, fetchImpl = fetch } = {}) {
  if (!key || !cx) throw new Error("Google CSE не настроен");
  const url =
    "https://www.googleapis.com/customsearch/v1" +
    `?q=${encodeURIComponent(`${terms} energy drink can`)}` +
    `&cx=${encodeURIComponent(cx)}&key=${encodeURIComponent(key)}` +
    "&searchType=image&num=10&safe=active";
  const res = await fetchImpl(url, {
    headers: { "user-agent": PHOTO_UA, accept: "application/json" },
    signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
  });
  if (!res.ok) {
    // У Google внятные коды: 400 — плохой запрос/CX, 403 — ключ/лимит, 429 — квота.
    const detail = await providerFailureDetail(res);
    const error = new Error(`Google CSE: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    error.status = res.status;
    error.details = error.message;
    throw error;
  }
  const data = await res.json();
  const wanted = new Set(lowerWords(terms));
  return (data?.items || [])
    .filter((item) => /^https?:\/\//.test(item?.link || ""))
    .map((item, order) => {
      const title = String(item.title || item.displayLink || "").slice(0, 120);
      const relevance = lowerWords(`${item.title || ""} ${item.snippet || ""}`).filter((word) =>
        wanted.has(word),
      ).length;
      return {
        url: item.link,
        title,
        source: "google",
        stockHint: STOCK_HINT.test(`${item.title || ""} ${item.snippet || ""}`),
        relevance,
        order,
      };
    });
}

/**
 * Ищет фото банки по бренду, названию и вкусу.
 * Принимает строку (старый формат) или { brand, name, flavor }.
 * Источники опрашиваются параллельно; упавший источник не валит весь поиск.
 * Google CSE — первым источником, если заданы key+cx; DuckDuckGo без ключа —
 * всегда вторым (best-effort: Дак с серваков часто режут, тогда молча OFF+Wiki).
 */
async function searchCanImages(query, { fetchImpl = fetch, proxyFetchImpl, googleKey = "", googleCx = "" } = {}) {
  const fields = typeof query === "string" ? { name: query } : query || {};
  const product = photoTerms(fields.brand || "", fields.name || "");
  const full = photoTerms(fields.brand || "", fields.name || "", fields.flavor || "");
  if (!full) return [];

  // Гугл и Дак — через прокси как ИИ (напрямую из ДЦ их часто режут),
  // OFF+Wiki ходят напрямую как раньше.
  const webFetch = proxyFetchImpl || fetchImpl;
  const tasks = [
    searchDuckDuckGo(full, webFetch),
    searchOpenFoodFacts(full, fields.brand || "", fetchImpl),
    searchWikimedia(product || full, fetchImpl),
  ];
  if (googleKey && googleCx) {
    tasks.unshift(searchGoogleCse(full, { key: googleKey, cx: googleCx, fetchImpl: webFetch }));
  }
  const settled = await Promise.allSettled(tasks);
  if (settled.every((item) => item.status === "rejected")) {
    throw new ApiError(502, "Поиск фото недоступен", "photo_search_failed");
  }
  const seen = new Map();
  const results = [];
  for (const item of settled) {
    if (item.status !== "fulfilled") continue;
    for (const hit of item.value) {
      if (!hit?.url) continue;
      const canonicalUrl = String(hit.url).split("?")[0];
      const clean = { url: hit.url, title: hit.title, source: hit.source, stockHint: Boolean(hit.stockHint), relevance: Number(hit.relevance) || 0 };
      const prev = seen.get(canonicalUrl);
      if (prev) {
        prev.stockHint ||= clean.stockHint;
        continue;
      }
      seen.set(canonicalUrl, clean);
      results.push(clean);
    }
  }
  // Google — вперёд (лучшее качество), Дак вторым, затем кандидаты в сток.
  // Окончательно фон проверяет браузер по пикселям рамки,
  // а stockHint лишь поднимает вероятные варианты, чтобы они влезли в лимит.
  const weight = (hit) => (hit.source === "google" ? 2 : hit.source === "duckduckgo" ? 1 : 0) + (hit.stockHint ? 1 : 0);
  return results
    .map((hit, order) => ({ hit, order }))
    .sort((a, b) => weight(b.hit) - weight(a.hit) || a.order - b.order)
    .map(({ hit }) => hit)
    .slice(0, PHOTO_LIMIT);
}

module.exports = {
  parseDrinkText,
  parseRatingText,
  normalizeParsed,
  normalizeBaseUrl,
  normalizeUsage,
  estimateCostUsd,
  providerFailureDetail,
  transcribeAudio,
  refineTranscription,
  decodeAudio,
  audioFormat,
  aiSettings,
  searchCanImages,
  searchGoogleCse,
  searchDuckDuckGo,
  photoTerms,
  TIERS,
  SYSTEM_PROMPT,
  STT_CLEANUP_PROMPT,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_STT_MODEL,
  DEFAULT_IMAGE_PROVIDER,
  IMAGE_PROVIDERS,
  MAX_AUDIO_BYTES,
};
