import { loadCatalog, loadPackage, entryView } from "../lib/catalog.js";
import { composeSummon } from "../lib/inject.js";

const cat = await loadCatalog({});
const views = cat.entries.map(entryView);
const byPlugin = new Map(views.map((v) => [v.plugin, v]));

// 1) 分类中文名
const badCat = views.filter((v) => v.category === v.categoryId || v.category === undefined || v.category === "");
console.log(`1) 分类解析：${views.length - badCat.length}/${views.length} 有中文名` +
	(badCat.length ? ` ✗ 未解析样例 ${badCat.slice(0, 3).map((v) => v.categoryId).join(",")}` : " ✓"));

// 2) 各形态注入
const cases = [
	["design-engine", "team 6人"],
	["software-company", "team 21人"],
	["content-creator", "单专家"],
	["ai-humanizer", "骨架包(COS 404)"],
];
for (const [plugin, label] of cases) {
	const e = cat.entries.find((x) => x.plugin === plugin);
	if (e === undefined) { console.log(`2) ${label} ${plugin}: ✗ 目录里没有`); continue; }
	const v = entryView(e);
	const pkg = await loadPackage(plugin, {});
	if (pkg?.manifest === undefined) {
		console.log(`2) ${label} ${plugin}: ✓ 正确判定为不可用（manifest 未取到，summon 会抛 package-unavailable）`);
		continue;
	}
	const text = composeSummon(e, pkg, {});
	const isTeam = v.expertType === "team";
	const ok = text.length > 0 &&
		(!isTeam || text.includes("spawn_teammate")) &&
		(isTeam ? !text.includes("## 你的定义\n\n>\n") : !text.includes("团队编制与调度规程"));
	console.log(`2) ${label} ${plugin}: ${ok ? "✓" : "✗"} ${text.length} 字符（≈${Math.round(text.length / 1.6)} token）` +
		` agents=${pkg.agentNames.length} skills=${pkg.skills.length} 成员表=${v.members.length}`);
}

// 3) 长度分布（team 全量）
const lens = [];
for (const v of views.filter((x) => x.expertType === "team").slice(0, 20)) {
	const pkg = await loadPackage(v.plugin, {});
	if (pkg?.manifest === undefined) continue;
	lens.push(composeSummon(byPlugin.get(v.plugin) ?? {}, pkg, {}).length);
}
lens.sort((a, b) => a - b);
console.log(`3) 前 20 个专家团注入长度：min=${lens[0]} 中位=${lens[Math.floor(lens.length / 2)]} max=${lens[lens.length - 1]}`);

// 4) 去重与主键
const keys = new Set(cat.entries.map((e) => `${e.plugin}::${e.id}`));
console.log(`4) 去重：条目 ${cat.entries.length}，唯一 (plugin::id) ${keys.size} ${cat.entries.length === keys.size ? "✓" : "✗ 有重复"}`);
