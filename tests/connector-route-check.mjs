/**
 * 连接器路由与工具面验证。写入路径全部指向临时 profile，绝不碰真实 cordis.patch.yml。
 *   node tests/connector-route-check.mjs
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const realHome = process.env.HOME, realDir = process.env.DSH_PROFILE_DIR;
const home = mkdtempSync(join(tmpdir(), "wbconn-"));
const pdir = join(home, "profiles", "probe");
mkdirSync(pdir, { recursive: true });
process.env.HOME = home;
process.env.DSH_PROFILE_DIR = pdir;

// 会话级挂载需要活体 agent；假 ctx.plugin 返回可直接 await 的 fiber 形状
const mounted = [];
const disposedRows = [];
function fakeAgent(id) {
	return {
		id,
		ctx: {
			plugin(mod, config) {
				mounted.push({ sessionId: id, serverName: config?.serverName, transport: config?.transport });
				return Object.assign(Promise.resolve(), { dispose: async () => { disposedRows.push(config?.serverName); } });
			},
		},
	};
}
const AGENT_A = fakeAgent("sess-A");
const AGENT_B = fakeAgent("sess-B");
const routes = [];
const tools = [];
const ctx = {
	effect: (f) => { const d = f(); return typeof d === "function" ? d : () => {}; },
	on: () => () => {},
	systemPrompt: { section: () => () => {} },
	tools: { register: (d) => { tools.push(d); return () => {}; } },
	webServer: { register: (d) => { routes.push(d); return () => {}; } },
	agents: { currentInitiator: () => ({ sessionId: "sess-A" }), get: (id) => (id === "sess-A" ? AGENT_A : id === "sess-B" ? AGENT_B : undefined) },
	logger: { info() {}, warn() {} },
};
// 预热一份握手缓存（真实数据的子集）：分级必须来自实测，不接受静态推断
mkdirSync(join(home, ".dsh/workbuddy-summon"), { recursive: true });
const cat0 = await (await import("../lib/connectors.js")).loadConnectors({});
const urlOf = (id) => cat0.byId.get(id)?.servers?.[0]?.url ?? null;
const stamp = Date.now();
const seeded = { at: stamp, ttlMs: 604800000, results: {} };
for (const [id, status] of [["westock-mcp", 401], ["kdocs", 200], ["qq-mail", 401], ["tencent-survey", 404]]) {
	const u = urlOf(id);
	if (u !== null) seeded.results[u] = { status, at: stamp };
}
writeFileSync(join(home, ".dsh/workbuddy-summon/connector-probe-cache.json"), JSON.stringify(seeded));

const CS = await import("../lib/connector-session.js");
CS.bindMcpClient({ name: "mcp-client", inject: [], apply() {} });
const M = await import("../index.js");
await M.apply(ctx, { warmCatalog: false });

let fails = 0;
const ok = (l, c, e = "") => { if (!c) fails += 1; console.log(`  ${c ? "✓" : "✗"} ${l}${e ? ` — ${e}` : ""}`); };

console.log("① 工具注册（开关默认开）");
ok("wb_connectors_list 已注册", tools.some((t) => t.name === "wb_connectors_list"));
ok("wb_connector_install 已注册", tools.some((t) => t.name === "wb_connector_install"));
ok("专家 4 个工具都在", ["wb_experts_list","wb_expert_read","wb_summon","wb_unsummon"].every((n) => tools.some((x) => x.name === n)), tools.map((t) => t.name).join(","));
for (const t of tools.filter((x) => x.name.startsWith("wb_conn"))) {
	ok(`${t.name} parameters 是完整 JSON Schema`, t.parameters?.type === "object" && t.parameters.additionalProperties === false);
}

async function call(method, path, body) {
	const ch = [];
	const res = { statusCode: null, headers: null, writeHead(s, h) { this.statusCode = s; this.headers = h; }, end(x) { if (x !== undefined) ch.push(Buffer.isBuffer(x) ? x : Buffer.from(String(x))); } };
	const req = new EventEmitter();
	req.method = method; req.url = path; req.destroy = () => {}; req.headers = {};
	queueMicrotask(() => { if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
	await routes[0].handler(req, res);
	return { status: res.statusCode, json: JSON.parse(Buffer.concat(ch).toString() || "{}") };
}

console.log("\n② GET /connectors");
const list = await call("GET", "/dsh-workbuddy-summon/connectors");
ok("200", list.status === 200);
ok("目录 317 条（在线）", list.json.catalogTotal === 317, `${list.json.catalogTotal} source=${list.json.source}`);
ok("accessSummary 有分级", Object.keys(list.json.accessSummary ?? {}).length > 0, JSON.stringify(list.json.accessSummary));
ok("item 字段精简", ["id", "name", "access", "transportKind", "installed", "summary"].every((k) => k in (list.json.items?.[0] ?? "")), Object.keys(list.json.items?.[0] ?? {}).join(","));
ok("无 servers/env 细节泄漏", !JSON.stringify(list.json.items).includes("mcpServers"));
const filt = await call("GET", "/dsh-workbuddy-summon/connectors?access=ready");
ok("按 access 过滤生效", filt.json.total > 0 && filt.json.total < list.json.total, `${filt.json.total}/${list.json.total}`);
const byId = (id) => list.json.items.find((i) => i.id === id);
ok("握手 200 → ready（kdocs）", byId("kdocs")?.access === "ready", String(byId("kdocs")?.access));
ok("握手 401 → needs-token（westock-mcp）", byId("westock-mcp")?.access === "needs-token", String(byId("westock-mcp")?.access));
ok("握手 404 → unreachable（tencent-survey）", byId("tencent-survey")?.access === "unreachable", String(byId("tencent-survey")?.access));
ok("未探测过 → unverified（不猜可用）", byId("lexiang")?.access === "unverified", String(byId("lexiang")?.access));
ok("缓存统计已暴露", typeof list.json.probe?.total === "number", JSON.stringify(list.json.probe?.byStatus));
const q = await call("GET", "/dsh-workbuddy-summon/connectors?q=邮箱");
ok("搜索命中", q.json.total >= 1, q.json.items?.[0]?.name);

console.log("\n③ POST /connector-install（会话级挂载，不写 profile patch）");
const target = list.json.items.find((i) => i.access === "ready");
ok("存在实测可接入的连接器", target !== undefined, JSON.stringify(list.json.accessSummary));
const noSid = await call("POST", "/dsh-workbuddy-summon/connector-install", { connectorId: target.id });
ok("缺 sessionId → 400（会话级要求）", noSid.status === 400, noSid.json.error);
const inst = await call("POST", "/dsh-workbuddy-summon/connector-install", { sessionId: "sess-A", connectorId: target.id });
ok(`接入 ${target.id} → 200`, inst.status === 200, JSON.stringify(inst.json).slice(0, 130));
ok("标记 scoped=true（只作用本会话）", inst.json.scoped === true);
ok("mcp-client 挂到了 sess-A 的 ctx", mounted.some((m) => m.sessionId === "sess-A" && m.serverName === inst.json.serverName), JSON.stringify(mounted));
ok("★ 不写 profile patch（不污染其他会话）", !existsSync(join(pdir, "cordis.patch.yml")));
const scoped = await call("GET", `/dsh-workbuddy-summon/connectors?sessionId=sess-A`);
ok("A 的列表标出已接入", scoped.json.items.find((i) => i.id === target.id)?.installed === true);
ok("A 的 installed 明细有 1 条", scoped.json.installed.length === 1, JSON.stringify(scoped.json.installed.map((r) => r.serverName)));
const other = await call("GET", `/dsh-workbuddy-summon/connectors?sessionId=sess-B`);
ok("★ B 看不到 A 的接入（会话隔离）", other.json.installed.length === 0, JSON.stringify(other.json.installed));
const nosession = await call("GET", "/dsh-workbuddy-summon/connectors");
ok("不传 sessionId → installed 为空", nosession.json.installed.length === 0);

console.log("\n④ 重复接入幂等 + 移除");
const dup = await call("POST", "/dsh-workbuddy-summon/connector-install", { sessionId: "sess-A", connectorId: target.id });
ok("重复接入仍 200", dup.status === 200, JSON.stringify(dup.json).slice(0, 90));
const dupList = await call("GET", "/dsh-workbuddy-summon/connectors?sessionId=sess-A");
ok("★ 不会重复计入（仍 1 条）", dupList.json.installed.length === 1, JSON.stringify(dupList.json.installed.map((r) => r.serverName)));
const rm = await call("POST", "/dsh-workbuddy-summon/connector-remove", { sessionId: "sess-A", connectorId: target.id });
ok("移除成功", rm.status === 200 && rm.json.removed === true, JSON.stringify(rm.json).slice(0, 90));
ok("子 fiber 被 dispose", disposedRows.includes(inst.json.serverName), JSON.stringify(disposedRows));
const after = await call("GET", "/dsh-workbuddy-summon/connectors?sessionId=sess-A");
ok("列表回到未接入", after.json.items.find((i) => i.id === target.id)?.installed === false);
const rm2 = await call("POST", "/dsh-workbuddy-summon/connector-remove", { sessionId: "sess-A", connectorId: target.id });
ok("重复移除返回 removed:false 不报错", rm2.status === 200 && rm2.json.removed === false);

console.log("\n⑤ 错误路径");
const bad = await call("POST", "/dsh-workbuddy-summon/connector-install", { sessionId: "sess-A", connectorId: "不存在的东西" });
ok("未知连接器 → 404", bad.status === 404, bad.json.error);
const noId = await call("POST", "/dsh-workbuddy-summon/connector-install", { sessionId: "sess-A" });
ok("缺 connectorId → 400", noId.status === 400);
const dead = await call("POST", "/dsh-workbuddy-summon/connector-install", { sessionId: "sess-GHOST", connectorId: target.id });
ok("会话无活体 agent → 404", dead.status === 404, dead.json.error);
const cliType = list.json.items.find((i) => i.access === "blocked");
if (cliType !== undefined) {
	const r = await call("POST", "/dsh-workbuddy-summon/connector-install", { sessionId: "sess-A", connectorId: cliType.id });
	ok("CLI 型被拒并说明原因", r.status === 400 && /CLI 型/.test(String(r.json.error)), r.json.error);
	const before = mounted.length;
	ok("★ 被拒时不发生挂载", mounted.length === before, `${before} → ${mounted.length}`);
}

console.log("\n⑥ 工具面 execute");
const tl = tools.find((t) => t.name === "wb_connectors_list");
const tr = await tl.execute({ access: "ready", limit: 3 });
ok("工具返回分级汇总", typeof tr.accessSummary === "object" && tr.items.length <= 3, `total=${tr.total}`);
ok("工具含 catalogTotal 与 etag", tr.catalogTotal === 317 && typeof tr.etag === "string");
const ti = tools.find((t) => t.name === "wb_connector_install");
const none = await ti.execute({});
ok("不传 id → 返回本会话已接入清单", Array.isArray(none.installed) && none.scoped === true, `count=${none.count} sid=${String(none.sessionId).slice(0, 10)}`);
const err = await ti.execute({ connectorId: "查无此连接器" });
ok("未知 id 报错不抛异常", typeof err.error === "string", err.error?.slice(0, 40));

console.log("\n⑦ 开关关闭时不注册连接器工具");
const tools2 = [];
const ctx2 = { ...ctx, tools: { register: (d) => { tools2.push(d); return () => {}; } } };
const routes2 = [];
ctx2.webServer = { register: (d) => { routes2.push(d); return () => {}; } };
await M.apply(ctx2, { warmCatalog: false, connectors: { enabled: false } });
ok("连接器工具未注册", !tools2.some((t) => t.name.startsWith("wb_connector")), tools2.map((t) => t.name).join(","));
ok("专家工具仍在", tools2.length === 4);

process.env.HOME = realHome; process.env.DSH_PROFILE_DIR = realDir;
try { chmodSync(home, 0o700); rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log(fails === 0 ? "\nCONNECTOR-ROUTE 全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
