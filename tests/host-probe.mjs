/**
 * Host 半边离线探针：不重启 DSH，用假 ctx 跑 apply()，端到端验证
 *   · 三个扩展点调用形状（systemPrompt.section / tools.register / webServer.register）
 *   · HTTP 路由真实响应（catalog / status / summon / unsummon）
 *   · 注入求值器：未召唤=空串，召唤后=有文本，取消后=回到空串
 *
 * 跑法（需要 Electron 才能读 asar，本探针不依赖 asar，纯 node 也行）：
 *   node tests/host-probe.mjs
 */
import { EventEmitter } from "node:events";

const Emitter = EventEmitter;
const calls = { sections: [], tools: [], routes: [], effects: 0 };
const disposers = [];

const ctx = {
	effect(fn, label) {
		calls.effects += 1;
		const d = fn();
		if (typeof d === "function") disposers.push(d);
		return typeof d === "function" ? d : () => {};
	},
	on() {
		return () => {};
	},
	systemPrompt: {
		section(def) {
			calls.sections.push(def);
			return () => {};
		},
	},
	tools: {
		register(def) {
			calls.tools.push(def);
			return () => {};
		},
	},
	webServer: {
		register(def) {
			calls.routes.push(def);
			return () => {};
		},
	},
	agents: {
		currentInitiator: () => ({ sessionId: "probe-session", session: { header: { id: "probe-session" } } }),
	},
	logger: { info: () => {}, warn: () => {} },
};

const mod = await import("../index.js");
console.log(`模块导出：name=${mod.name} inject=${JSON.stringify(mod.inject)}`);
if (mod.name !== "dsh-workbuddy-summon") throw new Error("name 不对");
for (const need of ["systemPrompt", "tools", "webServer", "agents"]) {
	if (!mod.inject.includes(need)) throw new Error(`inject 缺 ${need} —— 运行时会 getter 抛错`);
}

await mod.apply(ctx, { maxLeadChars: 24000, warmCatalog: false, connectors: { enabled: false } });

console.log(
	`apply 完成：section×${calls.sections.length} tool×${calls.tools.length} route×${calls.routes.length} effect×${calls.effects}`,
);
if (calls.sections.length !== 1) throw new Error("systemPrompt.section 应注册 1 段");
if (calls.tools.length !== 4) throw new Error(`应注册 4 个工具，实得 ${calls.tools.length}`);
if (calls.routes.length !== 1) throw new Error("webServer 路由应注册 1 条");

const section = calls.sections[0];
console.log(`  section: name=${section.name} order=${section.order} text 类型=${typeof section.text}`);
console.log(`  tools: ${calls.tools.map((t) => t.name).join(", ")}`);
console.log(`  route: kind=${calls.routes[0].kind} path=${calls.routes[0].path}`);

// 工具 parameters 必须是完整 JSON Schema（宿主严格校验）
for (const t of calls.tools) {
	const p = t.parameters;
	if (p?.type !== "object" || typeof p.properties !== "object" || p.additionalProperties !== false) {
		throw new Error(`工具 ${t.name} 的 parameters 不是完整 JSON Schema`);
	}
	if (typeof t.execute !== "function") throw new Error(`工具 ${t.name} 缺 execute`);
	if (t.output?.schema === undefined || typeof t.output?.render !== "function") {
		throw new Error(`工具 ${t.name} 缺 output{schema,render}`);
	}
}

/* ───────────────── 求值器：未召唤 → 空串 ───────────────── */
const evalFor = (sessionId) => section.text({ agent: { sessionId, session: { header: { id: sessionId } } } });
const before = evalFor("never-summoned");
console.log(`\n求值器（未召唤会话）→ 长度 ${before.length} ${before === "" ? "✓ 不注入" : "✗ 有残留"}`);
if (before !== "") throw new Error("未召唤的会话被注入了内容");
const noCtx = section.text(undefined);
console.log(`求值器（context 缺失）→ 长度 ${noCtx.length} ${noCtx === "" ? "✓" : "✗"}`);

/* ───────────────── 路由端到端 ───────────────── */
const handler = calls.routes[0].handler;

/**
 * handler 只用到 req.method / req.url 与 readBody 的 data/end 事件，
 * 所以一个 EventEmitter 就够，不必造真的 IncomingMessage。
 */
function fakeReq(method, url, body) {
	const req = new Emitter();
	req.method = method;
	req.url = url;
	req.destroy = () => {};
	req.headers = {};
	queueMicrotask(() => {
		if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
		req.emit("end");
	});
	return req;
}

