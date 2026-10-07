/**
 * 会话级连接器接入 —— 与「召唤专家」同构：只作用于当前会话。
 *
 * 为什么不能像最初那样写 cordis.patch.yml：那是 profile 级，接一个连接器
 * 所有会话都会多出一堆 mcp__* 工具、每轮白付 schema token。
 *
 * 机制（逐条实测确认，非推测）：
 *   · dsh-agent-loop 里 `this.scope = createScope(loopCtx, this)` —— **agent 实例本身就是 scope key**；
 *   · dsh-scope 的 `scopeOf(ctx)` 返回该 key；真 cordis 实测 `scopeOf(scopeA.ctx) === agentA` ✓；
 *   · 在 `agent.ctx` 上 `ctx.plugin(...)` 注册的子 fiber，随该 scope dispose 自动清理
 *     （实测 dispose 计数 0→1，且不影响其他会话）✓；
 *   · dsh-mcp-client 的 serverName 按 `scopeOf(ctx)` 分桶，注释明写
 *     "Agent-scoped MCP servers may reuse a namespace in another Agent"；
 *   · tools.register() 注释："Register globally or in the calling agent scope.
 *     Scoped tools shadow globals" —— 所以 scoped 工具只对那个会话可见。
 *
 * 因此不需要生成 YAML、不需要 reconcile、不需要备份轮转：直接把连接器配置
 * 交给 mcp-client 的 apply(ctx, config)。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "./connectors.js";

const STORE = join(STATE_ROOT, "session-connectors.json");
const MOUNT_TIMEOUT_MS = 12_000;
const MAX_SESSIONS = 200;

const log = (msg, err) =>
	console[err ? "warn" : "log"](`[dsh-workbuddy-summon] ${msg}${err ? `: ${err?.message ?? err}` : ""}`);

/** sessionId → [{ connectorId, serverName, config, at }] */
const intents = new Map();
/** sessionId → Map<serverName, fiber> */
const live = new Map();
let mcpClientPromise;
/** 测试注入点：可换成假 mcp-client，以便在纯 node 下验证挂载/隔离逻辑。 */
let mcpClientOverride;

const MCP_CLIENT_REL = "app.asar/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js";

/** 候选基址：Electron 主进程的 resourcesPath 优先，探针/异常环境退到可执行文件与 cwd 推导。 */
function mcpClientCandidates() {
	const out = [];
	if (typeof process.resourcesPath === "string" && process.resourcesPath.length > 0) out.push(process.resourcesPath);
	if (typeof process.execPath === "string" && process.execPath.includes(".app/Contents/MacOS")) {
		out.push(process.execPath.replace(/\/Contents\/MacOS$/, "/Resources"));
	}
	out.push(process.cwd());
	return out;
}

/** 懒加载宿主内置的 mcp-client（asar 内路径只有 Electron 能 import；候选逐个试，取第一个成功的）。 */
function loadMcpClient() {
	if (mcpClientOverride !== undefined) return Promise.resolve(mcpClientOverride);
	mcpClientPromise ??= (async () => {
		const errors = [];
		for (const base of mcpClientCandidates()) {
			try {
				return await import(`${base}/${MCP_CLIENT_REL}`);
			} catch (error) {
				errors.push(`${base}: ${String(error?.message ?? error).slice(0, 90)}`);
			}
		}
		mcpClientPromise = undefined;
		throw new Error(`无法加载宿主 mcp-client（试过 ${mcpClientCandidates().length} 个路径）→ ${errors[0] ?? "?"}`);
	})();
	return mcpClientPromise;
}

/**
 * serverName 归一：必须 `[A-Za-z0-9_-]{1,32}`（mcp-client 的硬校验）。
 * 连接器 id 可能带点或超长，这里做确定性转换 —— 同一 id 永远得同一名字；
 * 超长时截断后补 FNV 短 hash（不是安全场景，只要不撞名）。
 */
export function safeServerName(connectorId) {
	const flat = String(connectorId ?? "").replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
	if (flat.length === 0) return "wb_" + shortHash(String(connectorId ?? ""));
	if (flat.length <= 32) return flat;
	return flat.slice(0, 23) + "_" + shortHash(flat);
}

function shortHash(text) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36).padStart(6, "0").slice(0, 6);
}

/* 持久化*/

