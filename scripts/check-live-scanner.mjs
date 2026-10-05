// Whole-page camera integration test.
// Usage: CHROME_BIN=/path/to/chrome-headless-shell node scripts/check-live-scanner.mjs
// Uses createApp + a disposable DB and real login. Only product/photo-search
// responses and the intentionally pending server scan are stubbed; no decoder
// is mocked. captureStream is a reproducible video input, not a physical camera.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { startServer, createUser, login } = require("../tests/helpers.js");
const { ean13Png } = require("../tests/helpers/ean13.js");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHROME_BIN = process.env.CHROME_BIN || "/tmp/opencode/chrome/chrome-headless-shell-linux64/chrome-headless-shell";
const EXPECTED_EAN = "4680036912629";
const EXPECTED_DM = "0104680036912629215JuVJmTnOR:3H\x1D93kjJw";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pageInjection({ code, imageDataUrl, frameDelayMs, hangServerScan = false, productName }) {
  return `(() => {
    const jsonResponse = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    const config = ${JSON.stringify({ code, imageDataUrl, frameDelayMs, hangServerScan, productName })};
    window.__liveScanner = { lookupRequests: [], serverScanRequests: [], presentedAt: 0, lookupAt: 0 };
    delete window.BarcodeDetector;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      if (url.pathname === "/api/cabinet/ai/barcode") {
        const event = { code: JSON.parse(init?.body || "{}").code, at: performance.now() };
        window.__liveScanner.lookupRequests.push(event);
        window.__liveScanner.lookupAt = event.at;
        return jsonResponse({
          code: ${JSON.stringify(EXPECTED_EAN)},
          kind: config.code === ${JSON.stringify(EXPECTED_DM)} ? "datamatrix" : "ean",
          rawCode: config.code === ${JSON.stringify(EXPECTED_DM)} ? config.code : undefined,
          inIndex: null,
          product: { source: "e2e", brand: "E2E Brand", name: config.productName, flavor: "E2E Flavor", image: "" },
          similar: [],
        });
      }
      if (url.pathname === "/api/cabinet/ai/barcode-scan") {
        window.__liveScanner.serverScanRequests.push({ at: performance.now() });
        if (config.hangServerScan) return new Promise(() => {});
      }
      if (url.pathname === "/api/cabinet/ai/photo-search") return jsonResponse({ images: [] });
      return originalFetch(input, init);
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      const image = new Image();
      image.src = config.imageDataUrl;
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context.fillStyle = "#777";
      context.fillRect(0, 0, canvas.width, canvas.height);
      const stream = canvas.captureStream(15);
      setTimeout(() => {
        context.drawImage(image, 0, 0);
        window.__liveScanner.presentedAt = performance.now();
      }, config.frameDelayMs);
      return stream;
    };
  })()`;
}

