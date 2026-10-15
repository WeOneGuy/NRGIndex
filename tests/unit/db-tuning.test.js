// Тюнинг базы: PRAGMA под нагрузку и прозрачный кэш prepared-стейтментов.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("../../server/db");

test("база: WAL, NORMAL и память под сортировки", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrg-db-tuning-"));
  const db = openDatabase(path.join(dir, "tuning.db"));
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("synchronous", { simple: true }), 1, "synchronous должен быть NORMAL");
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(db.pragma("temp_store", { simple: true }), 2, "temp_store должен быть MEMORY");
  assert.equal(db.pragma("cache_size", { simple: true }), -8000);
  assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("база: одинаковый SQL переиспользует один стейтмент", () => {
  const db = openDatabase(":memory:");
  const first = db.prepare("SELECT 1 AS one");
  const second = db.prepare("SELECT 1 AS one");
  assert.equal(first, second, "стейтмент должен кэшироваться по SQL");
  assert.equal(second.get().one, 1);
  assert.notEqual(first, db.prepare("SELECT 2 AS two"));
  db.close();
});
