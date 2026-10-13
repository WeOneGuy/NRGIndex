const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { hashPassword } = require("../auth");
const { notFound, badRequest, conflict, forbidden } = require("../lib/errors");
const { str, username, password, oneOf, int, color, idArray, bool, imageFromDataUrl } = require("../lib/validate");
const { writeAudit, getSetting, setSetting } = require("../db");
const { ACCENTS, touchContent, uniqueSlug, ratingsForDrink, relationsForDrink } = require("../lib/content");
const { saveProcessedImage, reprocessStoredImage } = require("../lib/images");
const { userToApi, drinkToAdmin } = require("../lib/serialize");
const { TIERS, aiSettings, DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_STT_MODEL, DEFAULT_IMAGE_PROVIDER, IMAGE_PROVIDERS, normalizeBaseUrl, providerFailureDetail, searchGoogleCse } = require("../lib/ai");
const history = require("../lib/history");
const { normalizeProxyUrl, maskProxyUrl, proxiedFetch } = require("../lib/proxy");
const { checkGeminiKey, DEFAULT_IMAGE_MODEL, DEFAULT_VISION_MODEL, REDRAW_PROMPT: GEMINI_REDRAW_PROMPT } = require("../lib/gemini");
const { DEFAULT_OPENROUTER_IMAGE_MODEL, REDRAW_PROMPT: OPENROUTER_REDRAW_PROMPT } = require("../lib/openrouter-image");

const ROLES = ["admin", "editor", "user"];

const tempPassword = () => crypto.randomBytes(9).toString("base64url");

