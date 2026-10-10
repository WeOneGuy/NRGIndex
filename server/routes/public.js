const express = require("express");
const { formatDate, userToParticipant, drinkToPublic } = require("../lib/serialize");

// Что из журнала можно показывать в публичном профиле: только собственные
// содержательные действия участника. Модерация (admin.rating.*, откаты) — нет.
const PROFILE_HISTORY_ACTIONS = [
  "rating.set",
  "rating.delete",
  "drink.create",
  "drink.update",
  "drink.delete",
  "admin.drink.create",
  "admin.drink.update",
  "admin.drink.delete",
  "admin.drink.reprocess",
];
const PROFILE_HISTORY_LIMIT = 30;
const { drinkImage } = require("../lib/assets");
const { notFound } = require("../lib/errors");
const { computeMonthlyTitles } = require("../lib/titles");

function ratingsMap(db) {
  const rows = db
    .prepare(
      `SELECT r.drink_id, r.tier_id AS tier, r.review, r.order_index AS "order", u.username
       FROM ratings r JOIN users u ON u.id = r.user_id
       WHERE u.is_active = 1 AND u.is_public = 1`,
    )
    .all();
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.drink_id)) map.set(row.drink_id, {});
    map.get(row.drink_id)[row.username] = {
      tier: row.tier,
      review: row.review,
      order: row.order,
    };
  }
  return map;
}

function relationsMap(db) {
  const slugs = new Map(
    db.prepare("SELECT id, slug FROM drinks").all().map((row) => [row.id, row.slug]),
  );
  const map = new Map();
  for (const row of db.prepare("SELECT drink_id, related_id FROM drink_relations").all()) {
    if (!map.has(row.drink_id)) map.set(row.drink_id, []);
    const slug = slugs.get(row.related_id);
    if (slug) map.get(row.drink_id).push(slug);
  }
  return map;
}

function contentUpdatedAt(db) {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'content_updated_at'").get();
  if (setting) return setting.value;
  const row = db
    .prepare(
      `SELECT MAX(updated_at) AS ts FROM (
         SELECT updated_at FROM drinks
         UNION ALL SELECT updated_at FROM ratings
       )`,
    )
    .get();
  return row?.ts || new Date().toISOString();
}

