import { loadCatalog, entryView } from "../lib/catalog.js";
const cat = await loadCatalog({});
const views = cat.entries.map(entryView);
const names = new Set(views.map((v) => v.name));
const plugins = new Set(views.map((v) => v.plugin));
// 截图里能读到的卡片名
const shots = ["全栈开发专家","高级开发工程师","微信小程序开发专家","微信公众号运营专家",
  "自适应成果交付专家","资讯速递专家","嵌入式固件工程师","中文网络小说创作顾问","创业伙伴",
  "工作台搭建师","长文档写作与改稿专家","战略咨询合伙人"];
console.log("截图卡片名命中（按 name 字段）：");
let hit = 0;
for (const s of shots) { const ok = names.has(s); if (ok) hit++; console.log(`  ${ok ? "✓" : "✗"} ${s}`); }
console.log(`  → ${hit}/${shots.length}`);
// 截图里的花名/职业
const alt = ["网文主编","号运","码小序","吴八哥","鹏城信息AI专家","固件通","小台","福帮手","林正刚","战略咨询顾问","数字生命卡兹克","超级合伙人"];
console.log("\n截图花名/职业命中（name 或 profession）：");
for (const a of alt) {
  const inName = names.has(a);
  const inProf = views.some((v) => v.profession === a);
  console.log(`  ${inName ? "name✓" : inProf ? "prof✓" : "✗   "} ${a}`);
}
console.log(`\n本机镜像里的 2 个专家包是否在云端清单：`);
for (const p of ["novel-workshop-pro","ai-tell-hunter"]) console.log(`  ${plugins.has(p) ? "✓" : "✗ 不在"} ${p}`);
