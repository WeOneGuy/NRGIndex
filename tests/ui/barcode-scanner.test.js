const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../../public/cabinet.js"), "utf8");

test("preview: TrueMark fields, proxy, full marking code and stale image guards", async () => {
  const elements = {};
  let imageResolve;
  let imageReject;
  let imageUrl;
  const raw = "0104680036912629215JuVJmTnOR:3H\x1D93kjJw";
  const data = { code: "4680036912629", rawCode: raw, product: { source: "truemark", name: "Energy", brand: "Brand", flavor: "Манго", image: "https://example.com/can.jpg" } };
  const sandbox = {
    barcodeBusy: false, autoScanGen: 1, camera: { mode: "code" }, pending: {},
    $: (id) => elements[id] ||= { open: true },
    api: async () => data, setCameraStatus() {}, renderSimilar() {}, showDupAck() {}, showPreview() {}, refreshPhotos() {}, updatePreviewImage() {},
    proxiedPhotoUrl: (url) => `api/cabinet/ai/photo-proxy?url=${encodeURIComponent(url)}`,
    processImageUrl: (url) => { imageUrl = url; return new Promise((resolve, reject) => { imageResolve = resolve; imageReject = reject; }); },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("  const barcodeNote ="), source.indexOf("  // Форматы, которые реально")) + "\nthis.lookup = lookupBarcode;", sandbox);
  await sandbox.lookup(raw);
  assert.equal(sandbox.pending.barcode, data.code);
  assert.equal(sandbox.pending.rawCode, raw);
  assert.equal(sandbox.pending.parsed.name, "Energy");
  assert.equal(sandbox.pending.parsed.brand, "Brand");
  assert.equal(sandbox.pending.parsed.flavor, "Манго");
  assert.match(imageUrl, /^api\/cabinet\/ai\/photo-proxy\?url=/);
  imageResolve("data:image/png;base64,ok");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sandbox.pending.image, "data:image/png;base64,ok");
  assert.equal(sandbox.pending.photoNote, "фото TrueMark ✓");
  await sandbox.lookup(raw);
  sandbox.pending.photoSource = "camera";
  sandbox.pending.photoNote = "моё фото";
  imageReject(new Error("stale"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sandbox.pending.photoNote, "моё фото");
  await sandbox.lookup(raw);
  sandbox.pending.barcode = "other";
  sandbox.pending.image = "new selection";
  imageResolve("old image");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sandbox.pending.image, "new selection");
  data.product.name = "Полное название ".repeat(20);
  await sandbox.lookup(raw);
  assert.equal(sandbox.pending.parsed.name, "");
  assert.ok(elements["smart-status"].textContent.includes(data.product.name));
});

test("scanner: bounded full frame/ROI variants keep edge coverage", () => {
  const draws = [];
  const context = {
    drawImage: (...args) => draws.push(args),
    getImageData: () => ({ data: new Uint8ClampedArray([40, 40, 40, 255]) }),
    putImageData: () => {},
  };
  const sandbox = { document: { createElement: () => ({ getContext: () => context }) } };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("  const scanVariant ="), source.indexOf("  const startAutoScan =")) + "\nthis.variant = scanVariant;", sandbox);
  for (let index = 0; index < 6; index++) {
    const canvas = sandbox.variant({ videoWidth: 3840, videoHeight: 2160 }, index);
    assert.ok(canvas.width <= 1280 && canvas.height <= 1280);
    const draw = draws.at(-1);
    assert.equal(draw[1], index % 2 ? 960 : 0);
    assert.equal(draw[3], index % 2 ? 1920 : 3840);
  }
});

test("scanner: older async start cannot schedule a stale loop", async () => {
  const pending = [];
  const timers = [];
  const sandbox = {
    camera: { mode: "code" },
    $: () => ({ open: true }),
    barcodeFormats: () => new Promise((resolve) => pending.push(resolve)),
    window: { BarcodeDetector: class {} },
    setCameraStatus: () => {},
    wasmDecode: async () => "",
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    NATIVE_GRACE_MS: 2500,
  };
  vm.createContext(sandbox);
  const stop = source.slice(source.indexOf("  let autoScanTimer"), source.indexOf("  const NATIVE_GRACE_MS"));
  const start = source.slice(source.indexOf("  const startAutoScan ="), source.indexOf("  const stopCamera ="));
  vm.runInContext(stop + start + "\nthis.start = startAutoScan; this.stop = stopAutoScan;", sandbox);
  const older = sandbox.start();
  const newer = sandbox.start();
  pending[0](["data_matrix"]);
  await older;
  assert.equal(timers.length, 0);
  pending[1](["data_matrix"]);
  await newer;
  assert.equal(timers.length, 1);
  sandbox.stop();
  await timers[0](); // Must return before touching camera/video or decoding.
  assert.equal(timers.length, 1);
});

