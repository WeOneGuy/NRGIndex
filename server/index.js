const config = require("./config");
const { openDatabase } = require("./db");
const { createApp } = require("./app");
const { warmBarcodeDecoder } = require("./lib/barcode");

const db = openDatabase(config.dbPath);
const app = createApp({ db, config });

const server = app.listen(config.port, config.host, () => {
  console.log(`[nrgindex] listening on http://${config.host}:${config.port}`);
  console.log(`[nrgindex] db: ${config.dbPath}`);
  console.log(`[nrgindex] uploads: ${config.uploadsDir}`);
  // Fire-and-forget: wasm-декодер сканера подтягивается в фоне, чтобы не задерживать старт.
  warmBarcodeDecoder().catch(() => {});
});
// Держим upstream-соединения дольше nginx: дефолтные 5 секунд дают лишние
// переподключения на каждый заход при обратном прокси.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

function shutdown(signal) {
  console.log(`[nrgindex] ${signal}: shutting down`);
  server.close(() => {
    try {
      // Оптимизация запланирована именно на закрытие: SQLite сам решит, какие
      // статистики/индексы стоит тронуть, и не будет делать это на горячую.
      db.pragma("optimize");
    } catch {
      /* база могла уже закрыться — не мешаем остановке */
    }
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
