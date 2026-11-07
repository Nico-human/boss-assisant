const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = readFileSync(join(__dirname, "../boss-auto-apply.user.js"), "utf8");
function harness(stored = {}) {
  const requests = [];
  const storage = new Map([["boss-auto-apply-lite:config", stored]]);
  const context = vm.createContext({
    document: { readyState: "loading", addEventListener() {}, cookie: "bst=test" },
    window: { setTimeout: (callback) => { callback(); } },
    console: { log() {}, warn() {}, error() {} }, URLSearchParams,
    GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
    GM_setValue: (key, value) => storage.set(key, value),
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      return { ok: true, status: 200, text: async () => JSON.stringify(
        options.method === "GET"
          ? { code: 0, zpData: { jobCard: { postDescription: "开发移动应用", activeTimeDesc: "今日活跃" } } }
          : { code: 0, message: "Success" },
      ) };
    },
  });
  vm.runInContext(source.replace('  if (document.readyState === "loading") {', `
    globalThis.api = { applyFilters, parseSalaryLowerBound, handleOneJob, loadHistory,
      getConfig: () => config, state, setConfig: (next) => { config = normalizeConfig(next); } };
    if (document.readyState === "loading") {`), context);
  return { ...context.api, requests, storage };
}
const job = (overrides = {}) => ({ securityId: "s", encryptJobId: "j", lid: "l",
  jobName: "Android 开发工程师", brandName: "示例科技", salaryDesc: "20-35K·14薪",
  rawText: "", ...overrides });
const detail = (overrides = {}) => ({ postDescription: "负责 Android 开发，熟悉 Kotlin", activeTimeDesc: "今日活跃", ...overrides });
const check = (config, input = job(), info = detail()) => harness(config).applyFilters(input, info);

test("旧配置迁移保留已有关键词，新筛选默认关闭", () => {
  const config = harness({ includeDescriptionKeywords: "Kotlin" }).getConfig();
  assert.equal(config.includeDescriptionKeywords, "Kotlin");
  assert.equal(config.includeJobKeywords, "");
  assert.equal(config.excludeOutsourcing, false);
  assert.equal(config.minSalary, 0);
});
test("未设置筛选时允许普通岗位", () => assert.equal(check({}).ok, true));
test("岗位名称包含任一关键词，忽略大小写并支持中英文分隔符", () => {
  for (const separator of [",", "，", ";", "；"]) {
    assert.equal(check({ includeJobKeywords: `java${separator} ANDROID${separator}ios` }).ok, true);
    assert.equal(check({ excludeJobKeywords: `java${separator} ANDROID${separator}ios` }).ok, false);
  }
  assert.match(check({ includeJobKeywords: "Java" }).reason, /岗位名称不包含/);
});
test("换行和空格不作为多个关键词的分隔符", () => {
  for (const separator of ["\n", "\r\n", " "]) {
    assert.equal(check({ includeJobKeywords: `Android${separator}Java` }).ok, false);
    assert.equal(check({ excludeJobKeywords: `Android${separator}Java` }).ok, true);
  }
});
test("岗位名称排除，且不会匹配详情或公司名称", () => {
  assert.equal(check({ excludeJobKeywords: "android" }).ok, false);
  assert.equal(check({ excludeJobKeywords: "Kotlin,示例" }).ok, true);
});
test("岗位名称包含优先于排除", () => {
  assert.equal(check({ includeJobKeywords: "ANDROID", excludeJobKeywords: "android" }).ok, true);
});
test("详情只匹配职位描述，不混入岗位名、公司名、薪资和地点", () => {
  for (const keyword of ["示例", "20-35K", "北京"]) {
    assert.equal(check({ includeDescriptionKeywords: keyword }, job({ cityName: "北京" })).ok, false);
    assert.equal(check({ excludeDescriptionKeywords: keyword }, job({ cityName: "北京" })).ok, true);
  }
  assert.equal(check({ includeDescriptionKeywords: "Android" }, job(), detail({ postDescription: "Java 后端" })).ok, false);
});
test("详情包含优先于排除", () => {
  assert.equal(check({ includeDescriptionKeywords: "Kotlin", excludeDescriptionKeywords: "kotlin" }).ok, true);
});
test("岗位名明确包含的同词不会被详情排除，其他排除仍生效", () => {
  assert.equal(check({ includeJobKeywords: "android", excludeDescriptionKeywords: "ANDROID" }).ok, true);
  assert.equal(check({ includeJobKeywords: "android", excludeDescriptionKeywords: "Android,Kotlin" }).ok, false);
});
test("详情明确包含的同词不会被岗位名排除", () => {
  assert.equal(check({ includeDescriptionKeywords: "android", excludeJobKeywords: "ANDROID" }).ok, true);
});
test("配置详情筛选但获取失败/为空时跳过，未配置时不影响", () => {
  for (const info of [null, {}, { postDescription: " " }]) {
    assert.equal(check({ excludeDescriptionKeywords: "外包" }, job(), info).ok, false);
    assert.equal(check({ includeDescriptionKeywords: "Android" }, job(), info).ok, false);
    assert.equal(check({}, job(), info).ok, true);
  }
});
test("公司包含和排除仅匹配公司名称", () => {
  assert.equal(check({ includeCompanyKeywords: "其他,示例" }).ok, true);
  assert.equal(check({ includeCompanyKeywords: "Android" }).ok, false);
  assert.equal(check({ excludeCompanyKeywords: "示例" }).ok, false);
  assert.equal(check({ excludeCompanyKeywords: "Android" }).ok, true);
});
test("公司包含优先于公司排除和外包名单", () => {
  assert.equal(check({ includeCompanyKeywords: "外企德科", excludeCompanyKeywords: "外企德科", excludeOutsourcing: true },
    job({ brandName: "上海外企德科人力资源服务有限公司" })).ok, true);
});
test("外包开关、简称/全称和英文字母别名匹配", () => {
  for (const brandName of ["外企德科", "深圳市法本信息技术股份有限公司", "FESCO　Adecco", "纬创软件（北京）有限公司"]) {
    assert.equal(check({ excludeOutsourcing: true }, job({ brandName })).ok, false, brandName);
    assert.equal(check({}, job({ brandName })).ok, true, brandName);
  }
  assert.equal(check({ excludeOutsourcing: true }).ok, true);
});
test("外包通过卡片/详情全称识别，不把岗位描述里的甲方算作招聘公司", () => {
  assert.equal(check({ excludeOutsourcing: true }, job({ brandFullName: "中软国际有限公司" })).ok, false);
  assert.equal(check({ excludeOutsourcing: true }, job(), detail({ brandComInfo: { brandFullName: "软通动力信息技术有限公司" } })).ok, false);
  assert.equal(check({ excludeOutsourcing: true }, job(), detail({ postDescription: "负责中软国际合作项目" })).ok, true);
});
test("公司名称缺失时，启用外包过滤后跳过", () => {
  assert.equal(check({ excludeOutsourcing: true }, job({ brandName: "" })).ok, false);
});

