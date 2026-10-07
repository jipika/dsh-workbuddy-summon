import { loadCatalog, entryView } from "../lib/catalog.js";
const views = (await loadCatalog({})).entries.map(entryView);
const prof = new Map();
for (const v of views) if (v.profession) prof.set(v.profession, v);
const titles = ["全栈开发专家","高级开发工程师","微信小程序开发专家","微信公众号运营专家",
  "自适应成果交付专家","资讯速递专家","嵌入式固件工程师","创业伙伴","工作台搭建师",
  "长文档写作与改稿专家","战略咨询合伙人"];
let n = 0;
for (const t of titles) { const v = prof.get(t); if (v) n++; console.log(`  ${v ? "✓" : "✗"} ${t.padEnd(12)} → ${v ? `name=${v.name} plugin=${v.plugin}` : "无"}`); }
console.log(`→ profession 命中 ${n}/${titles.length}`);
