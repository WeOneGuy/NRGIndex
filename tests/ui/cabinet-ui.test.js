const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const cabinetSource = fs.readFileSync(path.join(__dirname, "..", "..", "public", "cabinet.js"), "utf8");
const cabinetHtml = fs.readFileSync(path.join(__dirname, "..", "..", "public", "cabinet.html"), "utf8");
const cabinetRoutes = fs.readFileSync(path.join(__dirname, "..", "..", "server", "routes", "cabinet.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(__dirname, "..", "..", "public", "styles.css"), "utf8");

test("Data Matrix: подсказка верха банки, квадрат и текстовый ручной код", () => {
  assert.match(cabinetHtml, /Data Matrix \/ штрих-код/);
  assert.match(cabinetHtml, /id="camera-code"[^>]*inputmode="text"/);
  assert.match(cabinetSource, /Data Matrix обычно на верху банки/);
  assert.match(stylesSource, /camera-stencil\[data-mode="code"\]::after[^\n]*aspect-ratio: 1/);
  assert.match(cabinetSource, /body\.barcode = pending\.barcode/);
  assert.doesNotMatch(cabinetSource, /body\.(?:barcode|rawCode) = pending\.rawCode/);
});

test("кабинет показывает красную кнопку удаления оценки", () => {
  assert.match(cabinetSource, /<button class=\"btn btn--danger\" type=\"button\" data-m-del-rating>удалить<\/button>/);
  assert.doesNotMatch(cabinetSource, /data-m-del-rating>− оценка<\/button>/);
});

test("кнопка удаления оценки сохраняет DELETE обработчик", () => {
  const handlerStart = cabinetSource.indexOf('row.querySelector("[data-m-del-rating]")');
  assert.notEqual(handlerStart, -1);
  const handler = cabinetSource.slice(handlerStart, cabinetSource.indexOf('row.querySelector("[data-m-del-drink]")', handlerStart));
  assert.match(handler, /api\("DELETE", `api\/cabinet\/ratings\/\$\{encodeURIComponent\(slug\)\}`\)/);
});

test("ленты фото дожимают через прокси при хотлинк-бане, а не молча пустуют", () => {
  assert.match(cabinetSource, /loadImageWithFallback/);
  assert.match(cabinetSource, /dataset\.proxied/);
  assert.match(cabinetSource, /api\/cabinet\/ai\/photo-proxy\?url=/);
  assert.match(cabinetRoutes, /router\.get\("\/ai\/photo-proxy"/);
});

test("кнопки перерисовки на белом фоне есть в смарт-форме и редакторе мнения", () => {
  assert.match(cabinetHtml, /id="btn-redraw"/);
  assert.match(cabinetHtml, /id="op-photo-redraw"/);
  assert.match(cabinetHtml, /🍌 Перерисовать/);
  assert.match(cabinetHtml, /если ракурс плохой или фон удалился криво/);
  assert.match(cabinetSource, /api\("POST", "api\/cabinet\/ai\/photo-redraw"/);
  assert.match(cabinetRoutes, /router\.post\("\/ai\/photo-redraw"/);
});

test("перерисовка шлёт необработанный оригинал, а зелёный хромакей снимает заливкой", () => {
  assert.match(cabinetSource, /originalDataUrl/);
  assert.match(cabinetSource, /cutGreenBg/);
  assert.match(cabinetSource, /finishRedrawn/);
  assert.match(cabinetSource, /НЕОБРАБОТАННЫЙ оригинал/);
  assert.match(cabinetSource, /g - Math\.max\(r, b\)/, "градиент хромакея режется по доминированию зелёного");
  assert.match(cabinetSource, /g - Math\.max\(r, b\) > 60/, "режем только насыщенный зелёный, не белую часть банки");
  assert.doesNotMatch(cabinetSource, /g - Math\.max\(r, b\) > 25/, "слабый порог съедал белые части банки");
  assert.match(cabinetSource, /canFill/, "заливка идёт только через не-контур — и в белом, и в зелёном резце");
});

test("OpenRouter-перерисовку кабинет не режет и сохраняет прозрачность", () => {
  assert.match(cabinetSource, /provider === "openrouter"/);
  assert.match(cabinetSource, /shrinkPng/);
  assert.match(cabinetSource, /toDataURL\("image\/png"\)/);
  assert.match(cabinetSource, /прозрачный фон/);
  assert.match(cabinetRoutes, /redrawCanOnTransparent/);
  assert.match(cabinetRoutes, /provider: viaOpenRouter \? "openrouter" : "gemini"/);
});

test("камера: одна кнопка вместо фото, скана и поиска, режимы и ручной код", () => {
  assert.match(cabinetHtml, /id="btn-camera"/);
  assert.doesNotMatch(cabinetHtml, /id="smart-photo"/);
  assert.doesNotMatch(cabinetHtml, /id="smart-barcode"/);
  assert.doesNotMatch(cabinetHtml, /id="btn-barcode-lookup"/);
  assert.match(cabinetHtml, /id="camera-dialog"/);
  assert.match(cabinetHtml, /data-camera-mode="can"/);
  assert.match(cabinetHtml, /data-camera-mode="code"/);
  assert.match(cabinetHtml, /id="camera-code"/);
  assert.match(cabinetHtml, /id="camera-file"/);
  assert.match(cabinetSource, /getUserMedia/);
  assert.match(cabinetSource, /BarcodeDetector/);
  assert.match(cabinetSource, /data_matrix/);
  assert.match(cabinetSource, /api\("POST", "api\/cabinet\/ai\/barcode", \{ code \}\)/);
  assert.match(cabinetSource, /pending\.barcode/);
  assert.match(cabinetSource, /body\.barcode = pending\.barcode/);
  assert.match(cabinetSource, /База штрих-кодов/);
  assert.match(cabinetRoutes, /router\.post\("\/ai\/barcode"/);
  assert.match(stylesSource, /\.camera-view/);
  assert.match(stylesSource, /\.camera-stencil/);
  assert.doesNotMatch(stylesSource, /\.barcode-row/);
});

test("код не нашёлся в базах — штрих-код не теряется, форма открывается для ручного ввода", () => {
  assert.match(cabinetSource, /pending\.barcode = data\.code;/);
  assert.match(cabinetSource, /товара нет в базах/);
  assert.match(cabinetSource, /pending\.photoNote = "отсканирован код — заполни бренд и название"/);
  const branchStart = cabinetSource.indexOf("товара нет ни в индексе");
  assert.notEqual(branchStart, -1, "ветка «товар не найден» должна быть в lookupBarcode");
  const branch = cabinetSource.slice(branchStart, branchStart + 800);
  assert.match(branch, /showPreview\(\)/);
  assert.match(branch, /return true;/);
});

test("кадр камеры обрезается по трафарету с учётом object-fit: cover", () => {
  assert.match(cabinetSource, /camera-stencil__can/);
  assert.match(cabinetSource, /getBoundingClientRect/);
  assert.match(cabinetSource, /Math\.max\(view\.width \/ vw, view\.height \/ vh\)/);
  assert.match(cabinetSource, /drawImage\(/);
});

test("рулетка по ассортименту: фото, распознавание и общий барабан", () => {
  assert.match(cabinetHtml, /id="assortment-photo"/);
  assert.match(cabinetHtml, /id="assortment-reel"/);
  assert.match(cabinetHtml, /id="assortment-spin"/);
  assert.match(cabinetHtml, /id="assortment-result"/);
  assert.match(cabinetHtml, /id="assortment-clear"/);
  assert.ok(cabinetHtml.indexOf("roulette.js") < cabinetHtml.indexOf("cabinet.js"), "барабан подключён до cabinet.js");
  assert.match(cabinetSource, /api\("POST", "api\/cabinet\/ai\/assortment"/);
  assert.match(cabinetSource, /NrgRoulette\.create/);
  assert.match(cabinetSource, /openOpinion\(slug\)/);
  assert.match(cabinetSource, /data-assortment-add/);
  assert.match(cabinetRoutes, /router\.post\("\/ai\/assortment"/);
  assert.match(stylesSource, /\.roulette__item--text/);
});

test("промпт просит прямой ракурс и зелёный фон", () => {
  const geminiSource = fs.readFileSync(path.join(__dirname, "..", "..", "server", "lib", "gemini.js"), "utf8");
  assert.match(geminiSource, /straight-on front view/);
  assert.match(geminiSource, /#00FF00/);
});

test("редактор мнения: ИИ-разбор текста и голос на месте", () => {
  assert.match(cabinetHtml, /id="op-ai-text"/);
  assert.match(cabinetHtml, /id="op-ai-parse"/);
  assert.match(cabinetHtml, /id="op-record"/);
  assert.match(cabinetHtml, /id="op-voice-player"/);
  assert.match(cabinetHtml, /id="op-voice-audio"/);
  assert.match(cabinetSource, /op-ai-parse"\)\.onclick = parseOpinionText/);
  assert.match(cabinetSource, /api\("POST", "api\/cabinet\/ai\/parse", \{ text, drink: opinion\.drink \}\)/);
  assert.match(cabinetSource, /opinion\.drink = \{ brand: drink\.brand \|\| ""/);
  assert.match(cabinetSource, /const VOICE_UI/);
  assert.match(cabinetSource, /input: "op-ai-text"/);
});

test("редактор мнения: поля тянутся под текст, без горизонтального скролла", () => {
  assert.match(cabinetHtml, /<textarea id="op-ai-text" rows="1"/, "ИИ-строка — переносимый textarea, а не однострочный input");
  assert.doesNotMatch(cabinetHtml, /<input id="op-ai-text"/);
  assert.match(cabinetSource, /const autoGrow = \(node, max = 420\)/, "есть автоподбор высоты");
  assert.match(cabinetSource, /node\.style\.minHeight = "0px"/, "высота мерится от нуля — поле ужимается");
  assert.match(cabinetSource, /autoGrow\(\$\("op-ai-text"\), 160\)/, "ИИ-строка растёт после открытия");
  assert.match(cabinetSource, /autoGrow\(\$\("op-review"\)\)/, "отзыв растёт после разбора и открытия");
  assert.match(cabinetSource, /\$\("op-review"\)\.addEventListener\("input", \(\) => autoGrow\(\$\("op-review"\)\)\)/, "отзыв тянется при вводе");
  assert.match(cabinetSource, /autoGrow\(area\)/, "голосовая расшифровка тоже растягивает поле");
  assert.match(stylesSource, /\.opinion-ai__row \{ display: flex; flex-wrap: wrap/, "строка ИИ переносит кнопки, а не торчит вбок");
  assert.match(stylesSource, /\.opinion-dialog__inner > \* \{ min-width: 0; \}/, "грид-дети не распирают диалог");
  assert.match(stylesSource, /\.opinion-ai > \* \{ min-width: 0; \}/, "дети блока ИИ не вылазят в сторону");
  assert.match(stylesSource, /\.opinion-dialog__fields textarea \{ resize: none; overflow-y: hidden/, "ручной resize выключен — рулит автоподбор");
  assert.doesNotMatch(stylesSource, /\.opinion-dialog__fields textarea \{[^}]*min-height/, "отзыв не зафиксирован — сжимается");
  assert.match(stylesSource, /\.voice-player \{[^}]*min-width: 0;/, "плеер сжимается, а не вылезает вбок");
  assert.match(stylesSource, /\.voice-player \.btn \{[^}]*height: 2\.2rem/, "кнопки плеера одной высоты с аудио — отступы ровные");
  assert.match(stylesSource, /\.voice-player audio \{ display: block/, "аудио без inline-зазора");
  assert.match(stylesSource, /\.voice-player__time \{[^}]*height: 2\.2rem/, "таймер на одной линии с кнопками");
});

test("редактор мнения: действия с фото спрятаны за превью, в диалоге нет свалки кнопок", () => {
  assert.match(cabinetHtml, /id="op-photo-open"/);
  assert.match(cabinetHtml, /id="op-photo-panel"[^>]*hidden/);
  assert.match(cabinetSource, /\$\("op-photo-open"\)\.onclick/);

  const panelStart = cabinetHtml.indexOf('id="op-photo-panel"');
  const panel = cabinetHtml.slice(panelStart, cabinetHtml.indexOf("</dialog>", panelStart));
  for (const id of ["op-photo-file", "op-photo-find", "op-photo-redraw", "op-photo-remove", "op-photo-strip"]) {
    assert.ok(panel.includes(`id="${id}"`), `${id} должен быть в панели фото`);
  }
  const actionsStart = cabinetHtml.indexOf('opinion-dialog__actions"');
  const actions = cabinetHtml.slice(actionsStart, cabinetHtml.indexOf("</div>", actionsStart));
  assert.match(actions, /id="op-save"/);
  assert.doesNotMatch(actions, /op-photo-/, "в нижнем ряду не должно быть кнопок фото");
});

test("оценка существующей банки: тир открывает редактор, а не сохраняется молча", () => {
  const handlerStart = cabinetSource.indexOf('$("unrated-list").addEventListener');
  assert.notEqual(handlerStart, -1);
  const handler = cabinetSource.slice(handlerStart, cabinetSource.indexOf('$("unrated-more")', handlerStart));
  assert.match(handler, /openOpinion\(card\.dataset\.drink, \{ tier: button\.dataset\.tier \}\)/);
  assert.doesNotMatch(handler, /api\("PUT"/, "тир не должен улетать в индекс без редакции");
});

test("похожая банка из ИИ-разбора: редактор открывается с готовым тиром и отзывом", () => {
  const handlerStart = cabinetSource.indexOf('$("similar-list").addEventListener');
  assert.notEqual(handlerStart, -1);
  const handler = cabinetSource.slice(handlerStart, cabinetSource.indexOf("const submitSmart", handlerStart));
  assert.match(handler, /openOpinion\(slug, \{/);
  assert.match(handler, /tier: TIERS\.includes\(parsed\.tier\)/);
  assert.match(handler, /aiText: \$\("smart-input"\)\.value\.trim\(\)/);
  assert.match(handler, /fromSmart: true/);
  assert.doesNotMatch(handler, /api\("PUT"/, "без редакции ничего не публикуем");
});

test("дубликаты: без явного «это не он» новую банку не сохранить", () => {
  assert.match(cabinetHtml, /id="similar-ack"/);
  assert.match(cabinetHtml, /Это не тот энергос — добавить новую банку/);
  assert.match(cabinetSource, /pending\.similarCount && !pending\.duplicateAck/);
  assert.match(cabinetSource, /similar-ack"\)\.addEventListener\("change"/);
  assert.match(cabinetSource, /const syncConfirmState = \(\) =>/);
  assert.match(cabinetSource, /pending\.similarCount > 0 && !pending\.duplicateAck/);
});

test("поиск по индексу в кабинете: находит банку и открывает редактор мнения", () => {
  assert.match(cabinetHtml, /id="find-input"/);
  assert.match(cabinetHtml, /id="find-results"/);
  assert.match(cabinetSource, /const renderFind = \(\) =>/);
  assert.match(cabinetSource, /\$\("find-input"\)\.addEventListener\("input", renderFind\)/);
  assert.match(cabinetSource, /renderFind\(\);/);
  assert.match(
    cabinetSource,
    /openOpinion\(button\.closest\("\.unrated-card"\)\.dataset\.drink, \{ tier: button\.dataset\.tier \}\)/,
  );
});

test("диплинк с тирлиста: cabinet.html?rate=<slug> открывает редактор мнения", () => {
  assert.match(cabinetSource, /new URLSearchParams\(location\.search\)\.get\("rate"\)/);
  assert.match(cabinetSource, /openOpinion\(decodeURIComponent\(rateSlug\)\)/);
});

test("мои оценки: кнопка редактора подписана «изменить»", () => {
  assert.match(cabinetSource, /data-m-edit>изменить<\/button>/);
  assert.doesNotMatch(cabinetSource, /data-m-edit>мнение<\/button>/);
});

test("мои оценки: перерисовка не теряет текст, двойное сохранение не проходит", () => {
  assert.match(cabinetSource, /if \(item && review !== undefined\) item\.review = review/);
  assert.match(cabinetSource, /if \(savingRatings\.has\(slug\)\) return;/);
  assert.match(cabinetSource, /if \(!slug \|\| savingOpinion\) return;/);
});

test("перед сохранением сказано, что уйдут и текст, и фото", () => {
  assert.match(cabinetHtml, /id="parsed-save-note"/);
  assert.match(cabinetHtml, /тир, отзыв и фото/);
});

test("кабинет разделён на вкладки «Добавить» и «Моё»", () => {
  assert.match(cabinetHtml, /data-cab-tab="add"/);
  assert.match(cabinetHtml, /data-cab-tab="mine"/);
  assert.match(cabinetHtml, /id="cab-panel-add"/);
  assert.match(cabinetHtml, /id="cab-panel-mine"[^>]*hidden/);
  assert.match(cabinetSource, /const switchCabTab = \(tab\) =>/);
  assert.match(cabinetSource, /switchCabTab\("add"\)/);
  assert.match(stylesSource, /\.cab-tabs \{/);
});

test("превью карточки правится вручную", () => {
  for (const id of ["parsed-brand", "parsed-name", "parsed-flavor", "parsed-edition", "parsed-tier", "parsed-review"]) {
    assert.match(cabinetHtml, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(cabinetHtml, /id="m-brand"/);
  assert.doesNotMatch(cabinetHtml, /id="btn-manual-save"/);
  assert.doesNotMatch(cabinetSource, /const fillManual/);
  assert.match(cabinetSource, /const readPreviewFields = \(\) =>/);
  assert.match(cabinetSource, /const applyParsedToPreview = \(parsed\) =>/);
  assert.match(cabinetSource, /Заполни поля в карточке и жми «В индекс ✓»/);
});

test("кнопка «Обработать» недоступна при пустом поле", () => {
  assert.match(cabinetHtml, /id="btn-smart"[^>]*disabled/);
  assert.match(cabinetHtml, /✦ Обработать/);
  assert.match(cabinetSource, /const updateSmartButton = \(\) =>/);
  assert.match(cabinetSource, /disabled = smartBusy \|\| !\$\("smart-input"\)\.value\.trim\(\)/);
  assert.match(cabinetSource, /\$\("smart-input"\)\.addEventListener\("input", updateSmartButton\)/);
  assert.match(cabinetSource, /const updateOpButton = \(\) =>/);
  assert.match(cabinetSource, /disabled = !\$\("op-ai-text"\)\.value\.trim\(\)/);
});

test("статусы называют процесс: голос, фото, текст", () => {
  assert.match(cabinetSource, /Обрабатываю голос/);
  assert.match(cabinetSource, /Обрабатываю фото/);
  assert.match(cabinetSource, /Обрабатываю текст/);
});

test("режим «Код» сканирует автоматически, квадрат не ограничивает полный кадр", () => {
  assert.doesNotMatch(cabinetHtml, /camera-stencil__code/);
  assert.doesNotMatch(stylesSource, /\.camera-stencil__code/);
  assert.match(cabinetSource, /const startAutoScan = async \(\) =>/);
  assert.match(cabinetSource, /const stopAutoScan = \(\) =>/);
  assert.match(cabinetSource, /const scanVariant = \(video, index, maxSide = 1280\)/);
  assert.match(cabinetSource, /detector\.detect\(canvas\)/);
  assert.match(cabinetSource, /zxingDecode\(canvas\)/);
  assert.match(cabinetSource, /startAutoScan\(\)/);
  assert.match(cabinetSource, /stopAutoScan\(\)/);
  assert.match(stylesSource, /\.camera-stencil\[data-mode="code"\] \.camera-stencil__can \{ display: none; \}/);
});

test("ZXing из vendor — фолбэк для браузеров без BarcodeDetector", () => {
  const vendor = path.join(__dirname, "..", "..", "public", "vendor");
  const lib = path.join(vendor, "zxing.min.js");
  assert.ok(fs.existsSync(lib), "нужен public/vendor/zxing.min.js");
  assert.ok(fs.existsSync(path.join(vendor, "zxing.LICENSE")), "нужна лицензия ZXing");
  assert.match(fs.readFileSync(lib, "utf8"), /ZXing/);
  assert.match(cabinetSource, /vendor\/zxing\.min\.js/);
  assert.match(cabinetSource, /ensureZXingReader/);
  assert.match(cabinetSource, /PlanarYUVLuminanceSource/);
});

test("zxing-wasm из vendor — сильный локальный декодер кадра", () => {
  const vendor = path.join(__dirname, "..", "..", "public", "vendor", "zxing-wasm");
  const reader = path.join(vendor, "reader.js");
  const wasm = path.join(vendor, "zxing_reader.wasm");
  assert.ok(fs.existsSync(reader), "нужен public/vendor/zxing-wasm/reader.js");
  assert.ok(fs.existsSync(wasm), "нужен public/vendor/zxing-wasm/zxing_reader.wasm");
  assert.ok(fs.existsSync(path.join(vendor, "LICENSE")), "нужна лицензия zxing-wasm");
  assert.ok(fs.statSync(wasm).size > 100 * 1024, "wasm-модуль должен быть настоящей сборкой");
  assert.match(fs.readFileSync(reader, "utf8"), /ZXingWASM/);
  assert.match(cabinetSource, /vendor\/zxing-wasm\/reader\.js/);
  assert.match(cabinetSource, /loadZXingWasm/);
  assert.match(cabinetSource, /setZXingModuleOverrides/);
  assert.match(cabinetSource, /readBarcodes/);
  assert.match(cabinetSource, /otsuThreshold/);
  assert.match(cabinetSource, /const wasmDecode = async \(canvas\)/);
  const readme = fs.readFileSync(path.join(__dirname, "..", "..", "public", "vendor", "README.md"), "utf8");
  assert.match(readme, /zxing-wasm/);
  assert.match(readme, /Лениво|lazy/i);
});

test("фото с кодом уходит на серверный разбор, если клиент не осилил", () => {
  assert.match(cabinetSource, /const barcodeImageDataUrl = async \(file, maxSide = 1600\)/);
  assert.match(cabinetSource, /api\("POST", "api\/cabinet\/ai\/barcode-scan", \{ imageDataUrl \}\)/);
  assert.match(cabinetRoutes, /router\.post\("\/ai\/barcode-scan"/);
});

test("форма входа не мелькает, пока идёт проверка сессии", () => {
  assert.match(cabinetHtml, /id="auth-view"[^>]*hidden/);
  assert.match(cabinetHtml, /id="boot-view"/);
  assert.match(cabinetHtml, /Проверяю вход/);
  const hides = cabinetSource.match(/\$\("boot-view"\)\.hidden = true/g) || [];
  assert.ok(hides.length >= 3, "boot-экран прячется при входе, смене пароля и в кабинете");
});

test("в камере есть фонарик, а блок «Фото по ссылке» отделён от превью", () => {
  assert.match(cabinetHtml, /id="camera-torch"/);
  assert.match(cabinetSource, /getCapabilities/);
  assert.match(cabinetSource, /applyConstraints/);
  assert.match(cabinetSource, /torch/);
  assert.match(stylesSource, /#cab-view \.cabinet-ai \{ margin: 1\.2rem 0;/);
});

test("разбор ИИ видит фото и не стирает данные из QR", () => {
  const start = cabinetSource.indexOf("const submitSmart");
  assert.notEqual(start, -1);
  const handler = cabinetSource.slice(start, cabinetSource.indexOf('$("smart-input").addEventListener("keydown"', start));
  assert.match(handler, /body\.draft = draft/);
  assert.match(handler, /body\.imageDataUrl = photo/);
  assert.match(handler, /pending\.original \|\| \(pending\.image\?\.startsWith\("data:"\)/);
  assert.match(handler, /pending\.photoSource === "auto"/, "фото из QR не сбрасывается автоподбором");
  assert.match(handler, /if \(!pending\.parsed\) \{/, "поля из QR переживают ошибку разбора");
});