module.exports = (db) => {
  const router = express.Router();

  router.get("/summary", (req, res) => {
    const tiers = db
      .prepare("SELECT id, title, note, score FROM tiers ORDER BY position, id")
      .all();
    const participants = db
      .prepare(
        "SELECT username, display_name, initials, title, color, avatar_path FROM users WHERE is_active = 1 AND is_public = 1 ORDER BY id",
      )
      .all()
      .map(userToParticipant);
    const drinks = db.prepare("SELECT * FROM drinks WHERE is_published = 1 ORDER BY id").all();
    const ratings = ratingsMap(db);
    const relations = relationsMap(db);
    const site = {
      title: db.prepare("SELECT value FROM settings WHERE key = 'site_title'").get()?.value || "NRG / INDEX",
      description:
        db.prepare("SELECT value FROM settings WHERE key = 'site_description'").get()?.value || "",
    };

    res.json({
      site,
      updatedAt: formatDate(contentUpdatedAt(db)),
      tiers,
      participants,
      drinks: drinks.map((drink) =>
        drinkToPublic(drink, ratings.get(drink.id) || {}, relations.get(drink.id) || []),
      ),
    });
  });

  // Публичный профиль участника: личные оценки, распределение по тирам,
  // совпадение с общим мнением и добавленные банки. Скрытые/неактивные — 404.
  router.get("/profile/:username", (req, res) => {
    const user = db
      .prepare(
        `SELECT id, username, display_name, initials, title, color, avatar_path, created_at, role
         FROM users WHERE username = ? AND is_active = 1 AND is_public = 1`,
      )
      .get(String(req.params.username || "").slice(0, 64));
    if (!user) throw notFound("Профиль не найден");
    const monthly = computeMonthlyTitles(db);

    const tiers = db.prepare("SELECT id, title, note, score FROM tiers ORDER BY position, id").all();
    const scoreOf = new Map(tiers.map((tier) => [tier.id, tier.score]));
    const rows = db
      .prepare(
        `SELECT d.id, d.slug, d.brand, d.name, d.flavor, d.edition, d.image_path, d.accent_a, d.accent_b,
                d.image_width, d.image_height, d.image_srcset,
                d.created_by, r.tier_id AS tier, r.review, r.updated_at
         FROM ratings r JOIN drinks d ON d.id = r.drink_id
         WHERE r.user_id = ? AND d.is_published = 1
         ORDER BY r.updated_at DESC, d.id DESC`,
      )
      .all(user.id);

    // средний балл остальных публичных участников по каждой банке
    const others = new Map(
      db
        .prepare(
          `SELECT r.drink_id, AVG(t.score) AS avg, COUNT(*) AS n
           FROM ratings r JOIN users u ON u.id = r.user_id JOIN tiers t ON t.id = r.tier_id
           WHERE u.is_active = 1 AND u.is_public = 1 AND r.user_id <> ?
           GROUP BY r.drink_id`,
        )
        .all(user.id)
        .map((row) => [row.drink_id, row]),
    );

    const distribution = Object.fromEntries(tiers.map((tier) => [tier.id, 0]));
    let scoreSum = 0;
    let diffSum = 0;
    let compared = 0;
    const ratings = rows.map((row) => {
      distribution[row.tier] = (distribution[row.tier] || 0) + 1;
      const score = scoreOf.get(row.tier) || 0;
      scoreSum += score;
      const other = others.get(row.id);
      let othersAvg = null;
      if (other) {
        othersAvg = Math.round(other.avg * 10) / 10;
        diffSum += Math.abs(score - other.avg);
        compared += 1;
      }
      return {
        drink: row.slug,
        brand: row.brand,
        name: row.name,
        flavor: row.flavor,
        edition: row.edition,
        image: row.image_path || "assets/favicon.svg",
        ...drinkImage(row),
        accent: [row.accent_a, row.accent_b],
        tier: row.tier,
        review: row.review,
        othersAvg,
        othersVotes: other?.n || 0,
        addedByUser: row.created_by === user.id,
        updatedAt: formatDate(row.updated_at),
      };
    });
    const added = db
      .prepare("SELECT COUNT(*) AS n FROM drinks WHERE created_by = ? AND is_published = 1")
      .get(user.id).n;
    const avg = ratings.length ? scoreSum / ratings.length : null;
    // 100% — ставит ровно как все; каждый тир расхождения в среднем = минус 25%
    const agreement = compared ? Math.max(0, Math.round(100 - (diffSum / compared) * 25)) : null;

    // Мягкая активность: день за днём по сетке 15 недель, серия, любимый день,
    // самый щедрый месяц. Всё из уже полученных дат — без новых тяжёлых запросов.
    const activityDays = new Map();
    const bumpDay = (value, field) => {
      const day = String(value || "").slice(0, 10);
      if (day.length !== 10) return;
      const entry = activityDays.get(day) || { date: day, ratings: 0, added: 0 };
      entry[field] += 1;
      activityDays.set(day, entry);
    };
    const addedRows = db
      .prepare("SELECT created_at FROM drinks WHERE created_by = ? AND is_published = 1")
      .all(user.id);

    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19).replace("T", " ");
    let lastAt = "";
    let last30 = 0;
    for (const rating of rows) {
      const at = String(rating.updated_at || "");
      if (at > lastAt) lastAt = at;
      if (at >= cutoff30) last30 += 1;
      bumpDay(at, "ratings");
    }
    for (const drink of addedRows) {
      const at = String(drink.created_at || "");
      if (at > lastAt) lastAt = at;
      bumpDay(at, "added");
    }

    const dateTs = (key) => Date.parse(`${key}T00:00:00Z`);
    const dayKeys = [...activityDays.keys()].sort();
    let streak = 0;
    if (dayKeys.length) {
      let cursor = dateTs(dayKeys.at(-1));
      for (let i = dayKeys.length - 1; i >= 0; i--) {
        if (dateTs(dayKeys[i]) !== cursor) break;
        streak += 1;
        cursor -= 86400000;
      }
    }
    const streakAlive =
      dayKeys.length > 0 && (dayKeys.at(-1) === todayKey || dateTs(todayKey) - dateTs(dayKeys.at(-1)) === 86400000);

    const weekdayCounts = new Array(7).fill(0);
    for (const day of activityDays.values()) {
      weekdayCounts[new Date(`${day.date}T00:00:00Z`).getUTCDay()] += day.ratings + day.added;
    }
    const bestWeekday = weekdayCounts.some(Boolean) ? weekdayCounts.indexOf(Math.max(...weekdayCounts)) : null;

    const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
    const monthTotals = [];
    for (let i = 5; i >= 0; i--) {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      monthTotals.push({
        key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
        label: MONTHS_SHORT[date.getUTCMonth()],
        count: 0,
      });
    }
    const monthByKey = new Map(monthTotals.map((month) => [month.key, month]));
    for (const day of activityDays.values()) {
      const month = monthByKey.get(day.date.slice(0, 7));
      if (month) month.count += day.ratings + day.added;
    }
    const topMonth = monthTotals.reduce((best, month) => (month.count > (best?.count || 0) ? month : best), null);

    const placeholders = PROFILE_HISTORY_ACTIONS.map(() => "?").join(", ");
    // История действий — закрытая штука: только сотрудник на профиле сотрудника.
    // Гостям и обычным участникам блок не показываем (клиент скрывает пустой).
    const isStaff = (row) => Boolean(row) && ["admin", "editor"].includes(row.role);
    const history = isStaff(req.user) && isStaff(user)
      ? db
          .prepare(
            `SELECT action, entity, entity_id AS slug, summary, details, created_at
             FROM audit_log
             WHERE user_id = ? AND action IN (${placeholders})
             ORDER BY id DESC LIMIT ?`,
          )
          .all(user.id, ...PROFILE_HISTORY_ACTIONS, PROFILE_HISTORY_LIMIT)
          .map((row) => ({
            action: row.action,
            entity: row.entity,
            slug: row.entity === "drink" || row.entity === "rating" ? row.slug : "",
            summary: String(row.summary || row.details || "").slice(0, 300),
            at: row.created_at,
          }))
      : [];

    res.json({
      profile: {
        ...userToParticipant(user),
        since: formatDate(user.created_at),
      },
      tiers,
      stats: {
        ratings: ratings.length,
        reviews: ratings.filter((rating) => rating.review.trim()).length,
        added,
        average: avg === null ? null : Math.round(avg * 100) / 100,
        agreement,
        distribution,
        activity: {
          heatmap: [...activityDays.values()].sort((a, b) => a.date.localeCompare(b.date)),
          streak,
          streakAlive,
          bestWeekday,
          topMonth: topMonth && topMonth.count ? { label: topMonth.label, count: topMonth.count } : null,
          last30,
          lastAt: lastAt || null,
        },
      },
      titles: {
        month: { key: monthly.monthKey, label: monthly.monthLabel },
        items: monthly.byUser.get(user.id) || [],
      },
      ratings,
      history,
    });
  });

  return router;
};
