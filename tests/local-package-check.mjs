import { loadCatalog, loadPackage, entryView } from "../lib/catalog.js";
import { composeSummon } from "../lib/inject.js";
const cat = await loadCatalog({});
const views = cat.entries.map(entryView);
for (const plugin of ["novel-workshop-pro", "ai-tell-hunter"]) {
	const raw = cat.entries.find((e) => e.plugin === plugin);
	const v = raw && entryView(raw);
	console.log(`\n### ${plugin}`);
	if (v === undefined) { console.log("  ✗ 不在目录里"); continue; }
	console.log(`  目录：title=${v.title}｜name=${v.name}｜来源=${v.manifest}｜分类=${v.category}｜技能标签=${v.tags.slice(0,3).join("/")}`);
	const pkg = await loadPackage(plugin, {});
	if (pkg?.manifest === undefined) { console.log("  ✗ 取不到包（localRoot 未生效？）"); continue; }
	console.log(`  包体：agents=${pkg.agentNames.join(",")} skills=${pkg.skills.map(s=>s.name).join(",")} settings=${JSON.stringify(pkg.settings ?? null)}`);
	const text = composeSummon(raw, pkg, {});
	console.log(`  注入：${text.length} 字符（≈${Math.round(text.length/1.6)} token）首行「${text.split("\n")[0]}」`);
	console.log(`  ✓ ${text.length > 500 ? "可用" : "异常"}`);
}
