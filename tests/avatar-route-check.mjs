/** 头像 HTTP 路由验证：二进制响应、mime、缓存头、404 语义。 */
import { EventEmitter } from "node:events";
const routes = [];
const ctx = {
	effect: (f) => { const d = f(); return typeof d === "function" ? d : () => {}; },
	on: () => () => {},
	systemPrompt: { section: () => () => {} },
	tools: { register: () => () => {} },
	webServer: { register: (d) => { routes.push(d); return () => {}; } },
	agents: { currentInitiator: () => ({ sessionId: "a" }) },
	logger: { info() {}, warn() {} },
};
const m = await import("../index.js");
await m.apply(ctx, { warmCatalog: false });
async function raw(method, url, extraHeaders) {
	const chunks = [];
	const res = { statusCode: null, headers: null,
		writeHead(s, h) { this.statusCode = s; this.headers = h; },
		end(x) { if (x !== undefined) chunks.push(Buffer.isBuffer(x) ? x : Buffer.from(x)); } };
	const req = new EventEmitter(); req.method = method; req.url = url; req.destroy = () => {};
	req.headers = extraHeaders ?? {};
	queueMicrotask(() => req.emit("end"));
	await routes[0].handler(req, res);
	return { status: res.statusCode, headers: res.headers ?? {}, body: Buffer.concat(chunks) };
}
const ok = (c) => c === 200 ? "✓" : "✗";
let r = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=design-engine&size=64");
console.log(`team 头像 → ${r.status} ${r.headers["Content-Type"]} ${r.body.length}B ${ok(r.status)}`);
console.log(`  PNG magic: ${r.body.subarray(1,4).toString() === "PNG" ? "✓ 是 PNG" : "✗ 不是图片"}`);
console.log(`  缓存头: ${r.headers["Cache-Control"] ?? "（无）"}`);
console.log(`  Content-Length 与实际一致: ${Number(r.headers["Content-Length"]) === r.body.length ? "✓" : "✗"}`);

r = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=design-engine&agent=prototype-builder");
console.log(`成员头像 → ${r.status} ${r.body.length}B（与整团不同源）${ok(r.status)}`);
const team = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=design-engine");
console.log(`  与团长图不同: ${team.body.length !== r.body.length ? "✓" : "⚠ 同尺寸"}`);

r = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=不存在的包");
console.log(`未知包 → ${r.status} ${r.body.toString().slice(0,40)} ${r.status === 404 ? "✓" : "✗"}`);
r = await raw("GET", "/dsh-workbuddy-summon/avatar");
console.log(`缺 plugin → ${r.status} ${r.status === 400 ? "✓" : "✗"}`);
r = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=xiaohongshu-operations-expert");
console.log(`用户已召唤的那个专家 → ${r.status} ${r.body.length}B ${ok(r.status)}`);
r = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=novel-workshop-pro");
console.log(`本机社区包（第4源）→ ${r.status} ${r.body.length}B ${ok(r.status)}`);

// —— ETag / 304（实时性的关键：换头像不能被长缓存挡住）——
const first = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=design-engine&size=64");
const etag = first.headers["ETag"];
console.log(`\nETag: ${etag ?? "（无）"} ${typeof etag === "string" && etag.startsWith('W/"') ? "✓" : "✗"}`);
console.log(`Cache-Control: ${first.headers["Cache-Control"]} ${/max-age=300/.test(first.headers["Cache-Control"] ?? "") ? "✓ 短缓存，换头像不会被挡一天" : "✗"}`);
const reval = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=design-engine&size=64", { "if-none-match": etag });
console.log(`带 If-None-Match 再请求 → ${reval.status} 体 ${reval.body.length}B ${reval.status === 304 && reval.body.length === 0 ? "✓ 304 空体" : "✗"}`);
const stale = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=design-engine&size=64", { "if-none-match": 'W/"deadbeef"' });
console.log(`ETag 不匹配 → ${stale.status} ${stale.body.length}B ${stale.status === 200 ? "✓ 回新图" : "✗"}`);