const salaryCases = [
  ["20-35K·14薪", 20000], ["20k-35k·13薪", 20000], ["20K-3万", 20000],
  ["2-3万", 20000], ["2万-3万/月", 20000], ["8千-1万", 8000],
  ["20,000-30,000元/月", 20000], ["20000-30000", 20000], ["20K", 20000],
  ["２－３万", 20000], ["24-36万/年", 20000], ["240000元每年", 20000],
  ["2.5-3.5万·16薪", 25000], ["面议", null], ["300-500元/天", null],
  ["100-200元/时", null], ["", null], ["20-10K", null], ["0-30K", null],
  ["约20K", null], ["20K起", null],
];
for (const [text, expected] of salaryCases) {
  test(`薪资解析：${text || "空值"}`, () => assert.equal(harness().parseSalaryLowerBound(text), expected));
}
test("比较范围最低值，不使用最高值或多薪抬高最低值", () => {
  assert.equal(check({ minSalary: 20000 }).ok, true);
  assert.equal(check({ minSalary: 20001 }).ok, false);
  assert.equal(check({ minSalary: 20000 }, job({ salaryDesc: "18-35K·16薪" })).ok, false);
  assert.equal(check({ minSalary: 20000 }, job({ salaryDesc: "20-999K" })).ok, true);
  assert.equal(check({ minSalary: 14500 }, job({ salaryDesc: "14.5-25K" })).ok, true);
  const below = check({ minSalary: 14500 }, job({ salaryDesc: "14-25K" }));
  assert.equal(below.ok, false);
  assert.match(below.reason, /14 K\/月低于设定的 14\.5 K\/月/);
});
test("面议不满足薪资门槛，关闭门槛时放行", () => {
  assert.equal(check({ minSalary: 20000 }, job({ salaryDesc: "面议" })).ok, false);
  assert.equal(check({}, job({ salaryDesc: "面议" })).ok, true);
  assert.equal(check({ minSalary: 20000 }, job({ salaryDesc: "" }), detail({ salaryDesc: "25-30K" })).ok, true);
});
test("包含规则不绕过薪资、其他维度以及已有的已沟通/活跃度过滤", () => {
  const config = { includeCompanyKeywords: "外企德科", excludeOutsourcing: true, minSalary: 20000 };
  const input = job({ brandName: "外企德科" });
  assert.equal(check(config, { ...input, salaryDesc: "10-40K" }).ok, false);
  assert.equal(check({ ...config, includeJobKeywords: "Java" }, input).ok, false);
  assert.equal(check(config, input, detail({ activeTimeDesc: "1个月前活跃" })).ok, false);
  assert.equal(check(config, { ...input, contact: true }).ok, false);
  assert.equal(check(config, input, detail({ friendStatus: 1 })).ok, false);
});
test("完整处理流程：不符合筛选的岗位不调用投递 POST", async () => {
  for (const config of [{ includeJobKeywords: "Java" }, { excludeCompanyKeywords: "示例" },
    { minSalary: 40000 }, { excludeOutsourcing: true }]) {
    const api = harness(config);
    await api.handleOneJob(job(config.excludeOutsourcing ? { brandName: "外企德科" } : {}));
    assert.equal(api.requests.filter((request) => request.method === "POST").length, 0);
    assert.equal(api.state.skipped, 1);
    assert.equal(api.state.applied, 0);
  }
});
test("完整处理流程：公司明确包含覆盖外包后，符合门槛的岗位正常投递并记录历史", async () => {
  const api = harness({ includeCompanyKeywords: "外企德科", excludeCompanyKeywords: "外企德科", excludeOutsourcing: true, minSalary: 20000 });
  await api.handleOneJob(job({ brandName: "外企德科" }));
  assert.equal(api.requests.filter((request) => request.method === "POST").length, 1);
  assert.equal(api.state.applied, 1);
  assert.equal(api.loadHistory().dailyCount, 1);
});
