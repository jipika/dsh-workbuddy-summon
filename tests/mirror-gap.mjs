import { loadCatalog, entryView } from "../lib/catalog.js";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const cat = await loadCatalog({});
const cloud = new Set(cat.entries.map((e) => e.plugin));
const MIRROR = "/Users/lixiongwei/Documents/deepseek/wb-resources/expert-market/remote";
const local = existsSync(MIRROR) ? readdirSync(MIRROR) : [];
const gap = local.filter((p) => !cloud.has(p));
console.log(`云端 ${cloud.size} 个 plugin｜本机镜像 ${local.length}｜镜像有而云端无 ${gap.length}`);
console.log("  样例:", gap.slice(0, 8).join(", "));
// 本机 experts 市场里的（用户从 UI 下载过的）
const MK = "/Users/lixiongwei/.workbuddy/plugins/marketplaces/experts/plugins";
if (existsSync(MK)) {
  for (const p of readdirSync(MK)) {
    const pj = join(MK, p, ".codebuddy-plugin/plugin.json");
    if (!existsSync(pj)) continue;
    const d = JSON.parse(readFileSync(pj, "utf8"));
    console.log(`  本机包 ${p}: displayName=${JSON.stringify(d.displayName)} profession=${JSON.stringify(d.profession)} 在云端=${cloud.has(p)}`);
  }
}
