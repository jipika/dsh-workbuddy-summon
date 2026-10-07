import { loadCatalog, entryView } from "../lib/catalog.js";
const cat = await loadCatalog({});
const views = cat.entries.map(entryView);
const hit = (q) => views.filter((v) =>
	`${v.name} ${v.nameEn} ${v.profession} ${v.description} ${v.tags.join(" ")} ${v.plugin}`.toLowerCase().includes(q));
for (const q of ["网文", "小说", "设计", "交易", "研究", "财税"]) {
	const r = hit(q);
	console.log(`q="${q}" → ${String(r.length).padStart(3)} 条  ${r.slice(0, 3).map((v) => `${v.name}(${v.plugin})`).join("  ")}`);
}
const novel = views.filter((v) => /小说|网文|主编/.test(`${v.name}${v.profession}${v.description}${v.tags.join("")}`));
console.log(`\n「小说/网文/主编」相关 ${novel.length} 条：`);
for (const v of novel.slice(0, 8)) console.log(`  ${v.name} · ${v.profession} · ${v.plugin} · ${v.expertType}`);
