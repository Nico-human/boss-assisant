const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const puppeteer = require("puppeteer-core");

async function main() {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-background-networking"],
  });
  try {
    for (const useGM of [false, true]) {
      const errors = [];
      const requests = [];
      const storageKey = `${useGM ? "test-gm:" : ""}boss-auto-apply-lite:config`;
      async function createPage() {
        const nextPage = await browser.newPage();
        nextPage.on("pageerror", (error) => errors.push(error.message));
        await nextPage.setRequestInterception(true);
        nextPage.on("request", (request) => {
          requests.push(request.method());
          // 所有请求都在本地响应，不访问 Boss，也不发送真实投递。
          request.respond({ status: 200, contentType: "text/html; charset=utf-8", body: "<!doctype html><html><head><meta charset=\"utf-8\"><title>本地面板验证</title></head><body><h1>本地面板验证</h1></body></html>" });
        });
        if (useGM) {
          await nextPage.evaluateOnNewDocument(() => {
            // 模拟篡改猴的持久化 API，验证脚本优先走 GM 读写分支。
            window.GM_getValue = (key, fallback) => {
              const raw = localStorage.getItem(`test-gm:${key}`);
              return raw === null ? fallback : JSON.parse(raw);
            };
            window.GM_setValue = (key, value) => localStorage.setItem(`test-gm:${key}`, JSON.stringify(value));
          });
        }
        return nextPage;
      }
      let page = await createPage();
      const source = readFileSync(join(__dirname, "../boss-auto-apply.user.js"), "utf8");
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto("https://www.zhipin.com/web/geek/job");
      // 旧版按元存储的门槛应直接按 K 展示，无需用户重新设置。
      await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ minSalary: 20000 })), storageKey);
      await page.addScriptTag({ content: source });
      const panel = "#boss-auto-apply-lite-panel";
      assert.equal(await page.$eval(`${panel} [name=minSalary]`, (field) => field.value), "20");
      assert.equal(await page.$$eval(`${panel} textarea`, (fields) => fields.length), 6);
      await page.type(`${panel} [name=includeJobKeywords]`, "Android, Kotlin");
      assert.equal(await page.$eval(`${panel} [name=includeJobKeywords]`, (field) => field === document.activeElement), true);
      await page.type(`${panel} [name=excludeJobKeywords]`, "android");
      await page.type(`${panel} [name=includeDescriptionKeywords]`, "开发");
      await page.type(`${panel} [name=excludeDescriptionKeywords]`, "外包");
      await page.type(`${panel} [name=includeCompanyKeywords]`, "外企德科");
      await page.type(`${panel} [name=excludeCompanyKeywords]`, "外企德科");
      await page.$eval(`${panel} [name=minSalary]`, (field) => { field.value = ""; });
      await page.type(`${panel} [name=minSalary]`, "15");
      assert.equal(await page.$eval(`${panel} [name=minSalary]`, (field) => field.checkValidity()), true);
      await page.click(`${panel} [name=excludeOutsourcing]`);
      const readStored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
      const stored = await readStored();
      assert.equal(stored.includeJobKeywords, "Android, Kotlin");
      assert.equal(stored.excludeJobKeywords, "android");
      assert.equal(stored.includeCompanyKeywords, "外企德科");
      assert.equal(stored.minSalary, 15000);
      assert.equal(stored.excludeOutsourcing, true);
      // 重绘和刷新后都保留设置。
      await page.click(`${panel} [data-action=toggle-collapse]`);
      await page.click(`${panel} [data-action=toggle-collapse]`);
      await page.reload();
      await page.addScriptTag({ content: source });
      assert.deepEqual(await readStored(), stored);
      assert.equal(await page.$eval(`${panel} [name=minSalary]`, (field) => field.value), "15");
      assert.equal(await page.$eval(`${panel} [name=excludeOutsourcing]`, (field) => field.checked), true);
      assert.equal(await page.$eval(`${panel} [name=includeJobKeywords]`, (field) => field.value), "Android, Kotlin");
      // 不点击开始或保存，关闭标签页后重新打开，六个关键词框和薪资仍自动加载。
      await page.close();
      page = await createPage();
      await page.goto("https://www.zhipin.com/web/geek/job");
      await page.addScriptTag({ content: source });
      for (const key of ["includeJobKeywords", "excludeJobKeywords", "includeDescriptionKeywords",
        "excludeDescriptionKeywords", "includeCompanyKeywords", "excludeCompanyKeywords"]) {
        assert.equal(await page.$eval(`${panel} [name=${key}]`, (field) => field.value), stored[key]);
      }
      assert.equal(await page.$eval(`${panel} [name=minSalary]`, (field) => field.value), "15");
      assert.equal(await page.$eval(`${panel} [name=excludeOutsourcing]`, (field) => field.checked), true);
      assert.deepEqual(await readStored(), stored);
      // 负数不能开始，浏览器原生校验生效。
      await page.$eval(`${panel} [name=minSalary]`, (field) => {
        field.value = "-1";
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.click(`${panel} [data-action=start]`);
      assert.equal(await page.$eval(`${panel} [name=minSalary]`, (field) => field.validity.rangeUnderflow), true);
      // 小数不能开始，薪资门槛以 1K 为步长。
      await page.$eval(`${panel} [name=minSalary]`, (field) => {
        field.value = "14.5";
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.click(`${panel} [data-action=start]`);
      assert.equal(await page.$eval(`${panel} [name=minSalary]`, (field) => field.validity.stepMismatch), true);
      assert.equal(requests.filter((method) => method === "POST").length, 0);
      await page.$eval(`${panel} [name=minSalary]`, (field) => {
        field.value = "15";
        field.stepUp();
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      assert.equal(await page.$eval(`${panel} [name=minSalary]`, (field) => field.value), "16");
      assert.equal((await readStored()).minSalary, 16000);
      for (const viewport of [{ width: 1280, height: 900 }, { width: 1280, height: 600 }]) {
        await page.setViewport(viewport);
        const layout = await page.$eval(panel, (element) => {
          const rect = element.getBoundingClientRect();
          const body = element.querySelector(".aj-body");
          return { top: rect.top, bottom: rect.bottom, innerWidth: body.clientWidth, scrollWidth: body.scrollWidth };
        });
        assert.ok(layout.top >= 0 && layout.bottom <= viewport.height);
        assert.ok(layout.scrollWidth <= layout.innerWidth, "面板不能出现横向溢出");
        await page.$eval(`${panel} .aj-body`, (body) => { body.scrollTop = 0; });
        await page.screenshot({ path: `/tmp/boss-auto-apply-panel-${viewport.height}.png` });
      }
      assert.deepEqual(errors, []);
      assert.equal(requests.includes("POST"), false);
      await page.close();
      console.log(`浏览器检查通过（${useGM ? "模拟篡改猴 GM API" : "localStorage"}）：6 个关键词字段自动保存、刷新/关闭重开恢复、1K 步长、焦点和布局；无真实网络请求或投递。`);
    }
  } finally {
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