async function call(method, url, body) {
	const chunks = [];
	const res = {
		statusCode: null,
		headers: null,
		writeHead(s, h) {
			this.statusCode = s;
			this.headers = h;
		},
		end(x) {
			chunks.push(x);
		},
	};
	await handler(fakeReq(method, url, body), res);
	const text = chunks.join("");
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = { _raw: text.slice(0, 200) };
	}
	return { status: res.statusCode, json };
}

console.log("\n路由：");
const health = await call("GET", "/dsh-workbuddy-summon/status");
console.log(`  GET /status → ${health.status} ok=${health.json.ok} injected=${health.json.injected}`);

const cat = await call("GET", "/dsh-workbuddy-summon/catalog?kind=team");
console.log(
	`  GET /catalog?kind=team → ${cat.status} total=${cat.json.total} degraded=${cat.json.degraded}` +
		` 首条=${cat.json.items?.[0]?.name ?? "?"}`,
);
if (cat.status !== 200 || !(cat.json.total > 40)) throw new Error("catalog 路由异常");

const one = await call("GET", "/dsh-workbuddy-summon/catalog?q=网文");
console.log(`  GET /catalog?q=网文 → ${one.status} total=${one.json.total}`);

const bad = await call("GET", "/dsh-workbuddy-summon/nope");
console.log(`  GET 未知子路径 → ${bad.status} ${bad.json.error ?? ""} ${bad.status === 404 ? "✓" : "✗"}`);

const miss = await call("POST", "/dsh-workbuddy-summon/summon", { sessionId: "probe-session", plugin: "不存在的包" });
console.log(`  POST /summon 不存在 → ${miss.status} ${String(miss.json.error).slice(0, 46)} ${miss.status === 404 ? "✓" : "✗"}`);

const nosid = await call("POST", "/dsh-workbuddy-summon/summon", { plugin: "design-engine" });
console.log(`  POST /summon 缺 sessionId → ${nosid.status} ${nosid.json.error} ${nosid.status === 400 ? "✓" : "✗"}`);

const sum = await call("POST", "/dsh-workbuddy-summon/summon", { sessionId: "probe-session", plugin: "design-engine" });
console.log(
	`  POST /summon design-engine → ${sum.status} kind=${sum.json.kind} 成员=${(sum.json.members ?? []).length}` +
		` 注入=${sum.json.chars} 字符 ${sum.status === 200 ? "✓" : "✗"}`,
);
if (sum.status !== 200) throw new Error(`summon 失败：${JSON.stringify(sum.json)}`);

const after = evalFor("probe-session");
console.log(`  求值器（召唤后）→ 长度 ${after.length} ${after.length > 1000 ? "✓ 已注入" : "✗"}`);
if (!after.includes("spawn_teammate")) throw new Error("注入文本缺调度映射");

const st = await call("GET", "/dsh-workbuddy-summon/status?sessionId=probe-session");
console.log(
	`  GET /status?sessionId → ${st.status} summon=${st.json.summon?.plugin} injected=${st.json.injected}` +
		` ${st.json.summon?.plugin === "design-engine" ? "✓" : "✗"}`,
);

const toolList = calls.tools.find((t) => t.name === "wb_experts_list");
const tl = await toolList.execute({ kind: "team", limit: 3 });
console.log(`  工具 wb_experts_list → total=${tl.total} 返回=${tl.items.length} 当前召唤=${tl.currentSummon?.plugin}`);

const toolRead = calls.tools.find((t) => t.name === "wb_expert_read");
const tr = await toolRead.execute({ plugin: "design-engine", agent: "prototype-builder" });
console.log(`  工具 wb_expert_read agent=prototype-builder → 正文 ${tr.text?.length ?? 0} 字符 ${tr.text ? "✓" : "✗"}`);
const trS = await toolRead.execute({ plugin: "design-engine", skill: "design-systems" });
console.log(`  工具 wb_expert_read skill=design-systems → ${trS.text?.length ?? 0} 字符 ${trS.text ? "✓" : "✗"}`);
const trBad = await toolRead.execute({ plugin: "design-engine", agent: "查无此人" });
console.log(`  工具 wb_expert_read 错误成员 → 提示可用清单 ${(trBad.available ?? []).length} 项 ${trBad.error ? "✓" : "✗"}`);

const un = await call("POST", "/dsh-workbuddy-summon/unsummon", { sessionId: "probe-session" });
const cleared = evalFor("probe-session");
console.log(
	`  POST /unsummon → ${un.status} cleared=${un.json.cleared}；求值器回到长度 ${cleared.length}` +
		` ${un.json.cleared === true && cleared === "" ? "✓ 干净取消" : "✗"}`,
);
if (cleared !== "") throw new Error("取消召唤后仍有注入残留");

for (const d of disposers) d();
console.log(`\n清理 ${disposers.length} 个 effect disposer ✓`);
console.log("HOST PROBE 全部通过");
process.exit(0);
