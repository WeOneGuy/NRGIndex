const { setSetting } = require("../db");
const { slugify } = require("./validate");

const ACCENTS = [
  ["#ff4f79", "#ff7448"],
  ["#00b8d9", "#7ee6e1"],
  ["#8b3bc4", "#ef3ea6"],
  ["#39a844", "#b7e43b"],
  ["#f1c46c", "#ff7448"],
  ["#9fb7ff", "#cf8cff"],
];

function touchContent(db) {
  setSetting(db, "content_updated_at", new Date().toISOString());
}

// Версия публичного контента: по ней кэшируются OG-картинки и ETag-ответы.
// Если настройка ещё не создана (свежая база), берём максимум updated_at.
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

function uniqueSlug(db, base) {
  const root = slugify(base);
  let slug = root;
  for (let i = 1; i <= 60; i++) {
    const exists = db.prepare("SELECT 1 FROM drinks WHERE slug = ?").get(slug);
    if (!exists) return slug;
    slug = `${root}-${i + 1}`;
  }
  return `${root}-${Math.random().toString(36).slice(2, 10)}`;
}

function ratingsForDrink(db, drinkId) {
  const rows = db
    .prepare(
      `SELECT u.username AS user, r.tier_id AS tier, r.review, r.order_index AS "order"
       FROM ratings r JOIN users u ON u.id = r.user_id WHERE r.drink_id = ?`,
    )
    .all(drinkId);
  const map = {};
  for (const row of rows) {
    map[row.user] = { tier: row.tier, review: row.review, order: row.order };
  }
  return map;
}

function relationsForDrink(db, drinkId) {
  return db
    .prepare("SELECT related_id FROM drink_relations WHERE drink_id = ?")
    .all(drinkId)
    .map((row) => row.related_id);
}

// Слова для сравнения названий: нижний регистр, ё→е, без знаков, без «шумовых» слов.
const NOISE_WORDS = new Set([
  "energy", "drink", "drinks", "энергетик", "энергетический", "напиток", "вкус", "вкусом", "вкуса",
  "со", "и", "the", "original", "classic", "оригинал", "оригинальный", "классический", "классика",
  "can", "cans", "банка", "банки", "бутылка", "bottle", "мл", "ml", "литр", "литра",
]);

// Кириллица → латиница: чтобы «Ред Булл» и «Red Bull» сходились в одном алфавите.
const CYR_TO_LAT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

function translit(text) {
  let out = "";
  for (const ch of String(text || "")) out += CYR_TO_LAT[ch] ?? ch;
  return out;
}

// Грубая нормализация для сравнения строк: без регистра, диакритики, знаков, в латинице.
function normalizeTerm(text) {
  return translit(String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ё/g, "е"))
    .replace(/[^a-z0-9]/g, "");
}

// Кривой стемминг: снимает только очевидные плюрали (apples→apple, банки→банк).
function stem(word) {
  if (word.length > 3 && /[s]$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  if (word.length > 3 && /[ыий]$/.test(word)) return word.slice(0, -1);
  return word;
}

function matchWords(text) {
  const out = new Set();
  const folded = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ё/g, "е");
  for (const raw of folded.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || NOISE_WORDS.has(raw) || /^\d+$/.test(raw)) continue;
    for (const form of [raw, translit(raw)]) {
      if (!form) continue;
      out.add(form);
      out.add(stem(form));
    }
  }
  return [...out];
}

// Dice по биграммам символов: ловит опечатки и перестановки, которые наборы слов не видят.
function bigrams(text) {
  const s = normalizeTerm(text);
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function dice(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  if (!left.size || !right.size) return 0;
  let hit = 0;
  for (const gram of left) if (right.has(gram)) hit++;
  return (2 * hit) / (left.size + right.size);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const word of a) if (b.has(word)) inter++;
  return inter / (a.size + b.size - inter);
}