function readStore() {
	try {
		const parsed = JSON.parse(readFileSync(STORE, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
		for (const [sessionId, rows] of Object.entries(parsed)) {
			if (!Array.isArray(rows)) continue;
			// 旧版本可能落过 config：读到时忽略（一律按 connectorId 重建），不沿用磁盘凭据
			const kept = rows
				.filter((r) => typeof r?.serverName === "string" && typeof r?.connectorId === "string")
				.map(({ config, ...rest }) => rest);
			if (kept.length > 0) intents.set(sessionId, kept);
		}
	} catch {
		/* 无存储 */
	}
}

function writeStore() {
	try {
		mkdirSync(STATE_ROOT, { recursive: true });
		const obj = {};
		// 只落「接哪个连接器」的意图，**绝不落 config**：buildMcpConfig 已把 ${VAR}
		// 解析成真实令牌，写盘等于把凭据明文存进 ~/.dsh。恢复时按 connectorId
		// 重新查目录 + 重新读环境（restoreForSession 就是这么做的）。
		for (const [k, v] of intents) {
			if (v.length === 0) continue;
			obj[k] = v.map(({ config, ...rest }) => rest);
		}
		writeFileSync(STORE, JSON.stringify(obj, null, 1));
	} catch (error) {
		log("会话接入状态落盘失败（内存态仍生效）", error);
	}
}

let loaded = false;
function ensureLoaded() {
	if (loaded) return;
	loaded = true;
	readStore();
}

/** 从盘重读并合并（保留内存中已挂载行的 live 状态）。 */
function reloadStore() {
	const liveRows = new Map([...intents].map(([k, v]) => [k, v]));
	intents.clear();
	readStore();
	for (const [k, v] of liveRows) {
		const cur = intents.get(k) ?? [];
		for (const r of v) if (!cur.some((x) => x.serverName === r.serverName)) cur.push(r);
		if (cur.length > 0) intents.set(k, cur);
	}
}

/* ─────────────────────────── 配置构造 ─────────────────────────── */

/** 把 WorkBuddy 的 `${VAR}` 就地求值（读 process.env），并报告缺失项。 */
function resolveVars(text, out) {
	return String(text ?? "").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, name) => {
		const value = process.env[name];
		if (value === undefined || value.length === 0) out.push(name);
		return value ?? "";
	});
}

/**
 * 连接器定义 → mcp-client 的 config。
 * @param {{servers: object[]}} connector
 * @param {string} serverName
 * @returns {{config: object, missing: string[]}}
 */
export function buildMcpConfig(connector, serverName) {
	const server = connector?.servers?.[0];
	if (server === undefined) throw new Error(`连接器「${connector?.id}」没有 MCP server 定义`);
	const missing = [];
	const base = {
		serverName,
		toolCallTimeoutMs: Number.isFinite(server.timeout) && server.timeout > 0 ? server.timeout : 60_000,
		// 连不上只让该会话看不到工具，别把会话的插件激活搞崩
		failOnStartupError: false,
		reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
	};
	if (server.transport === "stdio") {
		const env = {};
		for (const [k, v] of Object.entries(server.env ?? {})) env[k] = resolveVars(v, missing);
		return {
			config: { ...base, transport: "stdio", command: server.command, args: server.args ?? [], env, cwd: "" },
			missing,
		};
	}
	if (server.transport !== "streamable-http") {
		throw new Error(`传输方式 ${server.transport} 不被 DSH 支持（仅 stdio / streamable-http）`);
	}
	return { config: { ...base, transport: "streamable-http", url: resolveVars(server.url, missing) }, missing };
}

/* ─────────────────────────── 挂载 / 卸载 ─────────────────────────── */

async function mountOne(agent, row) {
	const mcpClient = await loadMcpClient();
	// 重复挂载先撤旧的，避免同 scope 内 serverName 撞车
	await unmountOne(agent, row.serverName);
	if (row.config === undefined) throw new Error(`缺少连接器「${row.connectorId}」的实时配置，无法挂载`);
	const fiber = agent.ctx.plugin(mcpClient, row.config);
	// mcp-client 的 apply 内部 await connection.ready：endpoint 不响应时会永远挂起，
	// 路由请求随之挂死（UI 表现为"点击没反应"）。这里限定等待，超时后 fiber 留在后台
	// 继续重连（reconnect 策略），但接入结果立刻返回，不让 UI 卡死。
	// 本地连接器可按条放宽（row.mountTimeoutMs）：首次 npx 拉包可能要几分钟。
	const timeoutMs = Number.isFinite(row.mountTimeoutMs) && row.mountTimeoutMs > 0 ? row.mountTimeoutMs : MOUNT_TIMEOUT_MS;
	await Promise.race([
		fiber,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`连接器「${row.connectorId}」挂载超过 ${Math.round(timeoutMs / 1000)}s 未完成（服务可能不可达），已转后台重试`)), timeoutMs).unref?.()),
	]);
	let bag = live.get(agent.id);
	if (bag === undefined) { bag = new Map(); live.set(agent.id, bag); }
	bag.set(row.serverName, fiber);
	return fiber;
}

async function unmountOne(agent, serverName) {
	const bag = live.get(agent.id);
	const fiber = bag?.get(serverName);
	if (fiber === undefined) return false;
	bag.delete(serverName);
	if (bag.size === 0) live.delete(agent.id);
	try {
		await fiber.dispose?.();
	} catch (error) {
		log(`卸载 ${serverName} 时出错（已从表内移除）`, error);
	}
	return true;
}