test("wasmDecode: raw первым, Otsu-инверсия вторым, GS сохраняется", async () => {
  const wx = "0104680036912629215JuVJmTnOR:3H\x1D93kjJw";
  const calls = [];
  let rawFinds = false;
  const imageData = { width: 2, height: 1, data: new Uint8ClampedArray([10, 10, 10, 255, 200, 200, 200, 255]) };
  const canvas = { width: 2, height: 1, getContext: () => ({ getImageData: () => imageData }) };
  const sandbox = {
    window: {
      ZXingWASM: {
        setZXingModuleOverrides: () => { throw new Error("модуль уже загружен, overrides не нужны"); },
        readBarcodes: async (image, options) => {
          calls.push({ image, options });
          if (rawFinds || calls.length > 1) return [{ isValid: true, text: wx }];
          return [];
        },
      },
    },
    ImageData: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    },
  };
  vm.createContext(sandbox);
  const block = source.slice(source.indexOf("  // zxing-wasm из vendor"), source.indexOf("  // Сначала быстрый нативный детектор"));
  vm.runInContext(block + "\nthis.wasmDecode = wasmDecode;", sandbox);
  assert.equal(await sandbox.wasmDecode(canvas), wx, "точный GS из readBarcodes");
  assert.equal(calls.length, 2, "raw + одна инверсия, не больше двух проходов");
  assert.equal(
    JSON.stringify(calls[0].options),
    JSON.stringify({
      formats: ["DataMatrix", "EAN13", "EAN8", "UPCA", "UPCE", "Code128"],
      tryHarder: true, tryRotate: true, tryInvert: true, tryDenoise: true, tryDownscale: true,
      maxNumberOfSymbols: 1, textMode: "Plain",
    }),
  );
  assert.equal(calls[1].image.data[0], 255, "тёмный пиксель после инверсии белый");
  assert.equal(calls[1].image.data[4], 0, "светлый пиксель после инверсии чёрный");
  calls.length = 0;
  rawFinds = true;
  assert.equal(await sandbox.wasmDecode(canvas), wx);
  assert.equal(calls.length, 1, "при успехе raw инверсия не запускается");
});

test("live fallback: один серверный кадр за раз и только при свободной камере", async () => {
  const calls = [];
  const canvas = { toDataURL: () => "data:image/jpeg;base64,xx" };
  const sandbox = {
    camera: { busy: false, mode: "code" }, barcodeBusy: false, SERVER_SCAN_SIDE: 1024,
    scanVariant: (video, index, maxSide) => { assert.equal(index, 0); assert.equal(maxSide, 1024); return canvas; },
    $: () => ({ videoWidth: 1280, videoHeight: 720 }),
    api: async (method, path, body) => {
      calls.push([method, path, body.imageDataUrl]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return calls.length === 1 ? { found: true, code: "0104680036912629215JuVJmTnOR:3H\x1D93kjJw" } : { found: false };
    },
  };
  vm.createContext(sandbox);
  const block = source.slice(source.indexOf("  let serverScanBusy"), source.indexOf("  const startAutoScan ="));
  vm.runInContext(block + "\nthis.serverScanFrame = serverScanFrame;", sandbox);
  const [first, second] = await Promise.all([sandbox.serverScanFrame(), sandbox.serverScanFrame()]);
  assert.equal(first, "0104680036912629215JuVJmTnOR:3H\x1D93kjJw");
  assert.equal(second, "", "параллельный кадр не стакуется");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "api/cabinet/ai/barcode-scan");
  sandbox.camera.busy = true;
  assert.equal(await sandbox.serverScanFrame(), "");
  assert.equal(calls.length, 1);
});

