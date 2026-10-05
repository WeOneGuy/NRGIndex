// Статический анализ исходников: опасные вызовы, SQL, секреты, настройки auth,
// валидация загрузок и экранирование в клиенте. Работает без сети и сервера.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function listServerFiles() {
  const files = [];
  for (const dir of ["server", path.join("server", "lib"), path.join("server", "routes")]) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith(".js")) files.push(path.join(dir, name));
    }
  }
  return files;
}

test("security: нет eval, child_process и прочих опасных вызовов в сервере", () => {
  const forbidden = [
    [/require\(\s*["']node:child_process["']\s*\)/, "импорт child_process"],
    [/(?<![.\w$])eval\s*\(/, "eval("],
    [/new\s+Function\s*\(/, "new Function"],
    [/\bexecSync\s*\(/, "execSync("],
    [/\bexecFile\s*\(/, "execFile("],
    [/\bchild_process\b/, "child_process"],
    [/\bspawn\s*\(/, "spawn("],
  ];
  const problems = [];
  for (const file of listServerFiles()) {
    read(file)
      .split("\n")
      .forEach((line, index) => {
        for (const [re, label] of forbidden) {
          if (re.test(line)) problems.push(`${file}:${index + 1}: ${label}`);
        }
      });
  }
  assert.equal(problems.length, 0, `Опасные вызовы:\n${problems.join("\n")}`);
});

test("security: SQL собирается только из безопасных идентификаторов", () => {
  const SAFE = new Set([
    "table",
    "cols",
    "c",
    "column",
    "columns",
    "sets",
    "where",
    "order",
    "limit",
    "offset",
    "values",
    "placeholders",
    "sql",
    "query",
    "join",
  ]);
  const SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE|PRAGMA|CREATE|WITH|ALTER|DROP)\b/i;
  const USER_INPUT = /\$\{\s*(req|request|body|query|params|session|input|term|search|value)\b/;
  const problems = [];
  for (const file of listServerFiles()) {
    const parts = read(file).split(/\.(?:prepare|exec)\s*\(/).slice(1);
    parts.forEach((part, index) => {
      const quoteMatch = part.match(/^\s*(["'`])/);
      if (!quoteMatch) return;
      const quote = quoteMatch[1];
      const start = quoteMatch[0].length;
      const end = part.indexOf(quote, start);
      if (end < 0) return;
      const sql = part.slice(start, end);
      if (!SQL_START.test(sql)) return;
      const fragment = `фрагмент #${index + 1}`;
      if (USER_INPUT.test(sql)) {
        problems.push(`${file}: SQL содержит пользовательский ввод (${fragment})`);
      }
      for (const match of sql.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)/g)) {
        const ident = match[1];
        // разрешаем только известные безопасные идентификаторы и КОНСТАНТЫ_С_БОЛЬШИХ_БУКВ
        if (SAFE.has(ident) || /^[A-Z][A-Z0-9_]*$/.test(ident)) continue;
        problems.push(`${file}: неизвестная интерполяция \${${ident}} в SQL (${fragment})`);
      }
    });
  }
  assert.equal(problems.length, 0, `Небезопасный SQL:\n${problems.join("\n")}`);
});

test("security: в коде нет захардкоженных секретов", () => {
  const patterns = [
    [/sk-or-[A-Za-z0-9]{20,}/, "ключ OpenRouter"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "приватный ключ"],
    [/ghp_[A-Za-z0-9]{30,}/, "GitHub PAT"],
    [/github_pat_[A-Za-z0-9_]{30,}/, "GitHub fine-grained PAT"],
    [/NRG-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/, "ключ входа NRG"],
  ];
  const files = [
    ...listServerFiles(),
    "public/app.js",
    "public/cabinet.js",
    "public/profile.js",
    "admin/admin.js",
    "scripts/create-admin.js",
  ];
  const problems = [];
  for (const file of files) {
    read(file)
      .split("\n")
      .forEach((line, index) => {
        if (line.includes("XXXX")) return; // плейсхолдеры формата
        for (const [re, label] of patterns) {
          if (re.test(line)) problems.push(`${file}:${index + 1}: похоже на ${label}`);
        }
      });
  }
  assert.equal(problems.length, 0, `Секреты в коде:\n${problems.join("\n")}`);
});

test("security: пароли, сессии и cookie настроены безопасно", () => {
  const auth = read(path.join("server", "auth.js"));
  // Боевая стоимость по умолчанию 32768; тесты занижают её через SCRYPT_N.
  assert.match(auth, /process\.env\.SCRYPT_N\) \|\| 32768/, "scrypt по умолчанию должен быть 32768");
  assert.match(auth, /timingSafeEqual/, "сравнение хешей должно быть постоянным по времени");
  assert.match(auth, /createHash\(["']sha256["']\)/, "токен сессии должен храниться как sha256");
  assert.match(auth, /httpOnly:\s*true/, "cookie должна быть httpOnly");
  assert.match(auth, /sameSite:\s*["']lax["']/, "cookie должна быть SameSite=Lax");
  assert.match(auth, /secure:/, "cookie должна учитывать Secure");
  assert.match(auth, /sessionIdleDays/, "должно быть истечение по простою");
});

test("security: CSRF-защита включена", () => {
  const app = read(path.join("server", "app.js"));
  assert.match(app, /x-nrg-request/, "нужен обязательный заголовок X-NRG-Request");
  assert.match(app, /new URL\(origin\)/, "нужна проверка Origin");
});

test("security: загрузки валидируются по типу, сигнатуре и размеру", () => {
  const validate = read(path.join("server", "lib", "validate.js"));
  assert.match(validate, /MAGIC/, "проверка сигнатуры файла");
  assert.match(validate, /maxBytes/, "ограничение размера");
  const types = validate.match(/const IMAGE_TYPES = \{([^}]*)\}/);
  assert.ok(types, "IMAGE_TYPES должен быть описан в validate.js");
  const mimes = [...types[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
    assert.ok(mimes.includes(mime), `${mime} должен быть разрешён`);
  }
  assert.ok(!mimes.some((mime) => mime.includes("svg")), "SVG не должен входить в белый список");
});

test("security: клиент экранирует значения атрибутов в HTML", () => {
  const ALLOWED_CALL = /^(?:esc|safeColor|encodeURIComponent|Number|String)\(/;
  const ALLOWED_IDENT = new Set([
    "accent",
    "index",
    "id",
    "drink.id",
    "user.id",
    "tier.id",
    "row.id",
    "item.dataUrl",
  ]);
  const problems = [];
  for (const file of ["public/app.js", "public/cabinet.js", "public/profile.js", "public/drink-dialog.js", "admin/admin.js"]) {
    read(file)
      .split("\n")
      .forEach((line, lineIndex) => {
        for (const match of line.matchAll(
          /(?:src|href|style|alt|title|data-[a-z-]+)="\$\{([^}]*)\}/g,
        )) {
          const expr = match[1].trim();
          if (ALLOWED_CALL.test(expr) || ALLOWED_IDENT.has(expr)) continue;
          problems.push(`${file}:${lineIndex + 1}: без экранирования → \${${expr}}`);
        }
      });
  }
  assert.equal(problems.length, 0, `Неэкранированные подстановки:\n${problems.join("\n")}`);
});