/**
 * 把连接器接入某个会话。
 * @param {{id: string, servers: object[]}} connector 来自在线目录
 * @param {object} agent 活体 agent（ctx.agents.get(sessionId)）
 */
export async function connectInSession(connector, agent) {
	ensureLoaded();
	const serverName = safeServerName(connector.id);
	const { config, missing } = buildMcpConfig(connector, serverName);
	const rows = intents.get(agent.id) ?? [];
	const row = {
		connectorId: connector.id,
		name: connector.name ?? connector.id,
		serverName,
		config,
		at: new Date().toISOString(),
		// 本地连接器的放宽挂载超时（仅意图行里的标量，不含凭据，可落盘）
		...(Number.isFinite(connector.mountTimeoutMs) && connector.mountTimeoutMs > 0
			? { mountTimeoutMs: connector.mountTimeoutMs }
			: {}),
	};
	const next = [...rows.filter((r) => r.serverName !== serverName), row];
	intents.set(agent.id, next);
	prune();
	try {
		await mountOne(agent, row);
	} catch (error) {
		intents.set(agent.id, rows);
		writeStore();
		throw error;
	}
	writeStore();
	return { serverName, connectorId: connector.id, sessionId: agent.id, missingEnv: missing, scoped: true };
}

/** 从会话移除。 */
export async function disconnectInSession(sessionId, serverName) {
	ensureLoaded();
	const rows = intents.get(sessionId) ?? [];
	const hit = rows.find((r) => r.serverName === serverName);
	if (hit === undefined) return { removed: false, sessionId, serverName };
	intents.set(sessionId, rows.filter((r) => r.serverName !== serverName));
	if (intents.get(sessionId).length === 0) intents.delete(sessionId);
	const agent = lookupAgent(sessionId);
	if (agent !== undefined) await unmountOne(agent, serverName);
	writeStore();
	return { removed: true, sessionId, serverName };
}

/** 注入 mcp-client 模块（仅测试用）。 */
export function bindMcpClient(mod) {
	mcpClientOverride = mod;
}

/** agent 服务由外部注入进来（避免本模块依赖 cordis ctx）。 */
let agentsService;
export function bindAgents(service) {
	agentsService = service;
}
function lookupAgent(sessionId) {
	return agentsService?.get?.(sessionId);
}

/** 会话存活期间重新挂载（用于 agent/created 恢复）。 */
export async function restoreForSession(agent, connectorsById) {
	reloadStore();
	const rows = intents.get(agent.id) ?? [];
	if (rows.length === 0) return { sessionId: agent.id, restored: [], failed: [] };
	const restored = [];
	const failed = [];
	for (const row of rows) {
		const connector = connectorsById.get(row.connectorId);
		if (connector !== undefined && row.name === undefined) row.name = connector.name ?? row.connectorId;
		if (connector === undefined) {
			failed.push({ connectorId: row.connectorId, why: "目录里已无此连接器（可能上游下架）" });
			continue;
		}
		try {
			const built = buildMcpConfig(connector, row.serverName);
			await mountOne(agent, { ...row, config: built.config });
			restored.push(row.serverName);
		} catch (error) {
			failed.push({ connectorId: row.connectorId, why: String(error?.message ?? error).slice(0, 140) });
		}
	}
	return { sessionId: agent.id, restored, failed };
}

/** agent/disposed：清掉引用（scope 已自动清理子 fiber，这里只防内存泄漏）。 */
export function forgetSession(sessionId) {
	live.delete(sessionId);
}

/** 某会话当前已接入（合并意图与活体状态；mountTimeoutMs 是标量非凭据，可回显）。 */
export function listForSession(sessionId) {
	ensureLoaded();
	const rows = intents.get(sessionId) ?? [];
	const bag = live.get(sessionId);
	return rows.map((r) => ({
		connectorId: r.connectorId,
		name: r.name ?? r.connectorId,
		serverName: r.serverName,
		at: r.at,
		...(Number.isFinite(r.mountTimeoutMs) && r.mountTimeoutMs > 0 ? { mountTimeoutMs: r.mountTimeoutMs } : {}),
		live: bag?.has(r.serverName) === true,
	}));
}

export function allSessions() {
	ensureLoaded();
	return Object.fromEntries([...intents].map(([k, v]) => [k, v.map((r) => ({ connectorId: r.connectorId, serverName: r.serverName, live: live.get(k)?.has(r.serverName) === true }))]));
}

/** 封顶：按最近使用时间丢弃，避免存储无限增长。 */
function prune() {
	if (intents.size <= MAX_SESSIONS) return;
	const sorted = [...intents].sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)));
	for (const [id] of sorted.slice(0, intents.size - MAX_SESSIONS)) {
		intents.delete(id);
		live.delete(id);
	}
}
