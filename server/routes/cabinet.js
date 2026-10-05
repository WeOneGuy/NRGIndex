const express = require("express");
const { notFound, tooMany, badRequest } = require("../lib/errors");
const { str, oneOf, imageFromDataUrl } = require("../lib/validate");
const {
  parseDrinkText,
  parseRatingText,
  transcribeAudio,
  decodeAudio,
  aiSettings,
  estimateCostUsd,
  searchCanImages,
  TIERS,
} = require("../lib/ai");
const { saveProcessedImage, saveAvatarImage, deleteUpload } = require("../lib/images");
const { redrawCanOnWhite, recognizeAssortment } = require("../lib/gemini");
const { redrawCanOnTransparent, templateDataUrlFromUpload } = require("../lib/openrouter-image");
const {
  parseScanCode,
  barcodeField,
  lookupOpenFoodFacts,
  lookupChestnyZnak,
  lookupTrueMark,
  lookupBarcodeList,
  decodeBarcodeImage,
} = require("../lib/barcode");
const { recordAiUsage, writeAudit } = require("../db");
const history = require("../lib/history");
  const {
    ACCENTS,
    touchContent,
    uniqueSlug,
    ratingsForDrink,
    relationsForDrink,
    findSimilarDrinks,
    matchWords,
  } = require("../lib/content");
const { drinkToAdmin, userToApi } = require("../lib/serialize");

// base нужен для PATCH: неуказанные поля не сбрасываются в дефолт, а остаются как были.
// Тир и отзыв сюда не входят: их частичная правка живёт рядом с рейтингом.
function drinkFields(body, base = {}) {
  return {
    brand: str(body?.brand ?? base.brand, "Бренд", { max: 80 }),
    name: str(body?.name ?? base.name, "Название", { max: 120 }),
    flavor: str(body?.flavor ?? base.flavor ?? "", "Вкус", { required: false, max: 160 }),
    edition: str(body?.edition ?? base.edition ?? "", "Издание", { required: false, max: 160 }),
  };
}

