const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { renderOgCard } = require("../lib/og");
const { contentUpdatedAt } = require("../lib/content");

function baseUrl(req, config) {
  const fromEnv = String(config.siteUrl || "").trim().replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

function escAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function siteInfo(db) {
  const get = (key, fallback) =>
    db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? fallback;
  return {
    title: get("site_title", "NRG / INDEX"),
    description: get("site_description", "Коллективный тирлист энергетиков"),
  };
}

function drinkRow(db, slug) {
  return db
    .prepare("SELECT * FROM drinks WHERE slug = ? AND is_published = 1")
    .get(String(slug || "").slice(0, 128));
}

function consensusFor(db, drinkId) {
  const rows = db
    .prepare(
      `SELECT t.id AS tier, t.score FROM ratings r
       JOIN tiers t ON t.id = r.tier_id
       JOIN users u ON u.id = r.user_id
       WHERE r.drink_id = ? AND u.is_active = 1 AND u.is_public = 1`,
    )
    .all(drinkId);
  if (!rows.length) return null;
  const avg = rows.reduce((sum, row) => sum + row.score, 0) / rows.length;
  const tiers = db.prepare("SELECT id, score FROM tiers ORDER BY position, id").all();
  let best = tiers[0];
  for (const tier of tiers) {
    if (Math.abs(tier.score - avg) < Math.abs(best.score - avg)) best = tier;
  }
  return { tier: best.id, votes: rows.length, value: avg };
}

function wordForm(value, forms) {
  const n = Math.abs(value) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

// OG-картинки 1200x630 — дорогая генерация (sharp). Кэшируем по версии
// контента: при правке банки/оценки версия меняется, картинка перерисуется.
const OG_CACHE_LIMIT = 64;
const ogCache = new Map();

function etagFor(buffer) {
  return `"${crypto.createHash("sha1").update(buffer).digest("base64url")}"`;
}

async function cachedOg(key, version, render) {
  const cached = ogCache.get(key);
  if (cached && cached.version === version) return cached;
  const buffer = await render();
  const stamp = Date.parse(version);
  const entry = {
    version,
    buffer,
    etag: etagFor(buffer),
    lastModified: Number.isFinite(stamp) ? new Date(stamp) : new Date(),
  };
  ogCache.set(key, entry);
  if (ogCache.size > OG_CACHE_LIMIT) ogCache.delete(ogCache.keys().next().value);
  return entry;
}

function sendOg(req, res, entry) {
  res.set({
    "Cache-Control": "public, max-age=600",
    ETag: entry.etag,
    "Last-Modified": entry.lastModified.toUTCString(),
  });
  const inm = String(req.get("if-none-match") || "").trim();
  if (
    inm &&
    (inm === "*" ||
      inm.split(",").some((tag) => tag.trim().replace(/^W\//, "") === entry.etag))
  ) {
    return res.status(304).end();
  }
  if (!inm) {
    const since = Date.parse(String(req.get("if-modified-since") || ""));
    if (Number.isFinite(since) && since >= entry.lastModified.getTime()) {
      return res.status(304).end();
    }
  }
  return res.type("png").send(entry.buffer);
}

function buildTags({ title, description, url, image }) {
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="NRG / INDEX">`,
    `<meta property="og:title" content="${escAttr(title)}">`,
    `<meta property="og:description" content="${escAttr(description)}">`,
    `<meta property="og:url" content="${escAttr(url)}">`,
    `<meta property="og:image" content="${escAttr(image)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escAttr(title)}">`,
    `<meta name="twitter:description" content="${escAttr(description)}">`,
    `<meta name="twitter:image" content="${escAttr(image)}">`,
  ].join("\n  ");
}

function injectSeo(html, { title, description, tags, canonical }) {
  let out = String(html);
  out = out.replace(/<title>.*?<\/title>/s, `<title>${escAttr(title)}</title>`);
  if (/<meta name="description"/.test(out)) {
    out = out.replace(
      /<meta name="description"[^>]*>/,
      `<meta name="description" content="${escAttr(description)}">`,
    );
  } else {
    out = out.replace(/<meta charset[^>]*>/, `$&\n  <meta name="description" content="${escAttr(description)}">`);
  }
  // Убираем старые og/twitter-теги, чтобы не дублировались при повторном деплое.
  out = out.replace(/\n  <meta property="og:[^>]*>/g, "");
  out = out.replace(/\n  <meta name="twitter:[^>]*>/g, "");
  out = out.replace(/\n  <link rel="canonical"[^>]*>/g, "");
  // /d/:slug отдаёт тот же index.html с вложенного пути — base фиксирует относительные URL (css/js/assets/fetch).
  if (!/<base href="\/"\s*\/?>/.test(out)) {
    out = out.replace(/<head>/, `<head>\n  <base href="/">`);
  }
  const head = `  <link rel="canonical" href="${escAttr(canonical)}">\n  ${tags}`;
  if (out.includes("</head>")) return out.replace("</head>", `${head}\n</head>`);
  return `${head}\n${out}`;
}

function serveIndex(db, config, kind) {
  return (req, res, next) => {
    let file;
    try {
      file = fs.readFileSync(path.join(config.publicDir, "index.html"), "utf8");
    } catch (error) {
      return next(error);
    }
    const base = baseUrl(req, config);
    const site = siteInfo(db);
    if (kind === "drink") {
      const drink = drinkRow(db, req.params.slug);
      if (!drink) {
        const tags = buildTags({
          title: site.title,
          description: site.description,
          url: `${base}/`,
          image: `${base}/og/site.png`,
        });
        return res
          .status(404)
          .type("html")
          .set("Cache-Control", "no-cache")
          .send(injectSeo(file, { title: site.title, description: site.description, tags, canonical: `${base}/` }));
      }
      const consensus = consensusFor(db, drink.id);
      const title = `${drink.brand} ${drink.name} — тир ${consensus ? consensus.tier : "?"}`;
      const flavor = [drink.flavor, drink.edition].filter(Boolean).join(" · ");
      const description = consensus
        ? `${flavor || drink.brand}. Средняя оценка ${consensus.value.toFixed(1)}, ${consensus.votes} ${wordForm(consensus.votes, ["голос", "голоса", "голосов"])}.`
        : `${flavor || drink.brand}. Оценок пока нет — открой карточку и стань первым.`;
      const url = `${base}/d/${drink.slug}`;
      const tags = buildTags({ title, description, url, image: `${base}/og/drink/${drink.slug}.png` });
      return res
        .type("html")
        .set("Cache-Control", "no-cache")
        .send(injectSeo(file, { title, description, tags, canonical: url }));
    }
    // Главная: учитываем ?drink=<slug> для краулеров, не исполняющих JS.
    const drinkParam = String(req.query.drink || "");
    if (drinkParam) {
      const drink = drinkRow(db, drinkParam);
      if (drink) {
        const consensus = consensusFor(db, drink.id);
        const title = `${drink.brand} ${drink.name} — тир ${consensus ? consensus.tier : "?"}`;
        const flavor = [drink.flavor, drink.edition].filter(Boolean).join(" · ");
        const description = consensus
          ? `${flavor || drink.brand}. Средняя оценка ${consensus.value.toFixed(1)}.`
          : `${flavor || drink.brand}. Оценок пока нет.`;
        const url = `${base}/d/${drink.slug}`;
        const tags = buildTags({ title, description, url, image: `${base}/og/drink/${drink.slug}.png` });
        return res
          .type("html")
          .set("Cache-Control", "no-cache")
          .send(injectSeo(file, { title, description, tags, canonical: url }));
      }
    }
    const count = db.prepare("SELECT COUNT(*) AS n FROM drinks WHERE is_published = 1").get()?.n || 0;
    const title = `${site.title} — тирлист энергетиков`;
    const description = count
      ? `${site.description}. Уже ${count} ${wordForm(count, ["образец", "образца", "образцов"])} в рейтинге.`
      : site.description;
    const tags = buildTags({
      title,
      description,
      url: `${base}/`,
      image: `${base}/og/site.png`,
    });
    return res
      .type("html")
      .set("Cache-Control", "no-cache")
      .send(injectSeo(file, { title, description, tags, canonical: `${base}/` }));
  };
}

module.exports = (app, db, config) => {
  // Картинки-превью 1200x630 для мессенджеров.
  app.get("/og/site.png", async (req, res, next) => {
    try {
      const entry = await cachedOg("site", contentUpdatedAt(db), () => {
        const site = siteInfo(db);
        const count = db.prepare("SELECT COUNT(*) AS n FROM drinks WHERE is_published = 1").get()?.n || 0;
        return renderOgCard({
          kicker: "NRG / INDEX",
          title: site.title,
          subtitle: site.description,
          bottom: count ? `${count} ${wordForm(count, ["образец", "образца", "образцов"])} в рейтинге` : "",
          imagePath: "assets/adrenaline-yuzu-strawberry-calamansi.png",
          publicDir: config.publicDir,
          uploadsDir: config.uploadsDir,
        });
      });
      sendOg(req, res, entry);
    } catch (error) {
      next(error);
    }
  });

  app.get("/og/drink/:slug.png", async (req, res, next) => {
    try {
      const drink = drinkRow(db, req.params.slug);
      if (!drink) return res.status(404).end();
      const entry = await cachedOg(`drink:${drink.id}`, contentUpdatedAt(db), () => {
        const consensus = consensusFor(db, drink.id);
        const flavor = [drink.flavor, drink.edition].filter(Boolean).join(" · ");
        return renderOgCard({
          kicker: drink.brand || "NRG / INDEX",
          title: drink.name,
          subtitle: flavor,
          tier: consensus?.tier || null,
          bottom: consensus
            ? `${consensus.value.toFixed(1)} · ${consensus.votes} ${wordForm(consensus.votes, ["голос", "голоса", "голосов"])}`
            : "оценок пока нет",
          accentA: drink.accent_a || "#ff4f79",
          accentB: drink.accent_b || "#ff7448",
          imagePath: drink.image_path || "",
          publicDir: config.publicDir,
          uploadsDir: config.uploadsDir,
        });
      });
      sendOg(req, res, entry);
    } catch (error) {
      next(error);
    }
  });

  // HTML с OG-тегами должен отдаваться раньше express.static.
  app.get(["/", "/index.html"], serveIndex(db, config, "site"));
  app.get("/d/:slug", serveIndex(db, config, "drink"));
};
