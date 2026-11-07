const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const data = JSON.parse(fs.readFileSync(path.join(root, "data/outsourcing-companies.json"), "utf8"));
const sourceIds = new Set(data.sources.map((source) => source.id));
const aliases = new Set();
assert.ok(data.companies.length > 0, "外包名单不能为空");
for (const company of data.companies) {
  assert.ok(company.name && company.aliases.length && company.sourceIds.length, "公司缺少名称、别名或来源");
  assert.ok(company.sourceIds.every((id) => sourceIds.has(id)), `未知来源：${company.name}`);
  for (const alias of company.aliases) {
    const key = alias.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
    assert.ok(key && !aliases.has(key), `空白或重复别名：${alias}`);
    aliases.add(key);
  }
}

const scriptPath = path.join(root, "boss-auto-apply.user.js");
const script = fs.readFileSync(scriptPath, "utf8");
const pattern = /  \/\/ BEGIN GENERATED OUTSOURCING COMPANIES\n[\s\S]*?  \/\/ END GENERATED OUTSOURCING COMPANIES/;
assert.ok(pattern.test(script), "找不到外包名单生成区域");
const rows = data.companies.map(({ name, aliases }) => `    ${JSON.stringify({ name, aliases })},`);
const block = ["  // BEGIN GENERATED OUTSOURCING COMPANIES",
  "  // 来源及维护入口：data/outsourcing-companies.json；运行 npm run sync:outsourcing 更新。",
  `  // 社区名单快照：${data.updatedAt}，仅用于辅助筛选。`,
  "  const OUTSOURCING_COMPANIES = [", ...rows, "  ];",
  "  // END GENERATED OUTSOURCING COMPANIES"].join("\n");
const next = script.replace(pattern, () => block);
if (process.argv.includes("--check")) {
  assert.equal(script, next, "外包名单未同步，请运行 npm run sync:outsourcing");
} else if (script !== next) {
  fs.writeFileSync(scriptPath, next);
}
console.log(`外包名单已${process.argv.includes("--check") ? "校验" : "同步"}：${data.companies.length} 家公司`);