module.exports = (db, auth, config) => {
  const router = express.Router();
  const aiUsage = new Map();
  const AI_LIMIT = 40;
  const AI_WINDOW_MS = 60 * 60 * 1000;

  function checkAiLimit(userId) {
    const now = Date.now();
    const entry = aiUsage.get(userId);
    if (!entry || entry.resetAt < now) {
      aiUsage.set(userId, { count: 1, resetAt: now + AI_WINDOW_MS });
      return;
    }
    entry.count += 1;
    if (entry.count > AI_LIMIT) throw tooMany("Лимит ИИ-запросов: 40 в час");
  }

  const barcodeUsage = new Map();
  const BARCODE_LIMIT = 120;
  // Живой фолбэк шлёт кадры чаще поиска по коду — отдельный, более щедрый лимит.
  const scanUsage = new Map();
  const BARCODE_SCAN_LIMIT = 600;
  const barcodeCache = new Map();
  const BARCODE_CACHE_MS = 30 * 60 * 1000;
  const BARCODE_CACHE_MAX = 300;

  function checkBarcodeLimit(userId) {
    const now = Date.now();
    const entry = barcodeUsage.get(userId);
    if (!entry || entry.resetAt < now) {
      barcodeUsage.set(userId, { count: 1, resetAt: now + AI_WINDOW_MS });
      return;
    }
    entry.count += 1;
    if (entry.count > BARCODE_LIMIT) throw tooMany("Лимит поиска по коду: 120 в час");
  }

  function checkScanLimit(userId) {
    const now = Date.now();
    const entry = scanUsage.get(userId);
    if (!entry || entry.resetAt < now) {
      scanUsage.set(userId, { count: 1, resetAt: now + AI_WINDOW_MS });
      return;
    }
    entry.count += 1;
    if (entry.count > BARCODE_SCAN_LIMIT) throw tooMany("Лимит распознавания кадров: 600 в час");
  }

  function findDrink(slug) {
    const drink = db.prepare("SELECT * FROM drinks WHERE slug = ?").get(slug);
    if (!drink) throw notFound("Напиток не найден");
    return drink;
  }

  // Бренд для находки из внешней базы: ищем известный бренд из индекса среди слов
  // названия (matchWords учитывает транслит: «энерг. напиток BURN 0.449» → burn).
  function guessBrand(db, name) {
    const words = new Set(matchWords(name));
    if (!words.size) return "";
    let best = "";
    let bestWords = 0;
    for (const { brand } of db.prepare("SELECT DISTINCT brand FROM drinks WHERE brand <> ''").all()) {
      const brandWords = matchWords(brand);
      if (!brandWords.length || !brandWords.every((word) => words.has(word))) continue;
      if (brandWords.length > bestWords || (brandWords.length === bestWords && brand.length > best.length)) {
        best = brand;
        bestWords = brandWords.length;
      }
    }
    return best;
  }

  const userRow = (user) => ({ id: user.id, username: user.username, display_name: user.displayName });

  router.get("/me", (req, res) => {
    const ratings = db
      .prepare(
        `SELECT d.slug AS drink, d.name, d.flavor, d.image_path AS image, r.tier_id AS tier, r.review
         FROM ratings r JOIN drinks d ON d.id = r.drink_id
         WHERE r.user_id = ? ORDER BY r.updated_at DESC, d.id DESC`,
      )
      .all(req.user.id)
      .map((row) => ({ ...row, image: row.image || "assets/favicon.svg" }));
    const added = db
      .prepare("SELECT id, slug FROM drinks WHERE created_by = ? ORDER BY id DESC")
      .all(req.user.id);
    res.json({ user: req.user, ratings, addedDrinks: added });
  });

  // Свой аватар: квадратный кроп, хранится в uploads. Старый файл удаляем, чтобы
  // замена не оставляла мусор, а невалидная картинка не подменяла текущую.
  router.put("/avatar", async (req, res) => {
    const remove = req.body?.removeAvatar === true;
    const before = db.prepare("SELECT avatar_path FROM users WHERE id = ?").get(req.user.id);
    let avatarPath = "";
    if (!remove) {
      const image = await saveAvatarImage(config.uploadsDir, req.body?.imageDataUrl, config.maxUploadBytes);
      avatarPath = image.path;
    }
    db.prepare("UPDATE users SET avatar_path = ?, updated_at = datetime('now') WHERE id = ?").run(
      avatarPath,
      req.user.id,
    );
    if (before?.avatar_path && before.avatar_path !== avatarPath) {
      deleteUpload(config.uploadsDir, before.avatar_path);
    }
    res.json({ user: userToApi(db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id)) });
  });

  router.put("/ratings/:slug", (req, res) => {
    const drink = findDrink(req.params.slug);
    const tier = oneOf(String(req.body?.tier || ""), TIERS, "Тир");
    const review = str(req.body?.review ?? "", "Отзыв", { required: false, max: 1000 });
    // Оценка и запись в журнал — одной транзакцией: сбой аудита не оставит
    // оценку без следа или 500 при уже изменённой базе.
    db.transaction(() => {
      const before = history.snapRating(db, drink.id, req.user.id);
      db.prepare(
        `INSERT INTO ratings (drink_id, user_id, tier_id, review) VALUES (?, ?, ?, ?)
         ON CONFLICT(drink_id, user_id)
         DO UPDATE SET tier_id = excluded.tier_id, review = excluded.review, updated_at = datetime('now')`,
      ).run(drink.id, req.user.id, tier, review);
      history.recordRating(db, req.user, "rating.set", {
        drink,
        user: userRow(req.user),
        before,
        after: history.snapRating(db, drink.id, req.user.id),
      });
      touchContent(db);
    })();
    res.json({ ok: true });
  });

  router.delete("/ratings/:slug", (req, res) => {
    const drink = findDrink(req.params.slug);
    const before = history.snapRating(db, drink.id, req.user.id);
    if (!before) throw notFound("Оценки нет");
    db.transaction(() => {
      db.prepare("DELETE FROM ratings WHERE drink_id = ? AND user_id = ?").run(drink.id, req.user.id);
      history.recordRating(db, req.user, "rating.delete", { drink, user: userRow(req.user), before, after: null });
      touchContent(db);
    })();
    res.json({ ok: true });
  });

  router.post("/drinks", async (req, res) => {
    const fields = drinkFields(req.body);
    const tier = oneOf(String(req.body?.tier || "B"), TIERS, "Тир");
    const review = str(req.body?.review ?? "", "Отзыв", { required: false, max: 1000 });
    const barcode = barcodeField(req.body?.barcode);

    // Защита от дублей на сервере: клиентские галочки можно обойти, поэтому
    // перепроверяем сами. Точный штрих-код или заметная похожесть блокируют
    // создание, пока не придёт явное «это другой энергос» (confirmDifferent).
    // Скрытые банки тоже учитываем — иначе дубль заведётся рядом с черновиком.
    const barcodeMatch = barcode
      ? db
          .prepare("SELECT slug, brand, name, flavor, image_path, is_published FROM drinks WHERE barcode = ?")
          .get(barcode)
      : null;
    const similar = findSimilarDrinks(db, fields, { limit: 3, min: 0.6, includeHidden: true });
    if (barcodeMatch && !similar.some((drink) => drink.slug === barcodeMatch.slug)) {
      similar.unshift({
        slug: barcodeMatch.slug,
        brand: barcodeMatch.brand,
        name: barcodeMatch.name,
        flavor: barcodeMatch.flavor,
        image: barcodeMatch.image_path || "assets/favicon.svg",
        score: 1,
        confidence: "high",
        reason: "штрих-код совпал",
        hidden: !barcodeMatch.is_published,
      });
    }
    if (similar.length && req.body?.confirmDifferent !== true) {
      return res.status(409).json({
        error: "Похоже, такой энергос уже в индексе. Открой похожую банку — или подтверди, что это новая.",
        code: "duplicate",
        similar,
      });
    }

    const image = req.body?.imageDataUrl
      ? await saveProcessedImage(config.uploadsDir, req.body.imageDataUrl, config.maxUploadBytes)
      : null;
    const accent =
      image?.accent ||
      ACCENTS[db.prepare("SELECT COUNT(*) AS n FROM drinks").get().n % ACCENTS.length];
    const slug = uniqueSlug(db, `${fields.brand}-${fields.flavor || fields.name}`);

    const create = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO drinks (slug, brand, name, flavor, edition, image_path, source_label, accent_a, accent_b, is_published, created_by, image_width, image_height, image_srcset, barcode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          slug,
          fields.brand,
          fields.name,
          fields.flavor,
          fields.edition,
          image?.path || "",
          `добавил ${req.user.displayName}`,
          accent[0],
          accent[1],
          req.user.id,
          image?.width || 0,
          image?.height || 0,
          image?.srcset || "",
          barcode,
        );
      const id = info.lastInsertRowid;
      db.prepare("INSERT INTO ratings (drink_id, user_id, tier_id, review) VALUES (?, ?, ?, ?)").run(
        id,
        req.user.id,
        tier,
        review,
      );
      // Запись и аудит — одной транзакцией.
      history.recordDrink(db, req.user, "drink.create", null, history.snapDrink(db, id));
      touchContent(db);
      return id;
    });

    const id = create();
    const row = db.prepare("SELECT * FROM drinks WHERE id = ?").get(id);
    res.status(201).json({ drink: drinkToAdmin(row, ratingsForDrink(db, id), relationsForDrink(db, id)) });
  });

  router.patch("/drinks/:slug", async (req, res) => {
    const drink = findDrink(req.params.slug);
    const isOwner = drink.created_by === req.user.id;
    const canEditAny = req.user.role === "admin" || req.user.role === "editor";
    if (!isOwner && !canEditAny) throw notFound("Напиток не найден");

    const fields = drinkFields(req.body, drink);
    const image = req.body?.imageDataUrl
      ? await saveProcessedImage(config.uploadsDir, req.body.imageDataUrl, config.maxUploadBytes)
      : null;
    const imagePath = image ? image.path : drink.image_path;
    const accentA = image ? image.accent[0] : drink.accent_a;
    const accentB = image ? image.accent[1] : drink.accent_b;
    const imageWidth = image ? image.width : drink.image_width || 0;
    const imageHeight = image ? image.height : drink.image_height || 0;
    const imageSrcset = image ? image.srcset : drink.image_srcset || "";
    const barcode = req.body?.barcode === undefined ? drink.barcode || "" : barcodeField(req.body.barcode);

    db.transaction(() => {
      const before = history.snapDrink(db, drink.id);
      db.prepare(
        `UPDATE drinks SET brand = ?, name = ?, flavor = ?, edition = ?, image_path = ?,
           accent_a = ?, accent_b = ?, image_width = ?, image_height = ?, image_srcset = ?, barcode = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(fields.brand, fields.name, fields.flavor, fields.edition, imagePath, accentA, accentB, imageWidth, imageHeight, imageSrcset, barcode, drink.id);
      // Частичный патч: неуказанный тир/отзыв сохраняем, а не сбрасываем в «B»/«».
      if (req.body?.tier !== undefined || req.body?.review !== undefined) {
        const current = history.snapRating(db, drink.id, req.user.id);
        const tier =
          req.body?.tier === undefined ? current?.tier_id || "B" : oneOf(String(req.body.tier), TIERS, "Тир");
        const review =
          req.body?.review === undefined
            ? current?.review || ""
            : str(req.body.review, "Отзыв", { required: false, max: 1000 });
        const ratingBefore = current;
        db.prepare(
          `INSERT INTO ratings (drink_id, user_id, tier_id, review) VALUES (?, ?, ?, ?)
           ON CONFLICT(drink_id, user_id)
           DO UPDATE SET tier_id = excluded.tier_id, review = excluded.review, updated_at = datetime('now')`,
        ).run(drink.id, req.user.id, tier, review);
        const ratingAfter = history.snapRating(db, drink.id, req.user.id);
        if (JSON.stringify(ratingBefore) !== JSON.stringify(ratingAfter)) {
          history.recordRating(db, req.user, "rating.set", {
            drink: { ...drink, name: fields.name },
            user: userRow(req.user),
            before: ratingBefore,
            after: ratingAfter,
          });
        }
      }
      history.recordDrink(db, req.user, "drink.update", before, history.snapDrink(db, drink.id));
      touchContent(db);
    })();
    const row = db.prepare("SELECT * FROM drinks WHERE id = ?").get(drink.id);
    res.json({ drink: drinkToAdmin(row, ratingsForDrink(db, drink.id), relationsForDrink(db, drink.id)) });
  });

  router.delete("/drinks/:slug", (req, res) => {
    const drink = findDrink(req.params.slug);
    const isOwner = drink.created_by === req.user.id;
    const canEditAny = req.user.role === "admin" || req.user.role === "editor";
    if (!isOwner && !canEditAny) throw notFound("Напиток не найден");
    const before = history.snapDrink(db, drink.id, { full: true });
    db.prepare("DELETE FROM drinks WHERE id = ?").run(drink.id);
    history.recordDrink(db, req.user, "drink.delete", before, null);
    touchContent(db);
    res.json({ ok: true });
  });

  router.put("/drinks/:slug/photo", async (req, res) => {
    const drink = findDrink(req.params.slug);
    const remove = req.body?.removeImage === true;
    const dataUrl = req.body?.imageDataUrl;
    if (!remove && typeof dataUrl !== "string") {
      throw badRequest("Нужна картинка (imageDataUrl) или removeImage: true");
    }
    const image = remove ? null : await saveProcessedImage(config.uploadsDir, dataUrl, config.maxUploadBytes);
    db.transaction(() => {
      const before = history.snapDrink(db, drink.id);
      db.prepare(
        `UPDATE drinks SET image_path = ?, accent_a = ?, accent_b = ?, image_width = ?, image_height = ?,
           image_srcset = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(
        image ? image.path : "",
        image ? image.accent[0] : drink.accent_a,
        image ? image.accent[1] : drink.accent_b,
        image ? image.width : 0,
        image ? image.height : 0,
        image ? image.srcset : "",
        drink.id,
      );
      history.recordDrink(db, req.user, "drink.update", before, history.snapDrink(db, drink.id));
      touchContent(db);
    })();
    res.json({
      ok: true,
      image: image ? image.path : "",
      accent: image ? image.accent : [drink.accent_a, drink.accent_b],
      width: image ? image.width : 0,
      height: image ? image.height : 0,
    });
  });

  router.post("/ai/parse", async (req, res) => {
    checkAiLimit(req.user.id);
    const text = str(req.body?.text, "Текст", { min: 2, max: 2000 });
    // Учёт ИИ-расходов: onUsage приходит из библиотеки с готовой ценой
    const trackAi = (usage, model, kind) => recordAiUsage(db, req.user.id, kind, model, usage);
    // Отметка существующей банки: название приходит с клиента, у модели просим
    // только тир и отзыв. Без этого разбор падал 502 «назови хотя бы бренд».
    if (req.body?.drink) {
      const parsed = await parseRatingText(
        text,
        {
          brand: str(req.body.drink.brand ?? "", "Бренд", { required: false, max: 80 }),
          name: str(req.body.drink.name ?? "", "Название", { max: 120 }),
          flavor: str(req.body.drink.flavor ?? "", "Вкус", { required: false, max: 160 }),
        },
        { ...aiSettings(db), onUsage: trackAi },
      );
      return res.json({ parsed, similar: [] });
    }
    // Черновик из QR/штрих-кода: ИИ уточняет его и не теряет при разборе.
    const rawDraft = req.body?.draft && typeof req.body.draft === "object" ? req.body.draft : {};
    const draft = {
      brand: str(rawDraft.brand ?? "", "Бренд", { required: false, max: 80 }),
      name: str(rawDraft.name ?? "", "Название", { required: false, max: 120 }),
      flavor: str(rawDraft.flavor ?? "", "Вкус", { required: false, max: 160 }),
      edition: str(rawDraft.edition ?? "", "Издание", { required: false, max: 160 }),
    };
    // Фото — то же, что видит пользователь в превью; проверяем, что это настоящая картинка.
    const imageDataUrl = str(req.body?.imageDataUrl ?? "", "Фото", { required: false, max: 12 * 1024 * 1024 });
    if (imageDataUrl) imageFromDataUrl(imageDataUrl, { maxBytes: config.maxUploadBytes });
    const parsed = await parseDrinkText(text, { ...aiSettings(db), onUsage: trackAi, draft, imageDataUrl });
    const similar = findSimilarDrinks(db, parsed).map((drink) => ({
      ...drink,
      myTier: db
        .prepare(
          "SELECT r.tier_id AS tier FROM ratings r JOIN drinks d ON d.id = r.drink_id WHERE d.slug = ? AND r.user_id = ?",
        )
        .get(drink.slug, req.user.id)?.tier || null,
    }));
    res.json({ parsed, similar });
  });

  // Сначала индекс, для Data Matrix — TrueMark, затем OFF/CRPT/barcode-list.
  // Нет данных — product: null, не ошибка.
  router.post("/ai/barcode", async (req, res) => {
    checkBarcodeLimit(req.user.id);
    const scan = parseScanCode(str(req.body?.code ?? "", "Код", { max: 300 }));
    const cacheKey = JSON.stringify([req.user.id, scan.kind, scan.gtin, scan.kind === "datamatrix" ? scan.raw : ""]);
    const cached = barcodeCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return res.json(cached.payload);

    const stored = db
      .prepare("SELECT slug, brand, name, flavor, image_path FROM drinks WHERE barcode = ?")
      .get(scan.gtin);
    const ai = aiSettings(db);
    let product = stored
      ? {
          source: "index",
          brand: stored.brand,
          name: stored.name,
          flavor: stored.flavor,
          volume: "",
          image: stored.image_path || "",
          caffeineMg: 0,
          kcal: 0,
          sugarG: 0,
        }
      : null;
    if (!product && scan.kind === "datamatrix") {
      const found = await lookupTrueMark(scan.raw, { fetchImpl: ai.fetchImpl });
      if (found) product = { ...found, volume: "", caffeineMg: 0, kcal: 0, sugarG: 0 };
    }
    if (!product) product = await lookupOpenFoodFacts(scan.gtin, { fetchImpl: ai.fetchImpl }).catch(() => null);
    if (!product && scan.kind === "datamatrix") {
      const crpt = await lookupChestnyZnak(scan.raw, { fetchImpl: ai.fetchImpl });
      if (crpt && !product) product = { ...crpt, volume: "", image: "", caffeineMg: 0, kcal: 0, sugarG: 0 };
    }
    if (!product) {
      // Российские банки в Open Food Facts часто не заведены — смотрим базу
      // штрих-кодов barcode-list.ru: она вытягивает хотя бы верное название.
      const found = await lookupBarcodeList(scan.gtin, { fetchImpl: ai.fetchImpl }).catch(() => null);
      if (found?.name) {
        product = {
          source: "barcode-list",
          brand: guessBrand(db, found.name),
          name: found.name,
          flavor: "",
          volume: "",
          image: "",
          caffeineMg: 0,
          kcal: 0,
          sugarG: 0,
        };
      }
    }

    const myTier = (slug) =>
      db
        .prepare(
          "SELECT r.tier_id AS tier FROM ratings r JOIN drinks d ON d.id = r.drink_id WHERE d.slug = ? AND r.user_id = ?",
        )
        .get(slug, req.user.id)?.tier || null;
    const similar = stored
      ? [
          {
            slug: stored.slug,
            brand: stored.brand,
            name: stored.name,
            flavor: stored.flavor,
            image: stored.image_path || "assets/favicon.svg",
            score: 1,
            confidence: "high",
            reason: "штрих-код совпал",
            hidden: false,
            myTier: myTier(stored.slug),
          },
        ]
      : product
        ? findSimilarDrinks(db, product, { limit: 3, min: 0.6 }).map((drink) => ({ ...drink, myTier: myTier(drink.slug) }))
        : [];

    const payload = {
      code: scan.gtin,
      kind: scan.kind,
      ...(scan.kind === "datamatrix" ? { rawCode: scan.raw } : {}),
      inIndex: stored ? { slug: stored.slug, brand: stored.brand, name: stored.name, flavor: stored.flavor } : null,
      product,
      similar,
    };
    barcodeCache.set(cacheKey, { expiresAt: Date.now() + BARCODE_CACHE_MS, payload });
    if (barcodeCache.size > BARCODE_CACHE_MAX) barcodeCache.delete(barcodeCache.keys().next().value);
    res.json(payload);
  });

  // Распознавание кода с фото на сервере: работает в любом браузере (в Firefox
  // и Safari нет BarcodeDetector), переживает повороты, блики и тени.
  router.post("/ai/barcode-scan", async (req, res) => {
    checkScanLimit(req.user.id);
    const { buffer } = imageFromDataUrl(req.body?.imageDataUrl, { maxBytes: config.maxUploadBytes });
    const found = await decodeBarcodeImage(buffer);
    if (!found?.code) return res.json({ found: false });
    res.json({ found: true, code: found.code, format: found.format });
  });

  router.post("/ai/transcribe", async (req, res) => {
    checkAiLimit(req.user.id);
    const mimeType = str(req.body?.mimeType, "Тип аудио", { max: 100 });
    const buffer = decodeAudio(req.body?.audio);
    const text = await transcribeAudio(buffer, mimeType, {
      ...aiSettings(db),
      onUsage: (usage, model, kind) => recordAiUsage(db, req.user.id, kind, model, usage),
      // Чистка расшифровки падает молча (отдаём сырой текст) — ошибку всё равно пишем в логи.
      onError: (error, kind) => {
        const message = String(error?.message || error).replace(/\s+/g, " ").slice(0, 300);
        writeAudit(db, req.user, `ai.${kind}`, "ai", "", message, {
          summary: `Ошибка чистки расшифровки: ${message}`,
        });
      },
    });
    res.json({ text });
  });

  // Фото полки → список банок от Gemini → матчинг с базой (фото и карточка).
  router.post("/ai/assortment", async (req, res) => {
    checkAiLimit(req.user.id);
    const imageDataUrl = str(req.body?.imageDataUrl ?? "", "Фото", { max: 12 * 1024 * 1024 });
    const ai = aiSettings(db);
    const { items, usage } = await recognizeAssortment(imageDataUrl, {
      key: ai.geminiKey,
      model: ai.geminiVisionModel,
      fetchImpl: ai.fetchImpl,
    });
    recordAiUsage(db, req.user.id, "vision", ai.geminiVisionModel, {
      ...usage,
      costUsd: usage.costUsd || estimateCostUsd(ai.geminiVisionModel, usage),
    });
    res.json({
      items: items.map((item) => {
        const match = findSimilarDrinks(db, item, { limit: 1, min: 0.6 })[0];
        return { ...item, slug: match?.slug || "", image: match?.image || "" };
      }),
    });
  });

  // Поиск фото дёргается на каждую правку полей — свой лимит и короткий кэш,
  // чтобы не съедать ИИ-лимит и не долбить внешние API одинаковыми запросами.
  const photoUsage = new Map();
  const PHOTO_LIMIT = 300;
  const photoCache = new Map();
  const PHOTO_CACHE_MS = 30 * 60 * 1000;
  const PHOTO_CACHE_MAX = 300;

  function checkPhotoLimit(userId) {
    const now = Date.now();
    const entry = photoUsage.get(userId);
    if (!entry || entry.resetAt < now) {
      photoUsage.set(userId, { count: 1, resetAt: now + AI_WINDOW_MS });
      return;
    }
    entry.count += 1;
    if (entry.count > PHOTO_LIMIT) throw tooMany("Лимит поиска фото: 300 в час");
  }

  router.get("/ai/photo-search", async (req, res) => {
    const opt = (key, label) => str(req.query?.[key] ?? "", label, { required: false, max: 120 });
    const fields = {
      brand: opt("brand", "Бренд"),
      name: opt("name", "Название") || opt("q", "Запрос"),
      flavor: opt("flavor", "Вкус"),
    };
    const key = [fields.brand, fields.name, fields.flavor].join("|").toLowerCase().trim();
    if (key.replace(/\|/g, "").length < 2) throw badRequest("Запрос: минимум 2 символа");

    const cached = photoCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return res.json({ images: cached.images });

    checkPhotoLimit(req.user.id);
    const ai = aiSettings(db);
    const images = await searchCanImages(fields, {
      googleKey: ai.googleCseKey,
      googleCx: ai.googleCseCx,
      proxyFetchImpl: ai.fetchImpl,
    });
    if (photoCache.size >= PHOTO_CACHE_MAX) photoCache.delete(photoCache.keys().next().value);
    photoCache.set(key, { images, expiresAt: Date.now() + PHOTO_CACHE_MS });
    res.json({ images });
  });

  // Прокси картинок из поиска: многие сайты режут хотлинк и не отдают CORS,
  // поэтому <img> пустые, а canvas падает. Клиент подменяет src на прокси
  // при ошибке загрузки. Лимит общий с поиском фото.
  const PHOTO_PROXY_MAX_BYTES = 8 * 1024 * 1024;

  router.get("/ai/photo-proxy", async (req, res) => {
    const raw = str(req.query?.url ?? "", "Ссылка", { max: 2000 });
    let target;
    try {
      target = new URL(raw);
    } catch {
      throw badRequest("Некорректная ссылка на картинку");
    }
    if (!["http:", "https:"].includes(target.protocol)) throw badRequest("Только http/https ссылки");
    checkPhotoLimit(req.user.id);
    const ai = aiSettings(db);
    const upstream = await ai.fetchImpl(target.toString(), {
      headers: { "user-agent": "NRGIndex/2.0 (energy drink tier list)", accept: "image/*" },
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) throw badRequest(`Сайт не отдал картинку (HTTP ${upstream.status})`);
    const contentType = String(upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) throw badRequest("Ссылка ведёт не на изображение");
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (!buffer.length || buffer.length > PHOTO_PROXY_MAX_BYTES) {
      throw badRequest("Картинка слишком большая для прокси");
    }
    res.set("content-type", contentType);
    res.set("cache-control", "public, max-age=86400");
    res.send(buffer);
  });

  // Перерисовка банки через Nano Banana: свой фото-лимит (генерация не бесплатная
  // бесконечно, но при ~10/день free tier хватает).
  const redrawUsage = new Map();
  const REDRAW_LIMIT = 20;

  function checkRedrawLimit(userId) {
    const now = Date.now();
    const entry = redrawUsage.get(userId);
    if (!entry || entry.resetAt < now) {
      redrawUsage.set(userId, { count: 1, resetAt: now + AI_WINDOW_MS });
      return;
    }
    entry.count += 1;
    if (entry.count > REDRAW_LIMIT) throw tooMany("Лимит перерисовок: 20 в час");
  }

  router.post("/ai/photo-redraw", async (req, res) => {
    checkRedrawLimit(req.user.id);
    const imageDataUrl = str(req.body?.imageDataUrl ?? "", "Картинка", { max: 12 * 1024 * 1024 });
    const ai = aiSettings(db);
    const viaOpenRouter = ai.imageProvider === "openrouter";
    const model = viaOpenRouter ? ai.openrouterImageModel : ai.geminiImageModel;
    const { imageDataUrl: redrawn, usage } = viaOpenRouter
      ? await redrawCanOnTransparent(imageDataUrl, {
          key: ai.sttKey,
          model,
          prompt: ai.openrouterImagePrompt,
          // шаблон нужен только OpenRouter: битая настройка не должна ломать Gemini
          template: ai.openrouterImageTemplate
            ? templateDataUrlFromUpload(config.uploadsDir, ai.openrouterImageTemplate)
            : undefined,
          baseUrl: ai.sttBaseUrl,
          fetchImpl: ai.fetchImpl,
        })
      : await redrawCanOnWhite(imageDataUrl, {
          key: ai.geminiKey,
          model,
          prompt: ai.geminiImagePrompt,
          fetchImpl: ai.fetchImpl,
        });
    recordAiUsage(db, req.user.id, "redraw", model, usage);
    res.json({ imageDataUrl: redrawn, provider: viaOpenRouter ? "openrouter" : "gemini" });
  });

  return router;
};
