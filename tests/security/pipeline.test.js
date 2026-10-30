// Пайплайн: публичный репозиторий собирается на GitHub-hosted, деплой вынесен
// в pull-based агент на CT111. Workflow не имеет доступа к прод-хосту и не
// содержит self-hosted runner'ов.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const WORKFLOWS = path.join(__dirname, "..", "..", ".github", "workflows");
const read = (name) => fs.readFileSync(path.join(WORKFLOWS, name), "utf8");

// Тело job'а от его ключа до следующего ключа верхнего уровня.
const jobBlock = (yml, name) => {
  const start = yml.indexOf(`\n  ${name}:`);
  assert.notEqual(start, -1, `job ${name} должен быть в pipeline.yml`);
  const rest = yml.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z-]*:/);
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  return body.slice(body.indexOf("\n"));
};

test("pipeline: один workflow, production + PR + dispatch", () => {
  const files = fs.readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"));
  assert.deepEqual(files, ["pipeline.yml"], "вместо ci.yml + deploy.yml должен остаться один pipeline.yml");
  const yml = read("pipeline.yml");
  assert.match(yml, /^name: Pipeline/m);
  const onBlock = yml.slice(yml.indexOf("on:"), yml.indexOf("permissions:"));
  assert.match(onBlock, /push:[\s\S]*?branches: \[production\]/);
  assert.match(onBlock, /pull_request:[\s\S]*?branches: \[production\]/);
  assert.match(onBlock, /workflow_dispatch:/);
  assert.doesNotMatch(onBlock, /master/, "пуш в master не должен запускать прогон");
});

test("pipeline: всё на GitHub-hosted, без self-hosted и /opt/node", () => {
  const yml = read("pipeline.yml");
  assert.doesNotMatch(yml, /self-hosted/, "публичный репозиторий не должен использовать self-hosted runner");
  assert.doesNotMatch(yml, /\/opt\/node/, "Node ставится через setup-node, а не с прод-хоста");
  for (const name of ["test", "pre-deploy", "build", "release"]) {
    assert.match(jobBlock(yml, name), /\n    runs-on: ubuntu-22\.04/, `${name}: только GitHub-hosted`);
  }
});

test("pipeline: тесты параллельно, build после обоих, release после build", () => {
  const yml = read("pipeline.yml");
  const testJob = jobBlock(yml, "test");
  const preDeploy = jobBlock(yml, "pre-deploy");
  const build = jobBlock(yml, "build");
  const release = jobBlock(yml, "release");
  assert.doesNotMatch(testJob, /\n    if:/, "облачные тесты без условий");
  assert.doesNotMatch(preDeploy, /\n    if:/, "пре-деплой без условий");
  assert.doesNotMatch(preDeploy, /needs:/, "пре-деплой не ждёт облачные тесты");
  assert.match(build, /needs: \[test, pre-deploy\]/, "build зависит от обеих проверок");
  assert.match(release, /needs: build/, "release после build");
  assert.match(release, /environment: production/);
  assert.match(release, /github\.ref == 'refs\/heads\/production'/);
});

test("pipeline: артефакт без node_modules, подпись и GitHub Release", () => {
  const yml = read("pipeline.yml");
  const build = jobBlock(yml, "build");
  const release = jobBlock(yml, "release");
  assert.match(build, /--exclude 'node_modules\/'/);
  assert.match(build, /tar -czf app\.tar\.gz -C staging app/);
  assert.match(build, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(release, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(release, /minisign -Sm app\.tar\.gz/);
  assert.match(release, /production-\$\{GITHUB_SHA\}/);
  assert.match(release, /gh release create/);
  assert.match(release, /--latest/);
  assert.match(release, /permissions:\n      contents: write/);
});

test("pipeline: actions запинены по SHA, checkout без credentials", () => {
  const yml = read("pipeline.yml");
  const uses = [...yml.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 4, "должны быть checkout/setup-node/upload/download");
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${u}: action должен быть запинен по commit SHA`);
  assert.match(yml, /persist-credentials: false/);
});

test("pipeline: категории тестов разделены между джобами без дублей", () => {
  const yml = read("pipeline.yml");
  const testJob = jobBlock(yml, "test");
  const preDeploy = jobBlock(yml, "pre-deploy");
  assert.match(testJob, /npm run test:unit && npm run test:ui && npm run test:security/);
  assert.match(preDeploy, /npm run test:api/);
  assert.doesNotMatch(testJob, /npm run test:api/, "интеграция не дублируется в облаке");
  assert.doesNotMatch(preDeploy, /npm run test:unit|npm run test:ui|npm run test:security/, "быстрые категории не дублируются");
  assert.doesNotMatch(yml, /^\s*run: npm test\s*$/m, "полный npm test не гоняем дважды");
  assert.doesNotMatch(preDeploy, /npm audit/, "аудит уже прошёл в облаке");
});

test("pipeline: smoke и аудит на месте, деплой вынесен из workflow", () => {
  const yml = read("pipeline.yml");
  assert.match(yml, /npm audit --omit=dev --audit-level=high/);
  assert.match(yml, /Smoke: сервер стартует и отвечает/);
  assert.doesNotMatch(yml, /Backup and sync app to \/opt\/nrgindex/);
  assert.doesNotMatch(yml, /systemctl restart nrgindex/);
  assert.doesNotMatch(yml, /ssh /);
});