test("live fallback: после локальной осечки код с сервера уходит в lookupBarcode", async () => {
  const timers = [];
  const lookups = [];
  const statuses = [];
  let now = 0;
  let serverCalls = 0;
  const elements = { "camera-dialog": { open: true }, "camera-video": { videoWidth: 1280, videoHeight: 720 } };
  const sandbox = {
    camera: { mode: "code", busy: false }, barcodeBusy: false, autoScanGen: 0, zxingReader: null,
    $: (id) => elements[id] ||= { open: true },
    barcodeFormats: async () => [],
    ensureZXingReader: async () => { sandbox.zxingReader = {}; },
    loadZXingWasm: async () => ({}),
    wasmDecoding: false, serverScanBusy: false,
    setCameraStatus: (text) => statuses.push(text),
    scanVariant: () => ({ toDataURL: () => "jpeg" }),
    wasmDecode: async () => "",
    zxingDecode: () => "",
    serverScanFrame: async () => { serverCalls++; return "0104680036912629215JuVJmTnOR:3H\x1D93kjJw"; },
    lookupBarcode: async (code) => { lookups.push(code); return true; },
    closeCamera: () => {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    Date: { now: () => now },
    NATIVE_GRACE_MS: 2500, SCAN_INTERVAL_MS: 150, SERVER_SCAN_MS: 2500, SERVER_SCAN_MAX: 24,
  };
  sandbox.stopAutoScan = () => { sandbox.autoScanGen += 1; timers.length = 0; };
  sandbox.window = { BarcodeDetector: class {} };
  vm.createContext(sandbox);
  const block = source.slice(source.indexOf("  const startAutoScan ="), source.indexOf("  const stopCamera ="));
  vm.runInContext(block + "\nthis.start = startAutoScan;", sandbox);
  await sandbox.start();
  assert.equal(timers.length, 1);
  now = 3000;
  await timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serverCalls, 1);
  assert.deepEqual(lookups, ["0104680036912629215JuVJmTnOR:3H\x1D93kjJw"]);
  assert.ok(statuses.includes("🔎 Смотрю кадр внимательнее…"));
});

test("live fallback: не больше 24 серверных кадров за сессию", async () => {
  const timers = [];
  let now = 0;
  let serverCalls = 0;
  const elements = { "camera-dialog": { open: true }, "camera-video": { videoWidth: 1280, videoHeight: 720 } };
  const sandbox = {
    camera: { mode: "code", busy: false }, barcodeBusy: false, autoScanGen: 0, zxingReader: null,
    $: (id) => elements[id] ||= { open: true },
    barcodeFormats: async () => [],
    ensureZXingReader: async () => { sandbox.zxingReader = {}; },
    loadZXingWasm: async () => ({}),
    wasmDecoding: false, serverScanBusy: false,
    setCameraStatus: () => {},
    scanVariant: () => ({ toDataURL: () => "jpeg" }),
    wasmDecode: async () => "",
    zxingDecode: () => "",
    serverScanFrame: async () => { serverCalls++; return ""; },
    lookupBarcode: async () => false,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    Date: { now: () => now },
    NATIVE_GRACE_MS: 2500, SCAN_INTERVAL_MS: 150, SERVER_SCAN_MS: 2500, SERVER_SCAN_MAX: 24,
  };
  sandbox.stopAutoScan = () => { sandbox.autoScanGen += 1; timers.length = 0; };
  sandbox.window = { BarcodeDetector: class {} };
  vm.createContext(sandbox);
  const block = source.slice(source.indexOf("  const startAutoScan ="), source.indexOf("  const stopCamera ="));
  vm.runInContext(block + "\nthis.start = startAutoScan;", sandbox);
  await sandbox.start();
  for (let i = 0; i < 26; i++) {
    now += 3000;
    await timers.shift().fn();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(serverCalls, 24);
});

test("live: pending wasm/server never stop native frames; first valid result wins", async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  for (const winner of ["native", "server", "stop", "mode", "native-pending"]) {
    const timers = [];
    const lookups = [];
    let nativeCalls = 0;
    let wasmCalls = 0;
    let serverCalls = 0;
    let resolveWasm;
    let resolveServer;
    let now = 5000;
    const expected = "0104680036912629215JuVJmTnOR:3H\x1D93kjJw";
    const dialog = { open: true };
    const sandbox = {
      camera: { mode: "code", busy: false }, barcodeBusy: false,
      autoScanGen: 0, zxingReader: {}, wasmDecoding: false, serverScanBusy: false,
      $: (id) => id === "camera-dialog" ? dialog : {},
      barcodeFormats: async () => ["ean_13", "data_matrix"],
      window: { BarcodeDetector: class {
        async detect() {
          nativeCalls++;
          if (winner === "native-pending") return new Promise(() => {});
          return winner === "native" && nativeCalls === 2 ? [{ rawValue: "4680036912629" }] : [];
        }
      } },
      scanVariant: () => ({}),
      wasmDecode: () => { wasmCalls++; return new Promise((resolve) => { resolveWasm = resolve; }); },
      serverScanFrame: () => { serverCalls++; return new Promise((resolve) => { resolveServer = resolve; }); },
      zxingDecode: () => "",
      setCameraStatus() {},
      lookupBarcode: async (code) => { lookups.push(code); return true; },
      closeCamera: () => { dialog.open = false; },
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      Date: { now: () => now },
      NATIVE_GRACE_MS: 2500, SCAN_INTERVAL_MS: 150, SERVER_SCAN_MS: 4000, SERVER_SCAN_MAX: 24,
    };
    sandbox.stopAutoScan = () => { sandbox.autoScanGen++; timers.length = 0; };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(source.indexOf("  const startAutoScan ="), source.indexOf("  const stopCamera =")) + "\nthis.start = startAutoScan;", sandbox);
    await sandbox.start();
    now += 3999;
    timers.shift().fn();
    await flush();
    assert.equal(serverCalls, 0, "server waits four seconds after start");
    nativeCalls = winner === "native-pending" ? nativeCalls : 0;
    now += 1;
    timers.shift().fn();
    await flush();
    assert.equal(nativeCalls, 1);
    assert.equal(wasmCalls, 1);
    assert.equal(serverCalls, 1);
    assert.equal(timers[0].ms, 150, "fresh tick scheduled while both promises pending");
    now += 5000;
    timers.shift().fn();
    await flush();
    assert.equal(nativeCalls, winner === "native-pending" ? 1 : 2);
    assert.equal(wasmCalls, 1, "no stacked wasm jobs");
    assert.equal(serverCalls, 1, "pending server job consumes no extra attempts");
    if (winner === "native") assert.deepEqual(lookups, ["4680036912629"], "EAN wins before either background promise resolves");
    if (winner === "stop") sandbox.stopAutoScan();
    if (winner === "mode") sandbox.camera.mode = "can";
    resolveServer(expected);
    await flush();
    resolveWasm(expected);
    await flush();
    assert.deepEqual(lookups, winner === "native" ? ["4680036912629"] : ["server", "native-pending"].includes(winner) ? [expected] : []);
    assert.ok(lookups.length <= 1);
  }
});

