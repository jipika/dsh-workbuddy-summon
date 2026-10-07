import { loadCatalog, loadPackage, entryView } from "../lib/catalog.js";
import { composeSummon } from "../lib/inject.js";
const cat = await loadCatalog({});
const e = cat.entries.find((x) => x.plugin === (process.argv[2] ?? "design-engine"));
const pkg = await loadPackage(e.plugin, {});
const t = composeSummon(e, pkg, {});
const i = t.indexOf("## 团队编制与调度规程");
console.log(i < 0 ? t.slice(-2200) : t.slice(i, i + 2800));