// Расстояние Левенштейна и его нормализованная версия 0..1 — ловит опечатки
// и перестановки, которые Dice по биграммам не видит на коротких словах.
function levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const next = [i];
    for (let j = 1; j <= t.length; j++) {
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = next;
  }
  return prev[t.length];
}

const levSim = (a, b) => {
  const s = String(a || "");
  const t = String(b || "");
  const max = Math.max(s.length, t.length);
  return max ? 1 - levenshtein(s, t) / max : 0;
};

// Похожесть двух слов: Dice по биграммам или Левенштейн, что лучше.
const wordSim = (a, b) => Math.max(dice(a, b), levSim(normalizeTerm(a), normalizeTerm(b)));

// Jaccard, где слова считаются совпавшими при wordSim >= threshold (жадно по парам).
function fuzzyJaccard(leftSet, rightSet, threshold = 0.8) {
  if (!leftSet.size || !rightSet.size) return 0;
  const left = [...leftSet];
  const right = [...rightSet];
  const pairs = [];
  for (let i = 0; i < left.length; i++) {
    for (let j = 0; j < right.length; j++) {
      const sim = left[i] === right[j] ? 1 : wordSim(left[i], right[j]);
      if (sim >= threshold) pairs.push([sim, i, j]);
    }
  }
  pairs.sort((a, b) => b[0] - a[0]);
  const usedLeft = new Set();
  const usedRight = new Set();
  let shared = 0;
  for (const [, i, j] of pairs) {
    if (usedLeft.has(i) || usedRight.has(j)) continue;
    usedLeft.add(i);
    usedRight.add(j);
    shared += 1;
  }
  return shared / (left.length + right.length - shared);
}

// Помечает слова из words «потреблёнными», если они фаззи-совпали со словами against.
function consumeMatching(words, against, consumed, threshold = 0.7) {
  for (const word of words) {
    if (consumed.has(word)) continue;
    for (const other of against) {
      if (wordSim(word, other) >= threshold) {
        consumed.add(word);
        break;
      }
    }
  }
}

function similarityReason(brandScore, score) {
  if (brandScore >= 0.99 && score >= 0.85) return "бренд и вкус совпали";
  if (brandScore >= 0.99) return "бренд совпал";
  if (brandScore >= 0.7) return "похожий бренд";
  return "совпало название или вкус";
}

/**
 * Ищет уже заведённые банки, похожие на { brand, name, flavor, edition } — чтобы
 * ИИ-поток не плодил дубли. Бренд сравнивается словами, Dice и Левенштейном
 * (опечатки STT и транслит — «Бёрн» ≈ «Burn», «Торк» ≈ «TORQ»), но чужой бренд
 * без общего слова проходить не может (brandScore >= 0.5). Название — Jaccard
 * по нормализованным словам + fuzzy-jaccard + Dice, при этом слова бренда
 * симметрично вычитаются с обеих сторон: перепутанные поля («всё название
 * в бренде» или «брендовая часть в названии») больше не ломают поиск.
 * Возвращает до `limit` лучших со score 0..1, уверенностью (high/medium) и причиной.
 */