test("scanner: empty manual input keeps scanning; gallery failure offers retry, stale completion does not", async () => {
  const handlers = {};
  const elements = {};
  const sandbox = {
    camera: { mode: "code", busy: false }, barcodeBusy: false, autoScanGen: 0,
    $: (id) => elements[id] ||= { open: true, value: "", hidden: true, addEventListener: (event, fn) => { handlers[id] = fn; } },
    setCameraStatus: () => {},
    createImageBitmap: async () => ({ close() {} }),
    detectBarcode: async () => "",
    barcodeImageDataUrl: async () => "image",
    api: async () => ({ found: false }),
    lookupBarcode: async () => false,
    closeCamera: () => { elements["camera-dialog"].open = false; },
  };
  sandbox.stopAutoScan = () => { sandbox.autoScanGen++; };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('  $("camera-file").addEventListener'), source.indexOf('  $("camera-torch").onclick')), sandbox);
  const enter = () => handlers["camera-code"]({ key: "Enter", preventDefault() {} });
  await enter();
  assert.equal(sandbox.autoScanGen, 0);
  elements["camera-code"].value = "123";
  await enter();
  assert.equal(elements["btn-camera-shoot"].hidden, false);
  const gallery = () => handlers["camera-file"]({ target: { files: [{}] } });
  for (const error of [false, true]) {
    elements["btn-camera-shoot"].hidden = true;
    sandbox.api = async () => { if (error) throw new Error("offline"); return { found: false }; };
    await gallery();
    assert.equal(elements["btn-camera-shoot"].hidden, false);
    assert.equal(sandbox.camera.busy, false);
  }
  elements["btn-camera-shoot"].hidden = true;
  let finish;
  sandbox.detectBarcode = () => new Promise((resolve) => { finish = resolve; });
  const pending = gallery();
  await new Promise((resolve) => setImmediate(resolve));
  sandbox.stopAutoScan();
  finish("");
  await pending;
  assert.equal(elements["btn-camera-shoot"].hidden, true);
});
