/**
 * 会话级接入的隔离验证。
 *
 * 分两层：
 *   A. 机制层（本文件）—— 用**真 cordis + 真 dsh-scope**（ScopedLayers/NamedEntries/
 *      createScope/scopeOf），复刻 dsh-tools ToolRuntime.view() 的分层可见性。
 *      不 mock dsh-tools 本身：mock 它等于自己实现一遍它的逻辑，就成了自证。
 *   B. 端到端 —— 只能在真实 DSH 会话里验（重启后按 README 的步骤做）。
 *
 * 依据（源码事实，非推测）：
 *   · dsh-agent-loop: `this.scope = createScope(loopCtx, this)` → agent 实例即 scope key
 *   · dsh-tools ToolLayer 重复报错原文：`for a per-agent variant, register through
 *     that agent's \`agent.ctx\` instead` —— 官方设计的按会话注册入口
 *   · dsh-mcp-client: activeServerNames 按 scopeOf(ctx) 分桶，注释
 *     "Agent-scoped MCP servers may reuse a namespace in another Agent"
 *
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     tests/session-isolation-check.mjs
 */
import { mkdtempSync, chmodSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const R = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai";
const home = mkdtempSync(join(tmpdir(), "wbsess-"));
process.env.HOME = home;
process.env.DSH_PROFILE_DIR = join(home, "profiles", "probe");

const { Context } = await import(`${R}/cordis/lib/index.js`);
const scope = await import(`${R}/dsh-scope/lib/index.js`);

let fails = 0;
const ok = (l, c, e = "") => { if (!c) fails += 1; console.log(`  ${c ? "✓" : "✗"} ${l}${e ? ` — ${e}` : ""}`); };

/* ── 机制层：真 ScopedLayers + 真 NamedEntries，复刻 ToolRuntime.view() 的合并规则 ── */
const root = new Context();
const rootCtx = root.ctx ?? root;

// dsh-tools 的 ToolLayer 只有 tools 表参与可见性合并，这里用真 NamedEntries 建同名结构
function makeLayer() {
	return { tools: new scope.NamedEntries((name) => new Error(`tool "${name}" already registered`)) };
}
// 第二个参数是 onChange 通知（真 dsh-tools 用它 emit("tools/change")），回收路径会调用它
let changeEvents = 0;
const layers = new scope.ScopedLayers(makeLayer, () => { changeEvents += 1; });

// 复刻 dsh-tools ToolRuntime.view()：全局 + scope 链，nearest last
function visibleFor(agent) {
	const own = layers.peek(agent);
	const merged = layers.merge(agent, (l) => l.tools);
	return [...merged.keys()];
}

const agentA = { id: "session-A" };
const agentB = { id: "session-B" };
const scopeA = scope.createScope(rootCtx, agentA);
const scopeB = scope.createScope(rootCtx, agentB);

ok("scope key 就是 agent 实例（scopeOf 回读）", scope.scopeOf(scopeA.ctx) === agentA);

// 全局注册（模拟 profile 级 mcp-client）
layers.effect(rootCtx, () => layers.global.tools.insert("mcp__kdocs__global"), { label: "global" });
// 会话 A 专属注册（模拟 agent.ctx.plugin(mcpClient)）
layers.effect(scopeA.ctx, () => layers.peek(agentA).tools.insert("mcp__kdocs__scoped"), { label: "scopedA" });

console.log("\n① 分层可见性（真 dsh-scope）");
ok("A 看得到自己的 scoped 工具", visibleFor(agentA).includes("mcp__kdocs__scoped"), JSON.stringify(visibleFor(agentA)));
ok("B 看不到 A 的 scoped 工具", !visibleFor(agentB).includes("mcp__kdocs__scoped"), JSON.stringify(visibleFor(agentB)));
ok("两个会话都看得到全局工具", visibleFor(agentA).includes("mcp__kdocs__global") && visibleFor(agentB).includes("mcp__kdocs__global"));
ok("注册变更会触发 onChange（对应 tools/change）", changeEvents > 0, `count=${changeEvents}`);

console.log("\n② scope 销毁 → scoped 注册自动回收（真 effect 归属）");
await scopeA.dispose();
ok("A 的 scoped 层已随 scope 清理", layers.peek(agentA)?.tools.has("mcp__kdocs__scoped") !== true,
	JSON.stringify([...(layers.peek(agentA)?.tools.keys() ?? [])]));
ok("B 未受影响", visibleFor(agentB).includes("mcp__kdocs__global"));

/* ── connector-session 的行为层（假 mcp-client，只验挂载/移除/落盘纪律）── */
console.log("\n③ connector-session 行为");
const registered = [];
const disposed = [];
// 不 inject：root 里没有 provide("tools")，声明依赖会让 fiber 静默加载失败
const fakeMcp = {
	name: "mcp-client",
	inject: [],
	apply(ctx, config) {
		registered.push(config.serverName);
		ctx.effect(() => () => disposed.push(config.serverName), "fake.tool");
	},
};
const CS = await import("../lib/connector-session.js");
CS.bindMcpClient(fakeMcp);
const liveA = { id: "live-A", ctx: scope.createScope(rootCtx, { id: "live-A" }).ctx };
const liveB = { id: "live-B", ctx: scope.createScope(rootCtx, { id: "live-B" }).ctx };
CS.bindAgents({ get: (id) => (id === liveA.id ? liveA : id === liveB.id ? liveB : undefined) });

const conn = { id: "kdocs", name: "金山文档", servers: [{ transport: "streamable-http", url: "https://mcp-center.wps.cn/skill_hub/mcp", args: [], env: {}, timeout: 30000 }] };
const r1 = await CS.connectInSession(conn, liveA);
ok("返回 scoped 标记", r1.scoped === true && r1.serverName === "kdocs", JSON.stringify(r1).slice(0, 80));
ok("mcp-client 被挂载一次", registered.filter((n) => n === "kdocs").length === 1, JSON.stringify(registered));

const r2 = await CS.connectInSession(conn, liveB);
ok("另一会话可复用同名 serverName（官方 Agent-scoped 语义）", r2.serverName === "kdocs" && !r2.error);

await CS.disconnectInSession(liveA.id, "kdocs");
ok("移除触发子 fiber dispose", disposed.includes("kdocs"), JSON.stringify(disposed));

console.log("\n④ 落盘纪律：绝不写凭据");
process.env.TUSHARE_TOKEN = "SECRET-abc123";
const withToken = { id: "tushare", name: "Tushare", servers: [{ transport: "streamable-http", url: "https://api.tushare.pro/mcp/?token=${TUSHARE_TOKEN}", args: [], env: {} }] };
const rt = await CS.connectInSession(withToken, liveA);
ok("URL 里已解析成真实值（只在内存）", registered.includes("tushare"));
const store = join(home, ".dsh/workbuddy-summon/session-connectors.json");
ok("存储文件已生成", existsSync(store));
const disk = existsSync(store) ? readFileSync(store, "utf8") : "";
ok("★ 磁盘不含明文令牌", !disk.includes("SECRET-abc123"));
ok("★ 磁盘不含 config 字段", !disk.includes('"config"'), disk.slice(0, 100));
ok("磁盘保留接入意图（可恢复）", disk.includes("tushare"));

console.log("\n⑤ 会话隔离：意图按 sessionId 分桶");
const aIntents = CS.listForSession(liveA.id).map((x) => x.connectorId);
ok("A 剩 1 条（kdocs 已移除、tushare 保留）", JSON.stringify(aIntents) === '["tushare"]', JSON.stringify(aIntents));
ok("B 有 1 条", CS.listForSession(liveB.id).length === 1);
ok("无接入的会话返回空", CS.listForSession("没这个会话").length === 0);

try { chmodSync(home, 0o700); rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log(fails === 0 ? "\nSESSION-ISOLATION 全部通过（机制层；端到端待真会话验证）" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
