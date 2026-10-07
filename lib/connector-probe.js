/**
 * 连接器可达性：以**真实 MCP 握手**为准，静态规则只做兜底。
 *
 * 为什么不信静态规则：实测 248 条无占位变量的远端 endpoint 里，
 * 按「auth_mode 为空 + 无 ${VAR}」判成 ready 的有 232 条，而真实 initialize
 * 握手只有 **32 条返回 200**，201 条是 401/403 —— 乐观了 7 倍。
 * 清单里的 auth_mode 标签同样不可信：kdocs 标 server-side 却握手 200，
 * westock-mcp 标签为空却要 WorkBuddy 代持的 Bearer。
 *
 * 所以分级优先查探测缓存；没探测过的一律标 unverified，不猜「可用」。
 * 探测是按需的（UI 点「验证」或工具传 probe），启动时不做全量探测。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "./connectors.js";

const CACHE = join(STATE_ROOT, "connector-probe-cache.json");
const TTL_MS = 7 * 24 * 3600 * 1000;
const INIT_BODY = JSON.stringify({
	jsonrpc: "2.0", id: 1, method: "initialize",
	params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "dsh-workbuddy-summon", version: "1" } },
});

let cache = null;

function readCache() {
	if (cache !== null) return cache;
	try {
		const parsed = JSON.parse(readFileSync(CACHE, "utf8"));
		const results = parsed.results ?? {};
		// 外部导入的缓存可能没有逐条 at（手工预热时踩过）：缺了就补成文件级时间戳，
		// 否则 Date.now() - undefined = NaN，比较恒 false → 全部判过期、分级退回 unverified。
		const stamp = parsed.at ?? 0;
		for (const v of Object.values(results)) if (!Number.isFinite(v?.at)) v.at = stamp;
		cache = { at: stamp, ttlMs: parsed.ttlMs ?? TTL_MS, results };
	} catch {
		cache = { at: 0, ttlMs: TTL_MS, results: {} };
	}
	return cache;
}

function writeCache() {
	mkdirSync(STATE_ROOT, { recursive: true });
	writeFileSync(CACHE, JSON.stringify(readCache(), null, 1));
}

/** 取某 URL 的最近一次握手结果；过期或没有返回 undefined。 */
export function probeResult(url) {
	const c = readCache();
	const hit = c.results[url];
	if (hit === undefined) return undefined;
	if (Date.now() - (hit.at ?? c.at) > c.ttlMs) return undefined;
	return hit;
}

/**
 * 真实握手探测。只用于远端 HTTP endpoint —— stdio 型会真的执行 npx 下载包，
 * 有副作用且慢，不做自动探测。
 * @returns {Promise<{status:number|string, at:number, note?:string}>}
 */
export async function probeEndpoint(url, timeoutMs = 12_000) {
	let status = "ERR";
	let note;
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: INIT_BODY,
			signal: AbortSignal.timeout(timeoutMs),
		});
		status = res.status;
		await res.body?.cancel?.();
	} catch (error) {
		status = /timeout|abort/i.test(String(error?.name ?? "")) ? "TIMEOUT" : "ERR";
		note = String(error?.message ?? error).slice(0, 120);
	}
	const c = readCache();
	c.results[url] = { status, at: Date.now(), ...(note ? { note } : {}) };
	writeCache();
	return c.results[url];
}

/**
 * 分级。level 语义：
 *   ready             实测握手 200，可直接接入
 *   needs-credential  URL/env 里有 ${VAR} 占位，用户填了就能用（最可达的一类）
 *   needs-token       实测 401/403：WorkBuddy 代持令牌，接入需自行搞到 Bearer 填进 headers
 *   needs-cli-login   定义要求先走 CLI 登录（preAuth: cli）
 *   unreachable       实测 404/超时/网络错误
 *   blocked           CLI 型，没有 MCP server 定义
 *   unsupported       传输方式 DSH 不支持
 *   unverified        stdio 型或没探测过 —— 不猜可用
 */
export function classify(connector) {
	const servers = connector?.servers ?? [];
	if (servers.length === 0) return { level: "blocked", why: "CLI 型连接器，无 MCP server 定义；需先安装并登录其 CLI", needsEnv: [] };
	const s = servers[0];
	if (s.transport !== "stdio" && s.transport !== "streamable-http") {
		return { level: "unsupported", why: `传输方式 ${s.transport} 不被 DSH 支持（仅 stdio / streamable-http）`, needsEnv: [] };
	}
	const hay = `${s.url ?? ""} ${JSON.stringify(s.env ?? {})}`;
	const needsEnv = [...new Set([...hay.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))];
	if (needsEnv.length > 0) {
		return { level: "needs-credential", why: `URL/env 含待填凭据：${needsEnv.join(", ")}`, needsEnv };
	}
	if (s.transport === "stdio") {
		return { level: "unverified", why: `stdio 型（${s.command}），未启动验证；接入后会真的执行该命令`, needsEnv: [], command: s.command };
	}
	const hit = probeResult(s.url);
	if (hit === undefined) {
		return { level: "unverified", why: "未做过握手探测，不预设可用", needsEnv: [], probe: true };
	}
	if (hit.status === 200) return { level: "ready", why: "实测 initialize 握手 200，免鉴权可用", needsEnv: [], probedAt: hit.at };
	if (hit.status === 401 || hit.status === 403) {
		return { level: "needs-token", why: `实测握手 ${hit.status}：WorkBuddy 侧代持令牌，接入需自行获取 Bearer 填入 headers`, needsEnv: [] };
	}
	return { level: "unreachable", why: `实测握手返回 ${hit.status}${hit.note ? `（${hit.note}）` : ""}`, needsEnv: [] };
}

/** 批量按需探测（UI「验证」用）。并发受限，避免压垮对方服务。 */
export async function probeMany(urls, concurrency = 6) {
	const queue = [...new Set(urls.filter(Boolean))];
	const out = {};
	let i = 0;
	const workers = Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, async () => {
		while (i < queue.length) {
			const url = queue[i++];
			out[url] = await probeEndpoint(url);
		}
	});
	await Promise.all(workers);
	return out;
}

export function probeCacheStats() {
	const c = readCache();
	const values = Object.values(c.results);
	const fresh = values.filter((v) => Date.now() - (v.at ?? 0) < c.ttlMs).length;
	const by = {};
	for (const v of values) by[v.status] = (by[v.status] ?? 0) + 1;
	return { total: values.length, fresh, byStatus: by, ttlMs: c.ttlMs };
}
