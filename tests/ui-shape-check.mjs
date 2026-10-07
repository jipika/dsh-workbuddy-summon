import { EventEmitter } from "node:events";
const routes = [];
const ctx = {
	effect: (f) => { const d = f(); return typeof d === "function" ? d : () => {}; },
	on: () => () => {},
	systemPrompt: { section: () => () => {} },
	tools: { register: () => () => {} },
	webServer: { register: (d) => { routes.push(d); return () => {}; } },
	agents: { currentInitiator: () => ({ sessionId: "ui" }) },
	logger: { info() {}, warn() {} },
};
const m = await import("../index.js");
await m.apply(ctx, { warmCatalog: false });
async function call(method, url, body) {
	const ch = [];
	const res = { statusCode: null, writeHead(s) { this.statusCode = s; }, end(x) { ch.push(x); } };
	const req = new EventEmitter();
	req.method = method; req.url = url; req.destroy = () => {}; req.headers = {};
	queueMicrotask(() => { if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
	await routes[0].handler(req, res);
	return { status: res.statusCode, json: JSON.parse(ch.join("")) };
}
const c = await call("GET", "/dsh-workbuddy-summon/catalog?q=网文");
console.log("q=网文 →", c.status, "total", c.json.total);
for (const it of c.json.items) {
	console.log(`  title="${it.title}" 副="${it.name}" badge=${it.expertType === "team" ? `团·${it.memberCount + 1}` : it.category} summary=${String(it.summary).slice(0, 28)}…`);
}
const need = ["plugin", "id", "title", "name", "expertType", "category", "memberCount", "summary"];
const missing = need.filter((k) => !(k in (c.json.items[0] ?? {})));
console.log(missing.length === 0 ? "✓ UI 依赖字段齐全" : `✗ 缺字段 ${missing.join(",")}`);
const cats = await call("GET", "/dsh-workbuddy-summon/catalog?kind=team");
console.log(`分类下拉：${cats.json.categories.slice(0, 4).map((x) => `${x.name}(${x.count})`).join(" ")}`);
const e = await call("GET", "/dsh-workbuddy-summon/entry?plugin=design-engine");
console.log(`entry 详情 → ${e.status} pkgAvailable=${e.json.pkgAvailable} agents=${e.json.agents?.length} skills=${e.json.skills?.length} 引导语=${String(e.json.initPrompt).slice(0, 18)}… 快捷=${e.json.quickPrompts?.length}`);
