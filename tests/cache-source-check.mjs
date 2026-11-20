/**
 * cache 目录源回归（2026-11 新增的第 5 源）：
 *   ~/.workbuddy/plugins/cache/<m>/<p>/<version>/ 布局取 mtime 最新的版本层；
 *   marketplaces 优先于 cache（LOCAL_ROOTS set-if-absent）；
 *   非 expertType 的包（内置技能插件）不收编。
 * 全离线：HOME 指向临时目录，造一棵假树再 import catalog.js。
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const home = mkdtempSync(join(tmpdir(), "wbsum-cache-"));
process.env.HOME = home;

const manifest = (v) =>
	JSON.stringify(
		{
			name: v.name,
			agentName: v.agentName ?? v.name,
			expertType: v.expertType ?? "agent",
			displayName: { zh: v.zh ?? v.name },
			profession: { zh: v.zh ?? v.name },
			description: { zh: v.desc ?? "" },
			categoryId: v.categoryId ?? "06-ContentCreative",
			tags: v.tags ?? [],
			quickPrompts: [],
			defaultInitPrompt: { zh: "" },
			members: [],
		},
		null,
		2,
	);
const writeManifest = (dir, body) => {
	mkdirSync(join(dir, ".codebuddy-plugin"), { recursive: true });
	writeFileSync(join(dir, ".codebuddy-plugin", "plugin.json"), body);
};

// ① cache/experts 的纯新专家：新增分工前先建 agents 目录
const m1 = join(home, ".workbuddy/plugins/cache/experts/manga-master-agent/1.0.0");
writeManifest(m1, manifest({ name: "manga-master-agent", zh: "漫画制作大师" }));
mkdirSync(join(m1, "agents"), { recursive: true });
writeFileSync(join(m1, "agents", "lead.md"), "# lead\n");

// ② 非 expert 的内置插件：必须被过滤
const m2 = join(home, ".workbuddy/plugins/cache/workbuddy-builtin/workbuddy-docx/5.9.2-wb");
writeManifest(m2, JSON.stringify({ name: "workbuddy-docx", version: "5.9.2" }));

// ③ 同一 plugin 多个版本目录：取 mtime 最新的那层
const oldDir = join(home, ".workbuddy/plugins/cache/experts/manga-script-writer/1.1.0");
const newDir = join(home, ".workbuddy/plugins/cache/experts/manga-script-writer/2.0.0");
writeManifest(oldDir, manifest({ name: "manga-script-writer", zh: "漫画脚本编剧" }));
writeManifest(newDir, manifest({ name: "manga-script-writer", zh: "漫画脚本编剧 2.0" }));
utimesSync(oldDir, new Date(Date.now() - 100_000), new Date(Date.now() - 100_000));

// ④ marketplaces 与 cache 同名：以 marketplaces 为准
const mk = join(home, ".workbuddy/plugins/marketplaces/my-experts/plugins/manga-master");
writeManifest(mk, manifest({ name: "manga-master", zh: "漫画制作大师（市场实体）" }));

const { localMarketplaceEntries, loadCatalog } = await import("../lib/catalog.js");

const entries = localMarketplaceEntries();
const byPlugin = new Map(entries.map((e) => [e.plugin, e]));

const msw = byPlugin.get("manga-script-writer");
assert.equal(msw !== undefined, true, "版本层 plugin 应被收编");
assert.ok(String(msw._localRoot).includes("2.0.0"), `应取 mtime 最新版本层，实际 ${msw._localRoot}`);
assert.equal(msw._manifest, "cache:experts", "cache/experts 源标记");

assert.equal(byPlugin.get("workbuddy-docx") === undefined, true, "内置技能插件不应收编");

const mm = byPlugin.get("manga-master");
assert.equal(mm !== undefined, true, "同名 plugin 应被收编");
assert.equal(mm._manifest, "local:my-experts", "marketplaces 优先于 cache");
assert.ok(String(mm._localRoot).includes("marketplaces"), "实体根应是 marketplaces");

// cache/expers 的 manga-master-agent 只在 cache 源存在 → localRoot 即 cache
const momo = byPlugin.get("manga-master-agent");
assert.equal(momo !== undefined, true, "cache-only plugin 应被收编");
assert.equal(momo._manifest, "cache:experts", "cache 与 marketplaces 的标记分开");

const cat = await loadCatalog({ fresh: false });
assert.ok(
	cat.entries.some((e) => e.plugin === "manga-script-writer" && e._manifest === "cache:experts"),
	"loadCatalog 合并结果应包含 cache 源条目",
);

console.log("✓ cache 源：收编 / 过滤 / 版本层 / marketplaces 优先 / loadCatalog 合并 全部通过");
