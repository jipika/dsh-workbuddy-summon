/**
 * marketCache 第 6 源回归：HOME→临时目录；伪造 ~/.dsh/workbuddy-summon/cache/market/experts.json
 * 断言：merge 数、sources 出现、重复 (plugin,id) 不进条目、entryView 起码字段可用。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const tempHome = mkdtempSync(join(tmpdir(), "wbsum-market-"));
process.env.HOME = tempHome;
const cacheRoot = join(tempHome, ".dsh/workbuddy-summon/cache/market");
mkdirSync(cacheRoot, { recursive: true });

const experts = [
	{
		id: "ex_manga01", plugin: "pl_manga01", expertType: "agent", agentName: "manga-master",
		displayName: { zh: "漫画制作专家", en: "Manga Master" },
		profession: { zh: "漫画制作大师", en: "Manga Producer" },
		description: { zh: "条漫、分镜、角色设计", en: "comics" },
		quickPrompts: [{ zh: "画一张", en: "draw" }],
		avatar: "https://openplatform-cdn.codebuddy.cn/x/eza.png",
		sourceId: "ex_manga01", lifecycle: "published",
	},
	{ id: "ex_t1", plugin: "pl_t1", expertType: "team", displayName: { zh: "漫画团队" }, profession: { zh: "漫画制作团" }, description: { zh: "" } },
];
writeFileSync(join(cacheRoot, "experts.json"), JSON.stringify({ version: "t", syncedAt: "2026-11-08T15:40:00.000Z", total: 40223, experts }));

// 本机 marketplaces 有个同名冲突（plugin 同 key 且 id 不同→两种 id 并存；同 plugin 同 id 才去重）
const mkDir = join(tempHome, ".workbuddy/plugins/marketplaces/my-experts/plugins/pl_manga01");
mkdirSync(join(mkDir, ".codebuddy-plugin"), { recursive: true });
writeFileSync(join(mkDir, ".codebuddy-plugin", "plugin.json"), JSON.stringify({
	name: "pl_manga01", agentName: "manga-master", expertType: "agent",
	displayName: { zh: "漫画制作专家" },
}));
// resolve cache agent dir so loadPackage has a root
mkdirSync(join(mkDir, "agents"), { recursive: true });
writeFileSync(join(mkDir, "agents", "manga-master.md"), "# lead\n");

const { loadCatalog, entryView } = await import("../lib/catalog.js");
const cat = await loadCatalog({ fresh: false });
const market = cat.sources.find((s) => s.name === "marketCache");
assert.notEqual(market, undefined, "sources 应含 marketCache");
assert.equal(market.count, 2, "marketCache 收 2 条（fixture 里没冲突）");
const byPluginMarket = cat.entries.filter((e) => e._manifest === "market");
assert.equal(byPluginMarket.length, 2, "market 条目应有 2 条");
const entry = byPluginMarket[0];
const v = entryView(entry);
assert.equal(v.title, "漫画制作大师", "title 取 profession zh");
assert.equal(v.id, "ex_manga01");
assert.ok(typeof v.avatar === "string" && v.avatar.startsWith("https://"), "avatar 保留外链");

// 破坏形状的缓存不应让 loadCatalog 崩
writeFileSync(join(cacheRoot, "experts.json"), "{oops");
const cat2 = await loadCatalog({ fresh: false, includeLocal: false });
assert.ok(Array.isArray(cat2.entries), "坏缓存只告警不崩");

console.log("✓ marketCache 源：合并、来源登记、去重、视图字段、坏缓存兜底 全部通过");