async function cdpPage(base, cookie, injection) {
  const debugPort = 9600 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "live-scanner-"));
  const chrome = spawn(CHROME_BIN, [
    "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore", detached: true });
  let spawnError;
  chrome.on("error", (error) => { spawnError = error; });
  let ws;
  try {
    await sleep(1800);
    if (spawnError) throw spawnError;
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    const page = pages.find((item) => item.type === "page");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    };
    await new Promise((resolve) => { ws.onopen = resolve; });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const commandId = ++id;
      const timer = setTimeout(() => { pending.delete(commandId); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      pending.set(commandId, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message);
      });
      ws.send(JSON.stringify({ id: commandId, method, params }));
    });
    const evaluate = async (expression, awaitPromise = false) => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
      if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.exception?.description || "browser evaluation failed");
      return result.result?.result?.value;
    };
    await command("Page.enable");
    await command("Runtime.enable");
    await command("Network.enable");
    const cookieValue = cookie.split("=", 2)[1].split(";", 1)[0];
    await command("Network.setCookie", { name: "nrg_session", value: cookieValue, url: base + "/" });
    await command("Page.addScriptToEvaluateOnNewDocument", { source: injection });
    await command("Page.navigate", { url: base + "/cabinet" });
    await sleep(1500);
    if (!await evaluate("!('BarcodeDetector' in window) && !document.querySelector('#cab-view').hidden")) throw new Error("Expected authenticated cabinet without BarcodeDetector");
    await evaluate("document.querySelector('#btn-camera').click()");
    await sleep(700);
    await evaluate("document.querySelector('[data-camera-mode=code]').click()");
    const deadline = Date.now() + 15000;
    let state;
    do {
      await sleep(150);
      state = await evaluate(`(() => ({
        scanner: window.__liveScanner,
        dialogOpen: document.querySelector('#camera-dialog')?.open,
        name: document.querySelector('#parsed-name')?.value || '',
        brand: document.querySelector('#parsed-brand')?.value || '',
        flavor: document.querySelector('#parsed-flavor')?.value || '',
        wasmLoaded: performance.getEntriesByType('resource').some((entry) => entry.name.endsWith('/zxing_reader.wasm')),
        status: document.querySelector('#camera-status')?.textContent || '',
      }))()`);
    } while (Date.now() < deadline && (!state.scanner.lookupRequests.length || state.dialogOpen));
    await sleep(1000); // Give late background results time to expose duplicate lookups.
    state.scanner = await evaluate("window.__liveScanner");
    return state;
  } finally {
    ws?.close();
    if (chrome.exitCode === null && !spawnError) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      process.kill(-chrome.pid, "SIGKILL");
      await exited;
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function run() {
  if (!fs.existsSync(CHROME_BIN)) throw new Error(`Chrome not found: ${CHROME_BIN}`);
  const ctx = await startServer();
  try {
    await createUser(ctx.db, { username: "browser-e2e", password: "browser-e2e-pass", displayName: "Browser E2E" });
    const { cookie } = await login(ctx.base, "browser-e2e", "browser-e2e-pass");
    const eanPng = await ean13Png("468003691262");
    const dmJpeg = fs.readFileSync(path.join(ROOT, "tests/fixtures/dm-can-top.jpg"));
    const scenarios = [
      { name: "EAN local wasm", code: EXPECTED_EAN, imageDataUrl: `data:image/png;base64,${eanPng.toString("base64")}`, frameDelayMs: 1000, productName: "E2E EAN" },
      { name: "Data Matrix local wasm", code: EXPECTED_DM, imageDataUrl: `data:image/jpeg;base64,${dmJpeg.toString("base64")}`, frameDelayMs: 1000, productName: "E2E Data Matrix" },
      { name: "server pending while local frames continue", code: EXPECTED_EAN, imageDataUrl: `data:image/png;base64,${eanPng.toString("base64")}`, frameDelayMs: 6500, hangServerScan: true, productName: "E2E delayed EAN" },
    ];
    for (const scenario of scenarios) {
      const injection = pageInjection(scenario);
      const started = Date.now();
      const result = await cdpPage(ctx.base, cookie, injection);
      const lookup = result.scanner.lookupRequests;
      if (lookup.length !== 1) throw new Error(`${scenario.name}: expected one lookup, got ${lookup.length}`);
      if (lookup[0].code !== scenario.code) throw new Error(`${scenario.name}: wrong code ${JSON.stringify(lookup[0].code)}`);
      if (result.dialogOpen) throw new Error(`${scenario.name}: dialog remained open`);
      if (result.name !== scenario.productName || result.brand !== "E2E Brand" || result.flavor !== "E2E Flavor") throw new Error(`${scenario.name}: preview not populated`);
      if (!result.wasmLoaded) throw new Error(`${scenario.name}: local vendored WASM not loaded`);
      if (scenario.hangServerScan && (result.scanner.serverScanRequests.length !== 1 || result.scanner.serverScanRequests[0].at >= result.scanner.presentedAt)) throw new Error(`${scenario.name}: expected one server scan pending before frame presentation`);
      if (!scenario.hangServerScan && result.scanner.serverScanRequests.length) throw new Error(`${scenario.name}: unexpectedly used server decode`);
      const elapsed = lookup[0].at - result.scanner.presentedAt;
      if (!result.scanner.presentedAt || elapsed < 0) throw new Error(`${scenario.name}: invalid presentation timing`);
      console.log(`${scenario.name}: PASS code=${JSON.stringify(lookup[0].code)} frame->lookup=${Math.round(elapsed)}ms wall=${Date.now() - started}ms serverScans=${result.scanner.serverScanRequests.length}`);
    }
  } finally {
    await ctx.close();
  }
}

run().catch((error) => {
  console.error("live scanner E2E FAILED:", error);
  process.exitCode = 1;
});