function findSimilarDrinks(
  db,
  { brand = "", name = "", flavor = "", edition = "" } = {},
  { limit = 3, min = 0.6, includeHidden = false } = {},
) {
  const queryBrand = new Set(matchWords(brand));
  const queryAll = new Set([
    ...matchWords(brand),
    ...matchWords(name),
    ...matchWords(flavor),
    ...matchWords(edition),
  ]);
  if (!queryAll.size) return [];
  const queryBrandNorm = normalizeTerm(brand);

  const rows = db
    .prepare(
      `SELECT id, slug, brand, name, flavor, edition, image_path, is_published FROM drinks
       WHERE ? = 1 OR is_published = 1`,
    )
    .all(includeHidden ? 1 : 0);

  const scored = [];
  for (const row of rows) {
    const rowBrand = new Set(matchWords(row.brand));
    const rowAll = new Set([
      ...matchWords(row.brand),
      ...matchWords(row.name),
      ...matchWords(row.flavor),
      ...matchWords(row.edition),
    ]);
    const hasBrandPair = queryBrand.size > 0 && rowBrand.size > 0;

    let brandScore = 0;
    const consumedQuery = new Set();
    const consumedRow = new Set();
    if (hasBrandPair) {
      let exactShared = false;
      for (const word of queryBrand) {
        if (rowBrand.has(word)) {
          exactShared = true;
          consumedQuery.add(word);
        }
      }
      for (const word of rowBrand) if (queryBrand.has(word)) consumedRow.add(word);
      if (exactShared) {
        brandScore = 1;
      } else {
        brandScore = Math.max(dice(brand, row.brand), levSim(queryBrandNorm, normalizeTerm(row.brand)));
        if (brandScore < 0.5) continue; // чужой бренд, даже если вкус совпал
        consumeMatching(queryBrand, rowBrand, consumedQuery);
        consumeMatching(rowBrand, queryBrand, consumedRow);
      }
      // Симметрично убираем слова бренда из остальных полей с обеих сторон.
      consumeMatching(queryAll, consumedRow, consumedQuery);
      consumeMatching(rowAll, consumedQuery, consumedRow);
    }

    const queryRest = new Set([...queryAll].filter((word) => !consumedQuery.has(word)));
    const rowRest = new Set([...rowAll].filter((word) => !consumedRow.has(word)));

    let nameScore;
    if (!queryRest.size && !rowRest.size) {
      // назвали только бренд/голую банку — совпадает
      nameScore = 1;
    } else if (!queryRest.size || !rowRest.size) {
      // бренд совпал, а название/вкус разошлись — это разные банки
      nameScore = 0;
    } else {
      nameScore = Math.max(jaccard(queryRest, rowRest), fuzzyJaccard(queryRest, rowRest));
      // опечатки и порядок слов: Dice по отсортированным словам — «ultra whit» ≈ «ultra white»
      const queryWords = [...queryRest].sort().join("");
      const rowWords = [...rowRest].sort().join("");
      if (queryWords.length >= 4 && rowWords.length >= 4) {
        nameScore = Math.max(nameScore, dice(queryWords, rowWords));
      }
      let covered = 0;
      for (const word of queryRest) {
        for (const other of rowRest) {
          if (word === other || wordSim(word, other) >= 0.8) {
            covered += 1;
            break;
          }
        }
      }
      if (covered === queryRest.size) nameScore = Math.min(1, nameScore + 0.1);
      const rowNorm = normalizeTerm(`${row.name} ${row.flavor}`);
      const queryNorm = normalizeTerm(`${name} ${flavor}`);
      if (
        queryNorm.length >= 4 &&
        rowNorm.length >= 4 &&
        (queryNorm.includes(rowNorm) || rowNorm.includes(queryNorm))
      ) {
        nameScore = Math.min(1, nameScore + 0.1);
      }
      if (nameScore < 0.45) continue;
    }

    if (!hasBrandPair) {
      // одна сторона без бренда — сравниваем всё как название
      nameScore = Math.max(nameScore, jaccard(queryAll, rowAll), fuzzyJaccard(queryAll, rowAll));
    }

    const score = hasBrandPair ? 0.5 * brandScore + 0.5 * nameScore : nameScore;
    if (score >= min) scored.push({ row, score, brandScore });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.row.id - b.row.id)
    .slice(0, limit)
    .map(({ row, score, brandScore }) => ({
      slug: row.slug,
      brand: row.brand,
      name: row.name,
      flavor: row.flavor,
      image: row.image_path || "assets/favicon.svg",
      score: Math.round(score * 100) / 100,
      confidence: score >= 0.85 ? "high" : "medium",
      reason: similarityReason(brandScore, score),
      hidden: !row.is_published,
    }));
}

module.exports = {
  ACCENTS,
  touchContent,
  contentUpdatedAt,
  uniqueSlug,
  ratingsForDrink,
  relationsForDrink,
  findSimilarDrinks,
  matchWords,
};
