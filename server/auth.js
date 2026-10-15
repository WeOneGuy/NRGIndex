const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { unauthorized, forbidden, tooMany } = require("./lib/errors");

const scrypt = promisify(crypto.scrypt);
// Стоимость scrypt: в бою 32768, в тестах helpers.js ставит 1024 — схема та же,
// просто ниже цена (проверка всегда идёт с N из самого хэша).
const SCRYPT = { N: Number(process.env.SCRYPT_N) || 32768, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };
const SESSION_COOKIE = "nrg_session";
const LOGIN_WINDOW = "-15 minutes";
const LOGIN_MAX_PER_USER = 5;
const LOGIN_MAX_PER_IP = 30;
const DUMMY_HASH =
  "scrypt$32768$8$1$O3tdaIoax4ADfMHtnvwAcw==$sYAzxCvg4G1l0C9D1vqzAyhdFb/obmBiTlSxU8J83dnTGuqDKKmRByuG69iC63+GLaLbRbDzoZdoZysrYPRu/Q==";

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function verifyPassword(stored, password) {
  if (typeof stored !== "string" || !stored.startsWith("scrypt$")) return false;
  const parts = stored.split("$");
  if (parts.length !== 6) return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  if (!salt.length || !expected.length) return false;
  const key = await scrypt(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

function createAuth(db, config) {
  const ttlMs = config.sessionTtlDays * 24 * 60 * 60 * 1000;
  const idleDays = Number(config.sessionIdleDays) || 30;
  // Куку переставляем при возврате пользователя: не чаще раза в сутки и не позже
  // четверти TTL — так активная сессия не умирает от Max-Age куки.
  const cookieRefreshMs = Math.min(24 * 60 * 60 * 1000, ttlMs / 4);
  // Запись last_seen_at — тоже не на каждый запрос: активность и так продлевают
  // при каждом заходе, а окно простоя измеряется днями. Раз в 5 минут достаточно.
  const touchIntervalMs = 5 * 60 * 1000;

  // 'YYYY-MM-DD HH:MM:SS' из SQLite (UTC) → timestamp
  const parseDbDate = (value) => Date.parse(String(value || "").replace(" ", "T") + "Z") || 0;

  const stmt = {
    insertSession: db.prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES (?, ?, datetime('now', ?), ?, ?)",
    ),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    deleteUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
    findSession: db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role, u.title, u.is_active,
             u.must_change_password, u.initials, u.color, u.avatar_path, u.is_public, s.last_seen_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')
        AND s.last_seen_at > datetime('now', ?)
    `),
    touchSession: db.prepare(
      "UPDATE sessions SET last_seen_at = datetime('now'), expires_at = datetime('now', ?) WHERE token_hash = ?",
    ),
    cleanup: db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')"),
    // Журнал попыток входа нужен только для окна rate-limit (15 минут) — старьё чистим.
    cleanupAttempts: db.prepare("DELETE FROM login_attempts WHERE created_at < datetime('now', '-30 days')"),
    recordAttempt: db.prepare(
      "INSERT INTO login_attempts (username, ip, success) VALUES (?, ?, ?)",
    ),
    recentUserFailures: db.prepare(
      `SELECT COUNT(*) AS n FROM login_attempts
       WHERE ip = ? AND username = ? AND success = 0 AND created_at > datetime('now', ?)`,
    ),
    recentIpFailures: db.prepare(
      `SELECT COUNT(*) AS n FROM login_attempts
       WHERE ip = ? AND success = 0 AND created_at > datetime('now', ?)`,
    ),
  };

  function createSession(userId, req) {
    const token = crypto.randomBytes(32).toString("base64url");
    stmt.insertSession.run(
      hashToken(token),
      userId,
      `+${config.sessionTtlDays} days`,
      String(req.ip || "").slice(0, 64),
      String(req.get("user-agent") || "").slice(0, 300),
    );
    return token;
  }

  function destroySession(token) {
    if (token) stmt.deleteSession.run(hashToken(token));
  }

  function destroyUserSessions(userId) {
    stmt.deleteUserSessions.run(userId);
  }

  function userFromRequest(req, res) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return null;
    const tokenHash = hashToken(token);
    const row = stmt.findSession.get(tokenHash, `-${idleDays} days`);
    if (!row || !row.is_active) return null;
    const seenAt = parseDbDate(row.last_seen_at);
    if (Date.now() - seenAt > touchIntervalMs) {
      stmt.touchSession.run(`+${config.sessionTtlDays} days`, tokenHash);
    }
    // Скользящая сессия: активность продлевает и БД-запись, и куку в браузере.
    // Без перестановки куки браузер выкинул бы её через TTL после входа.
    if (res && Date.now() - seenAt > cookieRefreshMs) {
      setSessionCookie(res, req, token);
    }
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      title: row.title,
      mustChangePassword: Boolean(row.must_change_password),
      initials: row.initials,
      color: row.color,
      avatar: row.avatar_path || "",
      isPublic: Boolean(row.is_public),
    };
  }

  function setSessionCookie(res, req, token) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure:
        config.cookieSecure === "true" || (config.cookieSecure === "auto" && Boolean(req.secure)),
      maxAge: ttlMs,
      path: "/",
    });
  }

  function clearSessionCookie(res) {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
  }

  const requireAuth = (req, res, next) => (req.user ? next() : next(unauthorized()));
  const requireRole =
    (...roles) =>
    (req, res, next) => {
      if (!req.user) return next(unauthorized());
      if (!roles.includes(req.user.role)) return next(forbidden());
      return next();
    };

  function checkLoginAllowed(ip, username) {
    const perIp = stmt.recentIpFailures.get(String(ip || ""), LOGIN_WINDOW);
    if (perIp.n >= LOGIN_MAX_PER_IP) {
      throw tooMany("Слишком много неудачных попыток. Подождите 15 минут.");
    }
    const perUser = stmt.recentUserFailures.get(String(ip || ""), String(username || ""), LOGIN_WINDOW);
    if (perUser.n >= LOGIN_MAX_PER_USER) {
      throw tooMany("Слишком много попыток для этого логина. Подождите 15 минут.");
    }
  }

  function recordLogin(username, ip, success) {
    stmt.recordAttempt.run(
      String(username || "").slice(0, 64),
      String(ip || "").slice(0, 64),
      success ? 1 : 0,
    );
  }

  const cleanupTimer = setInterval(() => {
    try {
      stmt.cleanup.run();
      stmt.cleanupAttempts.run();
    } catch {
      /* база может быть закрыта при остановке */
    }
  }, 60 * 60 * 1000);
  cleanupTimer.unref?.();

  return {
    createSession,
    destroySession,
    destroyUserSessions,
    userFromRequest,
    setSessionCookie,
    clearSessionCookie,
    requireAuth,
    requireRole,
    checkLoginAllowed,
    recordLogin,
    SESSION_COOKIE,
  };
}

module.exports = { hashPassword, verifyPassword, hashToken, createAuth, SESSION_COOKIE, DUMMY_HASH };
