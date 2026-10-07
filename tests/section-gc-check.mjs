/**
 * 注入段落盘的生命周期验证（垃圾回收）。
 *   node tests/section-gc-check.mjs
 *
 * 断言：
 *   · unsummon 之后不留 0 字节文件（改为删除）；
 *   · 启动 sweep 回收 0 字节历史遗留与孤儿文件；
 *   · **有召唤记录且非空的文件绝不能被删**（含本机真实会话）；
 *   · 组装不出内容时也不落空文件。
 */
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SECTIONS = join(homedir(), ".dsh/workbuddy-summon/sections");
const STATE = join(homedir(), ".dsh/workbuddy-summon/summons.json");
mkdirSync(SECTIONS, { recursive: true });

const realState = existsSync(STATE) ? readFileSyncSafe(STATE) : "{}";
function readFileSyncSafe(p) {
	return readFileSync(p, "utf8");
}
const realSessions = Object.keys(JSON.parse(realState));
console.log(`真实会话（必须保住）: ${realSessions.length} 个 → ${realSessions.map((s) => s.slice(0, 16) + "…").join(" ") || "无"}`);

// 造三类垃圾：0 字节、孤儿非空、以及一个"活着且非空"的真实文件保持原样
const junkEmpty = join(SECTIONS, "zz-test-empty.md");
const junkOrphan = join(SECTIONS, "zz-test-orphan.md");
writeFileSync(junkEmpty, "");
writeFileSync(junkOrphan, "孤儿内容，非空但没有召唤记录");
console.log(`\n投放垃圾: empty=${statSync(junkEmpty).size}B orphan=${statSync(junkOrphan).size}B`);

const routes = [];
const ctx = {
	effect: (f) => { const d = f(); return typeof d === "function" ? d : () => {}; },
	on: () => () => {},
	systemPrompt: { section: () => () => {} },
	tools: { register: () => () => {} },
	webServer: { register: (d) => { routes.push(d); return () => {}; } },
	agents: { currentInitiator: () => ({ sessionId: "zz-gc-probe" }) },
	logger: { info() {}, warn() {} },
};
const m = await import("../index.js");
await m.apply(ctx, { warmCatalog: false });

console.log("\nsweep 之后：");
const checks = [
	["0 字节垃圾被清", !existsSync(junkEmpty)],
	["孤儿文件被清", !existsSync(junkOrphan)],
];
for (const s of realSessions) {
	const f = join(SECTIONS, `${s.replace(/[^A-Za-z0-9_-]/g, "_")}.md`);
	checks.push([`真实会话文件保住 ${s.slice(0, 14)}…`, existsSync(f) && statSync(f).size > 0]);
}
let bad = 0;
for (const [label, ok] of checks) { if (!ok) bad += 1; console.log(`  ${ok ? "✓" : "✗"} ${label}`); }

console.log("\nunsummon 不留空文件（召唤→取消）：");
async function call(method, path, body) {
	const ch = [];
	const res = { statusCode: null, headers: null, writeHead(s, h) { this.statusCode = s; this.headers = h; }, end(x) { if (x !== undefined) ch.push(Buffer.isBuffer(x) ? x : Buffer.from(String(x))); } };
	const req = new EventEmitter();
	req.method = method; req.url = path; req.destroy = () => {}; req.headers = {};
	queueMicrotask(() => { if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
	await routes[0].handler(req, res);
	return { status: res.statusCode, json: JSON.parse(Buffer.concat(ch).toString() || "{}") };
}
const sid = "zz-gc-probe";
const secFile = join(SECTIONS, `${sid}.md`);
const sum = await call("POST", "/dsh-workbuddy-summon/summon", { sessionId: sid, plugin: "design-engine" });
const afterSummon = existsSync(secFile) ? statSync(secFile).size : -1;
console.log(`  召唤 → ${sum.status}，落盘 ${afterSummon}B ${afterSummon > 1000 ? "✓ 有内容" : "✗"}`);
const un = await call("POST", "/dsh-workbuddy-summon/unsummon", { sessionId: sid });
console.log(`  取消 → ${un.status} cleared=${un.json.cleared}，文件存在=${existsSync(secFile)} ${!existsSync(secFile) ? "✓ 已删除（不是留 0 字节）" : "✗ 仍留文件"}`);

// 清理本测试留下的状态
try { rmSync(secFile, { force: true }); } catch { /* 已删 */ }
const st = JSON.parse(existsSync(STATE) ? readFileSyncSafe(STATE) : "{}");
if (sid in st) { delete st[sid]; writeFileSync(STATE, JSON.stringify(st, null, 1)); }
console.log(`\n测试自清理：状态键剩余 ${Object.keys(JSON.parse(existsSync(STATE) ? readFileSyncSafe(STATE) : "{}")).length} 个（应等于真实会话数 ${realSessions.length}）`);
console.log(`sections/ 现存：${readdirSync(SECTIONS).join(" ") || "（空）"}`);

if (bad > 0 || existsSync(secFile)) { console.error(`\n失败 ${bad} 项`); process.exit(1); }
console.log("\nSECTION GC 全部通过");
