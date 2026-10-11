// Титулы профиля: считаются вживую по всей истории — по активным публичным
// участникам и опубликованным банкам, ровно по тем же цифрам, что в статистике
// профиля. Ничьи — титул всем лидерам. Одному человеку достаётся не больше
// MAX_TITLES титулов: если все лидеры метрики уже набрали лимит, титул не вручается.

const MIN_AVG_RATINGS = 2;
const MIN_COMPARED = 2;
const MAX_TITLES = 3;

// Склонение существительного по числу — как wordForm в public/profile.js.
const plural = (n, one, few, many) => {
  const n100 = Math.abs(n) % 100;
  const n10 = n100 % 10;
  return n100 > 10 && n100 < 20 ? many : n10 === 1 ? one : n10 > 1 && n10 < 5 ? few : many;
};

const avgFmt = (avg) => (Math.round(avg * 10) / 10).toFixed(1).replace(".", ",");

function computeTitles(db) {
  const ratingRows = db
    .prepare(
      `SELECT r.user_id, r.drink_id, r.review, t.score
       FROM ratings r
       JOIN tiers t ON t.id = r.tier_id
       JOIN drinks d ON d.id = r.drink_id
       JOIN users u ON u.id = r.user_id
       WHERE u.is_active = 1 AND u.is_public = 1 AND d.is_published = 1`,
    )
    .all();
  const addedRows = db
    .prepare(
      `SELECT created_by AS user_id, COUNT(*) AS n
       FROM drinks
       WHERE is_published = 1 AND created_by IS NOT NULL
       GROUP BY created_by`,
    )
    .all();
  const opinionRows = db
    .prepare(
      `SELECT r.drink_id, SUM(t.score) AS sum, COUNT(*) AS n
       FROM ratings r
       JOIN tiers t ON t.id = r.tier_id
       JOIN drinks d ON d.id = r.drink_id
       JOIN users u ON u.id = r.user_id
       WHERE u.is_active = 1 AND u.is_public = 1 AND d.is_published = 1
       GROUP BY r.drink_id`,
    )
    .all();
  const participants = db.prepare("SELECT id FROM users WHERE is_active = 1 AND is_public = 1").all();

  const opinion = new Map(opinionRows.map((row) => [row.drink_id, { sum: row.sum, n: row.n }]));
  const stats = new Map(
    participants.map(({ id }) => [
      id,
      { ratings: 0, reviewChars: 0, scoreSum: 0, added: 0, compared: 0, diffSum: 0 },
    ]),
  );

  for (const row of ratingRows) {
    const stat = stats.get(row.user_id);
    if (!stat) continue;
    stat.ratings += 1;
    stat.reviewChars += String(row.review || "").trim().length;
    stat.scoreSum += row.score;
    // Сравнение со столом — ровно формула профиля: средний балл остальных
    // публичных участников по той же банке, только по опубликованным банкам.
    const table = opinion.get(row.drink_id);
    if (table?.n > 1) {
      stat.diffSum += Math.abs(row.score - (table.sum - row.score) / (table.n - 1));
      stat.compared += 1;
    }
  }
  for (const row of addedRows) {
    const stat = stats.get(row.user_id);
    if (stat) stat.added = row.n;
  }
  for (const stat of stats.values()) {
    stat.avg = stat.ratings ? stat.scoreSum / stat.ratings : null;
    stat.agreement = stat.compared ? Math.max(0, Math.round(100 - (stat.diffSum / stat.compared) * 25)) : null;
  }

  const byUser = new Map();
  const counts = new Map();
  const entries = [...stats.entries()];

  // Порядок вызовов grant() задаёт порядок титулов у человека. Лидеры метрики
  // получают титул, пока не упёрлись в MAX_TITLES; если все лидеры упёрлись,
  // титул не вручается никому — следующему по метрике его не отдаём.
  const grant = (id, label, candidates, valueOf, mode, hintOf) => {
    if (!candidates.length) return;
    const values = candidates.map(valueOf);
    const target = mode === "min" ? Math.min(...values) : Math.max(...values);
    const winners = candidates
      .filter((entry) => valueOf(entry) === target)
      .filter(([userId]) => (counts.get(userId) || 0) < MAX_TITLES);
    for (const [userId, stat] of winners) {
      counts.set(userId, (counts.get(userId) || 0) + 1);
      const items = byUser.get(userId) || [];
      items.push({ id, label, hint: hintOf(stat) });
      byUser.set(userId, items);
    }
  };

  grant(
    "rater",
    "Главный оцениватель",
    entries.filter(([, stat]) => stat.ratings >= 1),
    ([, stat]) => stat.ratings,
    "max",
    (stat) => `Больше всех оценок: ${stat.ratings}`,
  );
  grant(
    "detailed",
    "Самый подробный",
    entries.filter(([, stat]) => stat.reviewChars > 0),
    ([, stat]) => stat.reviewChars,
    "max",
    (stat) =>
      `Больше всех текста в отзывах: ${stat.reviewChars} ${plural(stat.reviewChars, "знак", "знака", "знаков")}`,
  );
  grant(
    "discoverer",
    "Первооткрыватель",
    entries.filter(([, stat]) => stat.added >= 1),
    ([, stat]) => stat.added,
    "max",
    (stat) => `Больше всех новых банок: ${stat.added}`,
  );

  const voiced = entries.filter(([, stat]) => stat.compared >= MIN_COMPARED);
  const voiceSet = voiced.length >= 2 ? voiced : [];
  grant(
    "voice",
    "Голос стола",
    voiceSet,
    ([, stat]) => stat.agreement,
    "max",
    (stat) => `Согласие со столом ${stat.agreement}%`,
  );
  const voiceValues = voiceSet.map(([, stat]) => stat.agreement);
  const voiceSpread = voiceSet.length >= 2 && Math.min(...voiceValues) < Math.max(...voiceValues);
  if (voiceSpread) {
    grant(
      "rebel",
      "Бунтарь",
      voiceSet,
      ([, stat]) => stat.agreement,
      "min",
      (stat) => `Согласие со столом ${stat.agreement}% — реже всех`,
    );
  }

  const averaged = entries.filter(([, stat]) => stat.ratings >= MIN_AVG_RATINGS);
  const avgValues = averaged.map(([, stat]) => stat.avg);
  const avgSpread = averaged.length >= 2 && Math.min(...avgValues) < Math.max(...avgValues);
  if (avgSpread) {
    grant(
      "generous",
      "Самый щедрый",
      averaged,
      ([, stat]) => stat.avg,
      "max",
      (stat) => `Средний балл ${avgFmt(stat.avg)} — выше всех`,
    );
    grant(
      "strict",
      "Самый строгий",
      averaged,
      ([, stat]) => stat.avg,
      "min",
      (stat) => `Средний балл ${avgFmt(stat.avg)} — ниже всех`,
    );
  }

  return { byUser };
}

module.exports = { computeTitles };