module.exports = (db, auth, config) => {
  const router = express.Router();
  const isAdmin = (req) => req.user.role === "admin";
  const requireAdmin = (req, res, next) => (isAdmin(req) ? next() : next(forbidden()));

  const activeAdmins = () =>
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").get().n;

  function getUser(id) {
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (!row) throw notFound("Пользователь не найден");
    return row;
  }

  function ensureRelatedExist(relatedIds, selfId) {
    const check = db.prepare("SELECT 1 FROM drinks WHERE id = ?");
    for (const id of relatedIds) {
      if (id !== selfId && !check.get(id)) throw badRequest(`Напиток #${id} не найден`);
    }
  }

  function setRelations(drinkId, relatedIds) {
    ensureRelatedExist(relatedIds, drinkId);
    db.prepare("DELETE FROM drink_relations WHERE drink_id = ?").run(drinkId);
    const insert = db.prepare("INSERT OR IGNORE INTO drink_relations (drink_id, related_id) VALUES (?, ?)");
    for (const relatedId of relatedIds) {
      if (relatedId !== drinkId) insert.run(drinkId, relatedId);
    }
  }

  function drinkFields(body, drink = {}) {
    return {
      brand: str(body?.brand ?? drink.brand, "Бренд", { max: 80 }),
      name: str(body?.name ?? drink.name, "Название", { max: 120 }),
      flavor: str(body?.flavor ?? drink.flavor ?? "", "Вкус", { required: false, max: 160 }),
      edition: str(body?.edition ?? drink.edition ?? "", "Издание", { required: false, max: 160 }),
      sourceLabel: str(body?.sourceLabel ?? drink.source_label ?? "", "Источник", {
        required: false,
        max: 160,
      }),
      accentA: color(body?.accentA ?? drink.accent_a, "Акцент A", null),
      accentB: color(body?.accentB ?? drink.accent_b, "Акцент B", null),
      published: bool(body?.published, Boolean(drink.is_published ?? true)),
    };
  }

  function imageReference(value) {
    const image = str(value ?? "", "Картинка", { required: false, max: 300 });
    if (!image) return image;
    if (image.startsWith("/") || image.startsWith("assets/")) return image;
    let parsed;
    try {
      parsed = new URL(image);
    } catch {
      throw badRequest("Картинка должна быть URL или путём /uploads/... или assets/...");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw badRequest("Картинка должна использовать http:// или https://");
    }
    return parsed.toString();
  }

  router.get("/data", (req, res) => {
    // Батч вместо N+1: оценки и связи тянем двумя запросами на весь список.
    const ratingsByDrink = new Map();
    for (const row of db
      .prepare(
        `SELECT r.drink_id, r.tier_id AS tier, r.review, r.order_index AS "order", u.username
         FROM ratings r JOIN users u ON u.id = r.user_id`,
      )
      .all()) {
      if (!ratingsByDrink.has(row.drink_id)) ratingsByDrink.set(row.drink_id, {});
      ratingsByDrink.get(row.drink_id)[row.username] = { tier: row.tier, review: row.review, order: row.order };
    }
    const relationsByDrink = new Map();
    for (const row of db.prepare("SELECT drink_id, related_id FROM drink_relations").all()) {
      if (!relationsByDrink.has(row.drink_id)) relationsByDrink.set(row.drink_id, []);
      relationsByDrink.get(row.drink_id).push(row.related_id);
    }
    const drinks = db
      .prepare("SELECT * FROM drinks ORDER BY id")
      .all()
      .map((drink) =>
        drinkToAdmin(drink, ratingsByDrink.get(drink.id) || {}, relationsByDrink.get(drink.id) || []),
      );
    const tiers = db
      .prepare("SELECT id, title, note, score, position FROM tiers ORDER BY position, id")
      .all();
    const users = db.prepare("SELECT * FROM users ORDER BY id").all().map(userToApi);
    const ai = aiSettings(db);
    const settings = {
      siteTitle: getSetting(db, "site_title", "NRG / INDEX"),
      siteDescription: getSetting(db, "site_description", ""),
      openrouterModel: ai.model,
      textModel: ai.model,
      sttModel: ai.sttModel,
      aiBaseUrl: ai.baseUrl,
      parseBaseUrl: ai.parseBaseUrl,
      textBaseUrl: ai.parseBaseUrl,
      aiProxyUrl: maskProxyUrl(ai.proxyUrl),
      aiProxyFromEnv: !getSetting(db, "ai_proxy_url", "") && Boolean(process.env.AI_PROXY_URL),
      openrouterKeySet: Boolean(ai.key),
      parseApiKeySet: Boolean(ai.parseKey),
      textApiKeySet: Boolean(ai.parseKey),
      googleCseKeySet: Boolean(ai.googleCseKey),
      googleCseCx: ai.googleCseCx,
      googleCseFromEnv: ai.googleCseFromEnv,
      geminiKeySet: Boolean(ai.geminiKey),
      geminiImageModel: ai.geminiImageModel,
      geminiVisionModel: ai.geminiVisionModel,
      geminiFromEnv: ai.geminiFromEnv,
      imageProvider: ai.imageProvider,
      openrouterImageModel: ai.openrouterImageModel,
      openrouterImageTemplate: ai.openrouterImageTemplate,
      openrouterImagePrompt: ai.openrouterImagePrompt,
      geminiImagePrompt: ai.geminiImagePrompt,
      defaults: { aiBaseUrl: DEFAULT_BASE_URL, parseBaseUrl: DEFAULT_BASE_URL, openrouterModel: DEFAULT_MODEL, sttModel: DEFAULT_STT_MODEL, imageProvider: DEFAULT_IMAGE_PROVIDER, openrouterImageModel: DEFAULT_OPENROUTER_IMAGE_MODEL },
    };
    const audit = isAdmin(req) ? history.listAudit(db) : [];
    const logs = isAdmin(req) ? history.listLogs(db) : [];
    res.json({ me: req.user, drinks, tiers, users, settings, audit, logs });
  });

  const MONTHS_RU = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

  function deviceLabel(userAgent) {
    const ua = String(userAgent || "");
    const os = /Android/i.test(ua)
      ? "Android"
      : /iPhone|iPad|iPod|iOS/i.test(ua)
        ? "iOS"
        : /Windows/i.test(ua)
          ? "Windows"
          : /Mac OS|Macintosh/i.test(ua)
            ? "macOS"
            : /Linux/i.test(ua)
              ? "Linux"
              : "";
    const browser = /Firefox\//.test(ua)
      ? "Firefox"
      : /Edg\//.test(ua)
        ? "Edge"
        : /OPR\//.test(ua)
          ? "Opera"
          : /Chrome\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : /curl/i.test(ua)
                ? "curl"
                : /PowerShell/i.test(ua)
                  ? "PowerShell"
                  : "";
    return [browser, os].filter(Boolean).join(" · ") || "браузер не опознан";
  }

  // Полная статистика для админов: сводка, активность по дням, тиры, топы,
  // онлайн-сессии и последние изменения. Все цифры считает SQLite.
  router.get("/stats", requireAdmin, (req, res) => {
    const days = Math.min(90, Math.max(7, Number(req.query?.days) || 30));
    const since = `-${days - 1} days`;

    const drinks = db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(is_published), 0) AS published FROM drinks")
      .get();
    const users = db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(is_active), 0) AS active, COALESCE(SUM(is_public), 0) AS shared FROM users",
      )
      .get();
    const ratings = db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(TRIM(review) <> ''), 0) AS reviews FROM ratings")
      .get();
    const avgScore = db
      .prepare("SELECT AVG(t.score) AS value FROM ratings r JOIN tiers t ON t.id = r.tier_id")
      .get().value;
    const relations = db.prepare("SELECT COUNT(*) AS n FROM drink_relations").get().n;

    const ratingsByDay = db
      .prepare("SELECT date(updated_at) AS d, COUNT(*) AS n FROM ratings WHERE updated_at >= date('now', ?) GROUP BY d")
      .all(since);
    const createdByDay = db
      .prepare("SELECT date(created_at) AS d, COUNT(*) AS n FROM drinks WHERE created_at >= date('now', ?) GROUP BY d")
      .all(since);
    const loginsByDay = db
      .prepare(
        "SELECT date(created_at) AS d, COUNT(*) AS n, COALESCE(SUM(success), 0) AS ok FROM login_attempts WHERE created_at >= date('now', ?) GROUP BY d",
      )
      .all(since);
    const eventsByDay = db
      .prepare("SELECT date(created_at) AS d, COUNT(*) AS n FROM audit_log WHERE created_at >= date('now', ?) GROUP BY d")
      .all(since);

    const now = new Date();
    const dayRows = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      date.setUTCDate(date.getUTCDate() - i);
      dayRows.push({
        date: date.toISOString().slice(0, 10),
        label: `${date.getUTCDate()} ${MONTHS_RU[date.getUTCMonth()]}`,
        ratings: 0,
        drinks: 0,
        logins: 0,
        failures: 0,
        events: 0,
      });
    }
    const byDate = new Map(dayRows.map((row) => [row.date, row]));
    for (const row of ratingsByDay) if (byDate.has(row.d)) byDate.get(row.d).ratings = row.n;
    for (const row of createdByDay) if (byDate.has(row.d)) byDate.get(row.d).drinks = row.n;
    for (const row of loginsByDay) {
      const item = byDate.get(row.d);
      if (item) {
        item.logins = row.ok;
        item.failures = row.n - row.ok;
      }
    }
    for (const row of eventsByDay) if (byDate.has(row.d)) byDate.get(row.d).events = row.n;

    const tierList = db.prepare("SELECT id, score FROM tiers ORDER BY position, id").all();
    const tierCounts = new Map(
      db.prepare("SELECT tier_id AS tier, COUNT(*) AS n FROM ratings GROUP BY tier_id").all().map((row) => [row.tier, row.n]),
    );
    const tierDistribution = tierList.map((tier) => ({
      tier: tier.id,
      score: tier.score,
      count: tierCounts.get(tier.id) || 0,
    }));

    const topDrinks = db
      .prepare(
        `SELECT d.slug, d.name, d.brand, d.flavor, d.image_path, d.is_published,
                COUNT(r.user_id) AS votes, AVG(t.score) AS avg_score
         FROM drinks d
         LEFT JOIN ratings r ON r.drink_id = d.id
         LEFT JOIN tiers t ON t.id = r.tier_id
         GROUP BY d.id
         HAVING votes > 0
         ORDER BY votes DESC, avg_score DESC
         LIMIT 8`,
      )
      .all()
      .map((row) => ({
        slug: row.slug,
        name: row.name,
        brand: row.brand,
        flavor: row.flavor,
        image: row.image_path || "assets/favicon.svg",
        published: Boolean(row.is_published),
        votes: row.votes,
        avgScore: row.avg_score === null ? null : Math.round(row.avg_score * 10) / 10,
      }));

    const topUsers = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.initials, u.color, u.role,
                (SELECT COUNT(*) FROM ratings r WHERE r.user_id = u.id) AS ratings,
                (SELECT COUNT(*) FROM ratings r WHERE r.user_id = u.id AND TRIM(r.review) <> '') AS reviews,
                (SELECT COUNT(*) FROM drinks d WHERE d.created_by = u.id) AS added,
                (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen
         FROM users u
         WHERE u.is_active = 1
         ORDER BY ratings DESC, added DESC, u.id
         LIMIT 8`,
      )
      .all()
      .map((row) => ({
        username: row.username,
        name: row.display_name,
        initials: row.initials,
        color: row.color,
        role: row.role,
        ratings: row.ratings,
        reviews: row.reviews,
        added: row.added,
        lastSeen: row.last_seen,
      }));

    const online = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.initials, u.color, u.role,
                MAX(s.last_seen_at) AS last_seen, s.ip, s.user_agent
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.last_seen_at > datetime('now', '-15 minutes') AND u.is_active = 1
         GROUP BY u.id
         ORDER BY last_seen DESC`,
      )
      .all()
      .map((row) => ({
        username: row.username,
        name: row.display_name,
        initials: row.initials,
        color: row.color,
        role: row.role,
        ip: row.ip,
        device: deviceLabel(row.user_agent),
        lastSeen: row.last_seen,
      }));

    const recent = db
      .prepare(
        `SELECT a.id, a.action, a.summary, a.details, a.created_at,
                u.display_name, u.initials, u.color
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.id DESC LIMIT 12`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        action: row.action,
        summary: String(row.summary || row.details || "").slice(0, 240),
        at: row.created_at,
        who: row.display_name || "система",
        initials: row.initials || "??",
        color: row.color || "#9fb7ff",
      }));

    const heatmap = db
      .prepare(
        `SELECT CAST(strftime('%w', created_at) AS INTEGER) AS w,
                CAST(strftime('%H', created_at) AS INTEGER) AS h,
                COUNT(*) AS n
         FROM audit_log
         WHERE created_at >= datetime('now', '-90 days')
         GROUP BY w, h`,
      )
      .all();

    // ИИ-расходы: запросы/токены/цена по видам и моделям за период + всего за всё время
    const roundCost = (value) => Math.round((Number(value) || 0) * 1e6) / 1e6;
    const aiKinds = db
      .prepare(
        `SELECT kind, COUNT(*) AS requests,
                COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
                COALESCE(SUM(completion_tokens), 0) AS completionTokens,
                COALESCE(SUM(total_tokens), 0) AS totalTokens,
                COALESCE(SUM(cost_usd), 0) AS costUsd
         FROM ai_usage WHERE created_at >= datetime('now', ?) GROUP BY kind ORDER BY requests DESC`,
      )
      .all(since)
      .map((row) => ({ ...row, costUsd: roundCost(row.costUsd) }));
    const aiModels = db
      .prepare(
        `SELECT model, COUNT(*) AS requests,
                COALESCE(SUM(total_tokens), 0) AS totalTokens,
                COALESCE(SUM(cost_usd), 0) AS costUsd
         FROM ai_usage WHERE created_at >= datetime('now', ?) AND model <> ''
         GROUP BY model ORDER BY requests DESC LIMIT 8`,
      )
      .all(since)
      .map((row) => ({ ...row, costUsd: roundCost(row.costUsd) }));
    const aiAllTime = db
      .prepare(
        `SELECT COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS totalTokens, COALESCE(SUM(cost_usd), 0) AS costUsd
         FROM ai_usage`,
      )
      .get();
    aiAllTime.costUsd = roundCost(aiAllTime.costUsd);

    const sum = (key) => dayRows.reduce((total, row) => total + row[key], 0);
    const bestDay = dayRows.reduce((best, row) => (row.events > (best?.events || 0) ? row : best), null);

    res.json({
      days,
      totals: {
        drinks: drinks.n,
        published: drinks.published,
        hidden: drinks.n - drinks.published,
        users: users.n,
        activeUsers: users.active,
        sharedUsers: users.shared,
        ratings: ratings.n,
        reviews: ratings.reviews,
        relations,
        avgScore: avgScore === null ? null : Math.round(avgScore * 100) / 100,
        ratingsPerDrink: drinks.n ? Math.round((ratings.n / drinks.n) * 10) / 10 : 0,
        ratingsPerUser: users.active ? Math.round((ratings.n / users.active) * 10) / 10 : 0,
      },
      period: {
        days,
        ratings: sum("ratings"),
        drinks: sum("drinks"),
        logins: sum("logins"),
        failures: sum("failures"),
        events: sum("events"),
        bestDay: bestDay && bestDay.events ? { date: bestDay.date, label: bestDay.label, events: bestDay.events } : null,
      },
      days: dayRows,
      tiers: tierDistribution,
      topDrinks,
      topUsers,
      online,
      recent,
      heatmap,
      ai: { kinds: aiKinds, models: aiModels, allTime: aiAllTime },
    });
  });

  // Схема базы для админской карты: таблицы, колонки, ключи, счётчики и размер.
  // Всё тянется из sqlite_master и pragma — новые миграции появляются на карте сами.
  router.get("/database", requireAdmin, (req, res) => {
    const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .filter((row) => TABLE_NAME.test(row.name))
      .map((row) => {
        const TABLE = row.name;
        const count = db.prepare(`SELECT COUNT(*) AS n FROM "${TABLE}"`).get().n;
        const columns = db
          .prepare('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)')
          .all(TABLE)
          .map((column) => ({
            name: column.name,
            type: column.type || "ANY",
            notNull: Boolean(column.notnull),
            pk: Number(column.pk) > 0,
            default: column.dflt_value ?? null,
          }));
        const unique = new Set();
        for (const index of db.prepare('SELECT name, "unique" AS is_unique FROM pragma_index_list(?)').all(TABLE)) {
          const parts = db.prepare("SELECT name FROM pragma_index_info(?)").all(index.name);
          if (index.is_unique && parts.length === 1) unique.add(parts[0].name);
        }
        const foreignKeys = db
          .prepare('SELECT "from" AS column_name, "table" AS ref_table, "to" AS ref_column, on_delete FROM pragma_foreign_key_list(?)')
          .all(TABLE)
          .map((fk) => ({ column: fk.column_name, table: fk.ref_table, columnTo: fk.ref_column, onDelete: fk.on_delete }));
        return {
          name: TABLE,
          count,
          columns: columns.map((column) => ({ ...column, unique: unique.has(column.name) })),
          foreignKeys,
        };
      });
    const sizeBytes = db.pragma("page_count", { simple: true }) * db.pragma("page_size", { simple: true });
    res.json({ userVersion: db.pragma("user_version", { simple: true }), sizeBytes, tables });
  });

  router.post("/audit/:id/undo", requireAdmin, (req, res) => {
    const id = int(req.params.id, "id", { min: 1 });
    const { notes } = history.undoEntry(db, id, { actor: req.user, auth });
    touchContent(db);
    res.json({ ok: true, notes });
  });

  // ---------- drinks (editor+) ----------

  router.post("/drinks", async (req, res) => {
    const fields = drinkFields(req.body);
    const relatedIds = idArray(req.body?.relatedIds, "Похожие", { max: 50 });
    const image = req.body?.imageDataUrl
      ? await saveProcessedImage(config.uploadsDir, req.body.imageDataUrl, config.maxUploadBytes)
      : null;
    const imagePath = image
      ? image.path
      : imageReference(req.body?.image);
    const accent =
      image?.accent ||
      ACCENTS[db.prepare("SELECT COUNT(*) AS n FROM drinks").get().n % ACCENTS.length];
    const slug = uniqueSlug(db, `${fields.brand}-${fields.flavor || fields.name}`);

    const create = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO drinks (slug, brand, name, flavor, edition, image_path, source_label, accent_a, accent_b, is_published, created_by, image_width, image_height, image_srcset)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          slug,
          fields.brand,
          fields.name,
          fields.flavor,
          fields.edition,
          imagePath,
          fields.sourceLabel,
          fields.accentA || accent[0],
          fields.accentB || accent[1],
          fields.published ? 1 : 0,
          req.user.id,
          image?.width || 0,
          image?.height || 0,
          image?.srcset || "",
        );
      const id = info.lastInsertRowid;
      setRelations(id, relatedIds);
      // Запись и аудит — одной транзакцией: сбой журнала не оставит «полу-созданный» напиток.
      history.recordDrink(db, req.user, "admin.drink.create", null, history.snapDrink(db, id));
      touchContent(db);
      return id;
    });

    const id = create();
    const row = db.prepare("SELECT * FROM drinks WHERE id = ?").get(id);
    res.status(201).json({ drink: drinkToAdmin(row, ratingsForDrink(db, id), relationsForDrink(db, id)) });
  });

  router.patch("/drinks/:id", async (req, res) => {
    const id = int(req.params.id, "id", { min: 1 });
    const drink = db.prepare("SELECT * FROM drinks WHERE id = ?").get(id);
    if (!drink) throw notFound("Напиток не найден");
    const before = history.snapDrink(db, id);
    const fields = drinkFields(req.body, drink);
    const image = req.body?.imageDataUrl
      ? await saveProcessedImage(config.uploadsDir, req.body.imageDataUrl, config.maxUploadBytes)
      : null;
    const imagePath = image
      ? image.path
      : req.body?.removeImage
        ? ""
        : drink.image_path;
    const externalImage = req.body?.imageDataUrl ? imagePath : imageReference(req.body?.image ?? imagePath);
    const accentA = fields.accentA || image?.accent?.[0] || drink.accent_a;
    const accentB = fields.accentB || image?.accent?.[1] || drink.accent_b;
    // размеры: новый аплоуд — из него; смена картинки на ассет — сброс (размеры возьмутся из манифеста); иначе оставить
    const imageChanged = externalImage !== drink.image_path;
    const imageWidth = image ? image.width : imageChanged ? 0 : drink.image_width || 0;
    const imageHeight = image ? image.height : imageChanged ? 0 : drink.image_height || 0;
    const imageSrcset = image ? image.srcset : imageChanged ? "" : drink.image_srcset || "";
    db.prepare(
      `UPDATE drinks SET brand = ?, name = ?, flavor = ?, edition = ?, image_path = ?,
         source_label = ?, accent_a = ?, accent_b = ?, is_published = ?, image_width = ?, image_height = ?, image_srcset = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      fields.brand,
      fields.name,
      fields.flavor,
      fields.edition,
      externalImage,
      fields.sourceLabel,
      accentA,
      accentB,
      fields.published ? 1 : 0,
      imageWidth,
      imageHeight,
      imageSrcset,
      id,
    );
    if (req.body?.relatedIds !== undefined) {
      setRelations(id, idArray(req.body.relatedIds, "Похожие", { max: 50 }));
    }
    history.recordDrink(db, req.user, "admin.drink.update", before, history.snapDrink(db, id));
    touchContent(db);
    const row = db.prepare("SELECT * FROM drinks WHERE id = ?").get(id);
    res.json({ drink: drinkToAdmin(row, ratingsForDrink(db, id), relationsForDrink(db, id)) });
  });

  router.post("/drinks/:id/reprocess-image", async (req, res) => {
    const id = int(req.params.id, "id", { min: 1 });
    const drink = db.prepare("SELECT * FROM drinks WHERE id = ?").get(id);
    if (!drink) throw notFound("Напиток не найден");
    const result = await reprocessStoredImage(config.uploadsDir, drink.image_path);
    if (!result) throw badRequest("Переобработать можно только картинки из /uploads");
    const before = history.snapDrink(db, id);
    db.prepare(
      "UPDATE drinks SET image_path = ?, accent_a = ?, accent_b = ?, image_width = ?, image_height = ?, image_srcset = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(result.path, result.accent[0], result.accent[1], result.width, result.height, result.srcset, id);
    history.recordDrink(db, req.user, "admin.drink.reprocess", before, history.snapDrink(db, id));
    touchContent(db);
    const row = db.prepare("SELECT * FROM drinks WHERE id = ?").get(id);
    res.json({ drink: drinkToAdmin(row, ratingsForDrink(db, id), relationsForDrink(db, id)) });
  });

  router.delete("/drinks/:id", (req, res) => {
    const id = int(req.params.id, "id", { min: 1 });
    const drink = db.prepare("SELECT * FROM drinks WHERE id = ?").get(id);
    if (!drink) throw notFound("Напиток не найден");
    const before = history.snapDrink(db, id, { full: true });
    db.prepare("DELETE FROM drinks WHERE id = ?").run(id);
    history.recordDrink(db, req.user, "admin.drink.delete", before, null);
    touchContent(db);
    res.json({ ok: true });
  });

  // Склейка дублей: :id — дубль, который исчезнет; targetId — оставшийся напиток.
  // Оценки и отзывы переносятся, конфликты решаются в пользу отзыва, затем свежести.
  router.post("/drinks/:id/merge", (req, res) => {
    const sourceId = int(req.params.id, "id", { min: 1 });
    const targetId = int(req.body?.targetId, "targetId", { min: 1 });
    if (sourceId === targetId) throw badRequest("Нельзя объединить напиток с самим собой");
    const source = db.prepare("SELECT * FROM drinks WHERE id = ?").get(sourceId);
    if (!source) throw notFound("Напиток не найден");
    const target = db.prepare("SELECT * FROM drinks WHERE id = ?").get(targetId);
    if (!target) throw notFound("Напиток для объединения не найден");

    const details = [];
    const stats = { movedRatings: 0, mergedRatings: 0, movedRelations: 0, filled: [] };
    const sourceSnap = history.snapDrink(db, sourceId, { full: true });
    const targetSnap = history.snapDrink(db, targetId, { full: true });

    const merge = db.transaction(() => {
      // 1) Оценки: свободные переносим, конфликты решаем в пользу отзыва, затем свежести.
      const targetRatings = new Map(
        db.prepare("SELECT * FROM ratings WHERE drink_id = ?").all(targetId).map((r) => [r.user_id, r]),
      );
      const preferSource = (mine, theirs) => {
        const a = String(mine.review || "").trim() ? 1 : 0;
        const b = String(theirs.review || "").trim() ? 1 : 0;
        if (a !== b) return a > b;
        return String(mine.updated_at || "") > String(theirs.updated_at || "");
      };
      const usernameOf = db.prepare("SELECT username FROM users WHERE id = ?");
      for (const rating of sourceSnap.ratings) {
        const existing = targetRatings.get(rating.user_id);
        if (!existing) {
          db.prepare("UPDATE ratings SET drink_id = ? WHERE drink_id = ? AND user_id = ?").run(
            targetId,
            sourceId,
            rating.user_id,
          );
          stats.movedRatings += 1;
          continue;
        }
        stats.mergedRatings += 1;
        if (preferSource(rating, existing)) {
          db.prepare(
            `UPDATE ratings SET tier_id = ?, review = ?, order_index = ?, created_at = ?, updated_at = ?
             WHERE drink_id = ? AND user_id = ?`,
          ).run(
            rating.tier_id,
            rating.review,
            rating.order_index,
            rating.created_at,
            rating.updated_at,
            targetId,
            rating.user_id,
          );
          const who = usernameOf.get(rating.user_id)?.username || `#${rating.user_id}`;
          details.push(`@${who}: оставлена оценка дубля ${rating.tier_id} вместо ${existing.tier_id}`);
        }
        db.prepare("DELETE FROM ratings WHERE drink_id = ? AND user_id = ?").run(sourceId, rating.user_id);
      }

      // 2) Связи: рёбра дубля переводим на оставшийся напиток, петли исключаем.
      const insertRel = db.prepare("INSERT OR IGNORE INTO drink_relations (drink_id, related_id) VALUES (?, ?)");
      for (const { related_id: rid } of db
        .prepare("SELECT related_id FROM drink_relations WHERE drink_id = ?")
        .all(sourceId)) {
        if (rid !== targetId && rid !== sourceId) {
          insertRel.run(targetId, rid);
          stats.movedRelations += 1;
        }
      }
      for (const { drink_id: did } of db
        .prepare("SELECT drink_id FROM drink_relations WHERE related_id = ?")
        .all(sourceId)) {
        if (did !== targetId && did !== sourceId) {
          insertRel.run(did, targetId);
          stats.movedRelations += 1;
        }
      }

      // 3) Поля: пустые места оставшегося напитка заполняем данными дубля.
      const row = { ...target };
      const filled = [];
      const takeField = (col, label) => {
        if (!String(target[col] || "").trim() && String(source[col] || "").trim()) {
          row[col] = source[col];
          filled.push(label);
        }
      };
      takeField("barcode", "Штрих-код");
      takeField("flavor", "Вкус");
      takeField("edition", "Издание");
      takeField("source_label", "Подпись");
      if (!target.image_path && source.image_path) {
        row.image_path = source.image_path;
        row.image_width = source.image_width;
        row.image_height = source.image_height;
        row.image_srcset = source.image_srcset;
        row.accent_a = source.accent_a;
        row.accent_b = source.accent_b;
        filled.push("Картинка");
      }
      if (source.is_published && !target.is_published) {
        row.is_published = 1;
        filled.push("Публикация");
      }
      db.prepare(
        `UPDATE drinks SET barcode = ?, flavor = ?, edition = ?, source_label = ?, image_path = ?,
           image_width = ?, image_height = ?, image_srcset = ?, accent_a = ?, accent_b = ?, is_published = ?,
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(
        row.barcode,
        row.flavor,
        row.edition,
        row.source_label,
        row.image_path,
        row.image_width,
        row.image_height,
        row.image_srcset,
        row.accent_a,
        row.accent_b,
        row.is_published,
        targetId,
      );

      db.prepare("DELETE FROM drinks WHERE id = ?").run(sourceId);

      stats.filled = filled;
      if (stats.movedRatings) details.unshift(`Оценок перенесено: ${stats.movedRatings}`);
      if (stats.mergedRatings) details.push(`Совпало с оценками оставшегося: ${stats.mergedRatings}`);
      if (stats.movedRelations) details.push(`Связей перенесено: ${stats.movedRelations}`);
      if (filled.length) details.push(`Заполнено из дубля: ${filled.join(", ")}`);
    });

    merge();
    history.recordMerge(db, req.user, { source: sourceSnap, target: targetSnap, details });
    touchContent(db);
    res.json({ ok: true, ...stats });
  });

  router.put("/ratings/:drinkId/:userId", (req, res) => {
    const drinkId = int(req.params.drinkId, "drinkId", { min: 1 });
    const userId = int(req.params.userId, "userId", { min: 1 });
    const drink = db.prepare("SELECT id, slug, name FROM drinks WHERE id = ?").get(drinkId);
    if (!drink) throw notFound("Напиток не найден");
    const user = getUser(userId);
    const tier = oneOf(String(req.body?.tier || ""), TIERS, "Тир");
    const review = str(req.body?.review ?? "", "Отзыв", { required: false, max: 1000 });
    const before = history.snapRating(db, drinkId, userId);
    db.prepare(
      `INSERT INTO ratings (drink_id, user_id, tier_id, review) VALUES (?, ?, ?, ?)
       ON CONFLICT(drink_id, user_id)
       DO UPDATE SET tier_id = excluded.tier_id, review = excluded.review, updated_at = datetime('now')`,
    ).run(drinkId, userId, tier, review);
    history.recordRating(db, req.user, "admin.rating.set", {
      drink,
      user,
      before,
      after: history.snapRating(db, drinkId, userId),
    });
    touchContent(db);
    res.json({ ok: true });
  });

  router.delete("/ratings/:drinkId/:userId", (req, res) => {
    const drinkId = int(req.params.drinkId, "drinkId", { min: 1 });
    const userId = int(req.params.userId, "userId", { min: 1 });
    const drink = db.prepare("SELECT id, slug, name FROM drinks WHERE id = ?").get(drinkId);
    if (!drink) throw notFound("Напиток не найден");
    const user = getUser(userId);
    const before = history.snapRating(db, drinkId, userId);
    if (!before) throw notFound("Оценки нет");
    db.prepare("DELETE FROM ratings WHERE drink_id = ? AND user_id = ?").run(drinkId, userId);
    history.recordRating(db, req.user, "admin.rating.delete", { drink, user, before, after: null });
    touchContent(db);
    res.json({ ok: true });
  });

  // ---------- tiers (admin) ----------

  router.post("/tiers", requireAdmin, (req, res) => {
    const id = str(req.body?.id, "ID тира", { min: 1, max: 8 }).toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(id)) throw badRequest("ID тира: латиница/цифры, до 8 символов");
    const title = str(req.body?.title, "Название", { max: 60 });
    const note = str(req.body?.note ?? "", "Описание", { required: false, max: 200 });
    const score = int(req.body?.score, "Балл", { min: 1, max: 100 });
    const position = int(req.body?.position, "Позиция", { min: 0, max: 1000 });
    try {
      db.prepare("INSERT INTO tiers (id, title, note, score, position) VALUES (?, ?, ?, ?, ?)").run(
        id,
        title,
        note,
        score,
        position,
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw conflict("Такой тир уже есть");
      throw error;
    }
    history.recordTier(db, req.user, "admin.tier.create", null, history.snapTier(db, id));
    touchContent(db);
    res.status(201).json({ ok: true });
  });

  router.patch("/tiers/:id", requireAdmin, (req, res) => {
    const id = req.params.id.toUpperCase();
    const tier = db.prepare("SELECT * FROM tiers WHERE id = ?").get(id);
    if (!tier) throw notFound("Тир не найден");
    const title = str(req.body?.title ?? tier.title, "Название", { max: 60 });
    const note = str(req.body?.note ?? tier.note, "Описание", { required: false, max: 200 });
    const score = int(req.body?.score ?? tier.score, "Балл", { min: 1, max: 100 });
    const position = int(req.body?.position ?? tier.position, "Позиция", { min: 0, max: 1000 });
    db.prepare("UPDATE tiers SET title = ?, note = ?, score = ?, position = ? WHERE id = ?").run(
      title,
      note,
      score,
      position,
      id,
    );
    history.recordTier(db, req.user, "admin.tier.update", tier, history.snapTier(db, id));
    touchContent(db);
    res.json({ ok: true });
  });

  router.delete("/tiers/:id", requireAdmin, (req, res) => {
    const id = req.params.id.toUpperCase();
    const used = db.prepare("SELECT COUNT(*) AS n FROM ratings WHERE tier_id = ?").get(id).n;
    if (used) throw conflict("Тир используется в оценках — сначала переведите их");
    const before = history.snapTier(db, id);
    if (!before) throw notFound("Тир не найден");
    db.prepare("DELETE FROM tiers WHERE id = ?").run(id);
    history.recordTier(db, req.user, "admin.tier.delete", before, null);
    touchContent(db);
    res.json({ ok: true });
  });

  // ---------- users (admin) ----------

  router.post("/users", requireAdmin, async (req, res) => {
    const uname = username(req.body?.username);
    const displayName = str(req.body?.displayName, "Имя", { max: 80 });
    const role = oneOf(String(req.body?.role || "user"), ROLES, "Роль");
    const title = str(req.body?.title ?? "", "Должность", { required: false, max: 80 });
    const initials = str(req.body?.initials ?? "", "Инициалы", { required: false, max: 4 });
    const userColor = color(req.body?.color, "Цвет", "#9fb7ff");
    const isPublic = bool(req.body?.isPublic, true);
    const given = typeof req.body?.password === "string" && req.body.password ? password(req.body.password) : "";
    const generated = given ? "" : tempPassword();
    const hash = await hashPassword(given || generated);

    let id;
    try {
      const info = db
        .prepare(
          `INSERT INTO users (username, display_name, role, title, initials, color, password_hash, must_change_password, is_public)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(uname, displayName, role, title, initials, userColor, hash, given ? 0 : 1, isPublic ? 1 : 0);
      id = info.lastInsertRowid;
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw conflict("Логин уже занят");
      throw error;
    }
    history.recordUser(db, req.user, "admin.user.create", null, history.snapUser(db, id));
    const row = getUser(id);
    res.status(201).json({ user: userToApi(row), tempPassword: generated || undefined });
  });

  router.patch("/users/:id", requireAdmin, (req, res) => {
    const id = int(req.params.id, "id", { min: 1 });
    const target = getUser(id);
    const role = oneOf(String(req.body?.role ?? target.role), ROLES, "Роль");
    const isActive = bool(req.body?.isActive, Boolean(target.is_active));
    const losesAdmin = target.role === "admin" && (role !== "admin" || !isActive);
    if (losesAdmin && activeAdmins() <= 1) throw conflict("Нельзя убрать последнего админа");
    if (id === req.user.id && !isActive) throw conflict("Нельзя отключить себя");

    const uname = req.body?.username === undefined ? target.username : username(req.body.username);
    if (uname !== target.username) {
      const taken = db.prepare("SELECT 1 FROM users WHERE username = ? AND id != ?").get(uname, id);
      if (taken) throw conflict("Логин уже занят");
    }
    const displayName = str(req.body?.displayName ?? target.display_name, "Имя", { max: 80 });
    const title = str(req.body?.title ?? target.title, "Должность", { required: false, max: 80 });
    const initials = str(req.body?.initials ?? target.initials, "Инициалы", { required: false, max: 4 });
    const userColor = color(req.body?.color ?? target.color, "Цвет", target.color || "#9fb7ff");
    const isPublic = bool(req.body?.isPublic, Boolean(target.is_public));

    try {
      db.prepare(
        `UPDATE users SET username = ?, display_name = ?, role = ?, title = ?, initials = ?, color = ?, is_active = ?,
           is_public = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(uname, displayName, role, title, initials, userColor, isActive ? 1 : 0, isPublic ? 1 : 0, id);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw conflict("Логин уже занят");
      throw error;
    }
    if (!isActive) auth.destroyUserSessions(id);
    history.recordUser(db, req.user, "admin.user.update", { row: target }, history.snapUser(db, id));
    if (target.is_public !== (isPublic ? 1 : 0) || target.username !== uname) touchContent(db);
    res.json({ user: userToApi(getUser(id)) });
  });

  router.post("/users/:id/password", requireAdmin, async (req, res) => {
    const id = int(req.params.id, "id", { min: 1 });
    getUser(id);
    const generated = req.body?.password ? password(req.body.password) : tempPassword();
    const hash = await hashPassword(generated);
    db.prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?",
    ).run(hash, id);
    auth.destroyUserSessions(id);
    const target = getUser(id);
    writeAudit(db, req.user, "admin.user.password", "user", String(id), "Старые сессии завершены, при входе потребуется сменить пароль", {
      summary: `Сбросил пароль ${target.display_name} (@${target.username})`,
    });
    res.json({ tempPassword: req.body?.password ? undefined : generated });
  });

  router.delete("/users/:id", requireAdmin, (req, res) => {
    const id = int(req.params.id, "id", { min: 1 });
    const target = getUser(id);
    if (id === req.user.id) throw conflict("Нельзя удалить себя");
    if (target.role === "admin" && activeAdmins() <= 1) throw conflict("Нельзя удалить последнего админа");
    const before = history.snapUser(db, id, { full: true });
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    history.recordUser(db, req.user, "admin.user.delete", before, null);
    touchContent(db);
    res.json({ ok: true });
  });

  // ---------- settings (admin) ----------

  router.put("/settings", requireAdmin, (req, res) => {
    const body = req.body || {};
    const next = {};
    if ("siteTitle" in body) next.site_title = str(body.siteTitle, "Заголовок", { max: 120 });
    if ("siteDescription" in body) {
      next.site_description = str(body.siteDescription ?? "", "Описание", { required: false, max: 300 });
    }
    if ("openrouterModel" in body) {
      next.openrouter_model = str(body.openrouterModel || DEFAULT_MODEL, "Модель", { max: 120 });
    }
    if ("textModel" in body) {
      next.openrouter_model = str(body.textModel || DEFAULT_MODEL, "Модель разбора", { max: 120 });
    }
    if ("sttModel" in body) {
      next.stt_model = str(body.sttModel || DEFAULT_STT_MODEL, "STT-модель", { max: 120 });
    }
    if ("aiBaseUrl" in body) {
      next.ai_base_url = normalizeBaseUrl(str(body.aiBaseUrl || DEFAULT_BASE_URL, "Base URL", { max: 300 }));
    }
    if ("parseBaseUrl" in body) {
      next.parse_base_url = normalizeBaseUrl(str(body.parseBaseUrl || DEFAULT_BASE_URL, "Base URL разбора", { max: 300 }));
    }
    if ("textBaseUrl" in body) {
      next.parse_base_url = normalizeBaseUrl(str(body.textBaseUrl || DEFAULT_BASE_URL, "Base URL разбора", { max: 300 }));
    }
    if ("openrouterKey" in body) {
      next.openrouter_key = str(body.openrouterKey ?? "", "Ключ", { required: false, max: 300 });
    }
    if ("parseApiKey" in body) {
      next.parse_api_key = str(body.parseApiKey ?? "", "Ключ разбора", { required: false, max: 300 });
    }
    if ("textApiKey" in body) {
      next.parse_api_key = str(body.textApiKey ?? "", "Ключ разбора", { required: false, max: 300 });
    }
    if ("googleCseKey" in body) {
      next.google_cse_key = str(body.googleCseKey ?? "", "Ключ Google CSE", { required: false, max: 200 });
    }
    if ("googleCseCx" in body) {
      next.google_cse_cx = str(body.googleCseCx ?? "", "ID поисковика Google", { required: false, max: 100 });
    }
    if ("geminiKey" in body) {
      next.gemini_api_key = str(body.geminiKey ?? "", "Ключ Gemini", { required: false, max: 200 });
    }
    if ("geminiImageModel" in body) {
      next.gemini_image_model = str(body.geminiImageModel || DEFAULT_IMAGE_MODEL, "Модель Gemini", { max: 100 });
    }
    if ("geminiVisionModel" in body) {
      next.gemini_vision_model = str(body.geminiVisionModel || DEFAULT_VISION_MODEL, "Модель Gemini (ассортимент)", { max: 100 });
    }
    if ("imageProvider" in body) {
      next.image_provider = oneOf(String(body.imageProvider || DEFAULT_IMAGE_PROVIDER), IMAGE_PROVIDERS, "Провайдер перерисовки");
    }
    if ("openrouterImageModel" in body) {
      next.openrouter_image_model = str(body.openrouterImageModel || DEFAULT_OPENROUTER_IMAGE_MODEL, "Модель OpenRouter", { max: 120 });
    }
    if ("openrouterImagePrompt" in body) {
      const value = str(body.openrouterImagePrompt ?? "", "Промпт OpenRouter", { required: false, max: 4000 });
      // ровно стандартный текст не храним: пусто = встроенный промпт
      next.openrouter_image_prompt = value === OPENROUTER_REDRAW_PROMPT ? "" : value;
    }
    if ("geminiImagePrompt" in body) {
      const value = str(body.geminiImagePrompt ?? "", "Промпт Gemini", { required: false, max: 4000 });
      next.gemini_image_prompt = value === GEMINI_REDRAW_PROMPT ? "" : value;
    }
    if ("aiProxyUrl" in body) {
      const raw = str(body.aiProxyUrl ?? "", "Прокси", { required: false, max: 500 });
      const stored = getSetting(db, "ai_proxy_url", "");
      // админка получает адрес с *** вместо пароля — если его не трогали, оставляем как есть
      if (!(stored && raw === maskProxyUrl(stored))) next.ai_proxy_url = normalizeProxyUrl(raw);
    }
    const ai = aiSettings(db);
    const effective = {
      openrouter_model: ai.model,
      stt_model: ai.sttModel,
      ai_base_url: ai.baseUrl,
      parse_base_url: ai.parseBaseUrl,
      openrouter_key: getSetting(db, "openrouter_key", ""),
      parse_api_key: getSetting(db, "parse_api_key", "") || process.env.PARSE_API_KEY || "",
      google_cse_key: getSetting(db, "google_cse_key", ""),
      google_cse_cx: getSetting(db, "google_cse_cx", ""),
      gemini_api_key: getSetting(db, "gemini_api_key", ""),
      gemini_image_model: getSetting(db, "gemini_image_model", ""),
      gemini_vision_model: getSetting(db, "gemini_vision_model", ""),
      image_provider: ai.imageProvider,
      openrouter_image_model: ai.openrouterImageModel,
      openrouter_image_prompt: getSetting(db, "openrouter_image_prompt", ""),
      gemini_image_prompt: getSetting(db, "gemini_image_prompt", ""),
      ai_proxy_url: getSetting(db, "ai_proxy_url", ""),
    };
    const before = Object.fromEntries(
      Object.keys(next).map((key) => [key, key in effective ? effective[key] : getSetting(db, key, "")]),
    );
    const save = db.transaction(() => {
      for (const [key, value] of Object.entries(next)) setSetting(db, key, value);
      history.recordSettings(db, req.user, before, next);
    });
    save();
    if ("site_title" in next || "site_description" in next) touchContent(db);
    const changed = Object.keys(next).filter((key) => before[key] !== next[key]);
    res.json({ ok: true, changed });
  });

  const TEMPLATE_MAX_BYTES = 4 * 1024 * 1024;

  // Своё фото-шаблон: сохраняем сырые байты (обработка вырезала бы тёмный корпус
  // банки на тёмном фоне). Старый файл не удаляем — откат настройки вернёт его.
  router.post("/settings/image-template", requireAdmin, (req, res) => {
    const { ext, buffer } = imageFromDataUrl(req.body?.dataUrl, { maxBytes: TEMPLATE_MAX_BYTES });
    const name = `template-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(config.uploadsDir, name), buffer);
    const imagePath = `/uploads/${name}`;
    const before = { openrouter_image_template: getSetting(db, "openrouter_image_template", "") };
    setSetting(db, "openrouter_image_template", imagePath);
    history.recordSettings(db, req.user, before, { openrouter_image_template: imagePath });
    res.status(201).json({ path: imagePath });
  });

  router.delete("/settings/image-template", requireAdmin, (req, res) => {
    const before = { openrouter_image_template: getSetting(db, "openrouter_image_template", "") };
    setSetting(db, "openrouter_image_template", "");
    history.recordSettings(db, req.user, before, { openrouter_image_template: "" });
    res.json({ ok: true });
  });

  // Проверка связи с ИИ-провайдером (через прокси, если задан): GET {base}/models.
  // Можно передать несохранённый прокси из формы — проверим его, ничего не сохраняя.
  router.post("/settings/ai-check", requireAdmin, async (req, res) => {
    const ai = aiSettings(db);
    let proxyUrl = ai.proxyUrl;
    if (req.body && "aiProxyUrl" in req.body) {
      const raw = str(req.body.aiProxyUrl ?? "", "Прокси", { required: false, max: 500 });
      proxyUrl = ai.proxyUrl && raw === maskProxyUrl(ai.proxyUrl) ? ai.proxyUrl : normalizeProxyUrl(raw);
    }
    const started = Date.now();
    let response;
    try {
      response = await proxiedFetch(proxyUrl)(`${ai.parseBaseUrl}/models`, {
        headers: ai.parseKey ? { Authorization: `Bearer ${ai.parseKey}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      return res.json({
        ok: false,
        viaProxy: Boolean(proxyUrl),
        error: timeout ? "нет ответа за 15 с" : String(error?.message || "ошибка сети").slice(0, 200),
      });
    }
    let detail = "";
    if (!response.ok) detail = await providerFailureDetail(response);
    res.json({
      ok: response.ok,
      viaProxy: Boolean(proxyUrl),
      status: response.status,
      ms: Date.now() - started,
      error: response.ok ? "" : [`HTTP ${response.status}`, detail].filter(Boolean).join(" — "),
    });
  });

  // Проверка ключа Google CSE: тестовый запрос searchType=image на 1 результат.
  // Можно передать несохранённые ключ/CX из формы — проверим их, ничего не сохраняя.
  // Квота: проверка = 1 запрос из бесплатных 100/день.
  router.post("/settings/photo-check", requireAdmin, async (req, res) => {
    const ai = aiSettings(db);
    let key = ai.googleCseKey;
    let cx = ai.googleCseCx;
    if (req.body && "googleCseKey" in req.body) {
      const raw = str(req.body.googleCseKey ?? "", "Ключ Google CSE", { required: false, max: 200 });
      if (raw) key = raw;
    }
    if (req.body && "googleCseCx" in req.body) {
      const raw = str(req.body.googleCseCx ?? "", "ID поисковика Google", { required: false, max: 100 });
      if (raw) cx = raw;
    }
    if (!key || !cx) {
      return res.json({ ok: false, error: "задайте ключ Google CSE и ID поисковика (CX)" });
    }
    const started = Date.now();
    try {
      const items = await searchGoogleCse("Burn energy drink", {
        key,
        cx,
        fetchImpl: proxiedFetch(ai.proxyUrl),
      });
      res.json({
        ok: true,
        ms: Date.now() - started,
        count: items.length,
        sample: items[0]?.url || "",
        error: "",
      });
    } catch (error) {
      const status = Number(error?.status);
      const detail = error?.details || String(error?.message || "ошибка сети").slice(0, 200);
      res.json({
        ok: false,
        ms: Date.now() - started,
        ...(Number.isFinite(status) ? { status } : {}),
        error: detail,
      });
    }
  });

  // Проверка ключа Gemini: models.get на настроенной модели — ничего не генерирует,
  // квоту картинок не тратит. Можно передать несохранённые ключ/модель из формы.
  router.post("/settings/gemini-check", requireAdmin, async (req, res) => {
    const ai = aiSettings(db);
    let key = ai.geminiKey;
    let model = ai.geminiImageModel;
    if (req.body && "geminiKey" in req.body) {
      const raw = str(req.body.geminiKey ?? "", "Ключ Gemini", { required: false, max: 200 });
      if (raw) key = raw;
    }
    if (req.body && "geminiModel" in req.body) {
      const raw = str(req.body.geminiModel ?? "", "Модель Gemini", { required: false, max: 100 });
      if (raw) model = raw;
    }
    if (!key) {
      return res.json({ ok: false, error: "задайте ключ Gemini (aistudio.google.com → Get API key)" });
    }
    const started = Date.now();
    try {
      const info = await checkGeminiKey({ key, model, fetchImpl: proxiedFetch(ai.proxyUrl) });
      res.json({ ok: true, ms: Date.now() - started, model: info.model, error: "" });
    } catch (error) {
      const status = Number(error?.status);
      res.json({
        ok: false,
        ms: Date.now() - started,
        ...(Number.isFinite(status) ? { status } : {}),
        error: String(error?.message || "ошибка сети").slice(0, 200),
      });
    }
  });

  return router;
};
