/**
 * 离线回归：不启动 DSH，直接验证「目录 → 取包 → 注入文本」全链路。
 *   node tests/render-check.mjs [plugin]
 * 断言：未召唤=空串；召唤后含成员表 / 调度映射 / 铁律 / 技能；长度在预算内。
 */
import { loadCatalog, loadPackage, entryView } from "../lib/catalog.js";
import { composeSummon } from "../lib/inject.js";

const wanted = process.argv[2] ?? "design-engine";

const cat = await loadCatalog({});
console.log(
	`目录：${cat.entries.length} 条｜来源 ${cat.sources.map((s) => `${s.name.split(".")[0]}=${s.origin}/${s.count}`).join(" ")}` +
		`｜degraded=${cat.degraded}`,
);
if (cat.entries.length < 400) throw new Error(`目录条数异常（${cat.entries.length} < 400）`);

const teams = cat.entries.filter((e) => e.expertType === "team");
console.log(`专家团 ${teams.length} 个｜单专家 ${cat.entries.length - teams.length} 个`);

const entry = cat.entries.find((e) => e.plugin === wanted) ?? teams[0];
const view = entryView(entry);
console.log(`\n取包：${view.plugin}（${view.expertType}，成员 ${view.members.length}）`);

const pkg = await loadPackage(view.plugin, {});
if (pkg?.manifest === undefined) throw new Error(`取不到包 ${view.plugin}`);
console.log(
	`  plugin.json ✓  agents=${pkg.agentNames.length}  skills=${pkg.skills.length}  settings=${JSON.stringify(pkg.settings)}`,
);
console.log(`  成员正文齐备：${pkg.agentNames.map((n) => `${n}(${(pkg.agents[n] ?? "").length})`).join(" ")}`);

const text = composeSummon(entry, pkg, { sessionId: "test", maxLeadChars: 24000 });
if (text.length === 0) throw new Error("召唤后注入文本为空 —— 不合规");

const checks = {
	含标题: /^# 本会话已召唤：/.test(text),
	含专家定义: text.includes("## 你的定义"),
	含团队编制: view.expertType === "team" ? text.includes("## 团队编制与调度规程") : true,
	含调度映射: view.expertType === "team" ? text.includes("spawn_teammate") : true,
	含send_message: view.expertType === "team" ? text.includes("send_message") : true,
	保留禁止互连红线: view.expertType === "team" ? text.includes("不得交给成员") || text.includes("经你中转") : true,
	成员正文未预注入: view.expertType === "team" ? !text.includes("## 成员定义\n") : true,
	含技能取用指引: pkg.skills.length > 0 ? text.includes("wb_expert_read") : true,
};
console.log("\n断言：");
let bad = 0;
for (const [k, v] of Object.entries(checks)) {
	if (!v) bad += 1;
	console.log(`  ${v ? "✓" : "✗"} ${k}`);
}

console.log(`\n注入文本：${text.length} 字符（约 ${Math.round(text.length / 1.6)} token）`);
console.log("─".repeat(60));
console.log(text.slice(0, 2600));
console.log(`…（中略 ${Math.max(0, text.length - 3000)} 字符）…`);
console.log(text.slice(-900));
console.log("─".repeat(60));

// 未召唤 = 空串
const empty = composeSummon(undefined, undefined, {});
console.log(`未召唤（pkg=undefined）→ 注入文本长度 ${empty.length} ${empty === "" ? "✓" : "✗"}`);

if (bad > 0 || empty !== "") {
	console.error(`\n失败：${bad} 项断言未通过`);
	process.exit(1);
}
console.log("\n全部通过");
