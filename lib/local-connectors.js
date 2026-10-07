/**
 * 本地连接器注册表 —— 任意本机 stdio MCP server 的「自建条目」。
 *
 * 与在线目录（connectors.js）同构，但来源是本机：用户在 UI 里填
 * command/args/env，或经 wb_local_connectors_add 工具注册。合并进
 * loadConnectors 的目录后，接入链路（connectInSession → agent.ctx.plugin、
 * restoreForSession）与在线连接器完全共用，不需要第二套挂载代码。
 *
 * 分级纪律：本地 stdio 条目**不做自动握手探测**（probeEndpoint 会真的执行
 * npx 拉包，有副作用且慢）—— classify() 天然把 stdio 判为 unverified，
 * 本模块只补充 source:"local" 供 UI 打「本地」徽标。
 *
 * 落盘约定：local-connectors.json 存**声明**（command/args/env 模板）。
 * env 值建议用 `${VAR}` 形式（接入时经 buildMcpConfig 从 process.env 求值，
 * 明文不落盘）；直接写明文等价于 ~/.claude.json 的 mcpServers 写法，是
 * 用户自己的选择，插件不做二次加密。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { STATE_ROOT } from "./state-root.js";

const STORE = join(STATE_ROOT, "local-connectors.json");

const log = (msg, err) =>
	console[err ? "warn" : "log"](`[dsh-workbuddy-summon] ${msg}${err ? `: ${err?.message ?? err}` : ""}`);

/* ─────────────────────────── 存储 ─────────────────────────── */

let cache = null; // { at, items, mtimeMs }

function readStore() {
	try {
		const mtimeMs = statSync(STORE).mtimeMs;
		if (cache !== null && cache.mtimeMs === mtimeMs) return cache;
		const parsed = JSON.parse(readFileSync(STORE, "utf8"));
		const items = Array.isArray(parsed?.items) ? parsed.items.filter((it) => it && typeof it.id === "string") : [];
		cache = { at: parsed?.at ?? 0, items, mtimeMs };
	} catch {
		cache = { at: 0, items: [], mtimeMs: 0 };
	}
	return cache;
}

function writeStore(items) {
	mkdirSync(STATE_ROOT, { recursive: true });
	writeFileSync(STORE, JSON.stringify({ at: Date.now(), items }, null, 1));
	cache = null; // 失效缓存，下次 readStore 按新 mtime 重建
}

/** id 生成：保留安全字符，其余转连字符；全空退到短 hash，保证非空且稳定。 */
function slugify(name) {
	const flat = String(name ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
	if (flat.length > 0) return flat;
	return "local-" + createHash("sha1").update(String(name ?? "")).digest("hex").slice(0, 6);
}

/** 在线目录条目的同构形状（source:"local" 是 UI 区分来源的唯一依据）。 */
function toConnector(entry) {
	return {
		id: entry.id,
		name: entry.name,
		nameEn: "",
		description: entry.description || `本地连接器：${entry.command}`,
		authMode: null,
		type: "local",
		transportKind: "stdio",
		servers: [{
			name: null,
			transport: "stdio",
			url: null,
			command: entry.command,
			args: Array.isArray(entry.args) ? entry.args : [],
			env: entry.env && typeof entry.env === "object" ? entry.env : {},
			timeout: Number.isFinite(entry.timeoutMs) && entry.timeoutMs > 0 ? entry.timeoutMs : null,
		}],
		hasCliJson: false,
		hasSkills: false,
		preAuth: null,
		examples: [],
		tags: ["local"],
		categories: [],
		version: null,
		minWorkbuddyVersion: null,
		source: "local",
		mountTimeoutMs: Number.isFinite(entry.mountTimeoutMs) && entry.mountTimeoutMs > 0 ? entry.mountTimeoutMs : null,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
	};
}

/* ─────────────────────────── CRUD ─────────────────────────── */

/** 本地条目列表（connector 形状，可直接并入目录）。 */
export function listLocal() {
	return readStore().items.map(toConnector);
}

export function localCount() {
	return readStore().items.length;
}

/**
 * 新增本地连接器。
 * @param {{name?:string, id?:string, command:string, args?:string[]|string, env?:object, description?:string, timeoutMs?:number, mountTimeoutMs?:number}} input
 * @returns {{ok:true, entry:object} | {ok:false, error:string}}
 */
export function addLocal(input) {
	const command = String(input?.command ?? "").trim();
	if (command.length === 0) return { ok: false, error: "缺少 command（例如 npx / node / uvx 的可执行命令）" };
	const name = String(input?.name ?? "").trim() || command;
	const store = readStore();
	let id = String(input?.id ?? "").trim() || slugify(name);
	if (store.items.some((it) => it.id === id)) {
		if (input?.id) return { ok: false, error: `本地已存在 id「${id}」，换一个或先删除` };
		id = `${id}-${createHash("sha1").update(command + JSON.stringify(input?.args ?? [])).digest("hex").slice(0, 4)}`;
		if (store.items.some((it) => it.id === id)) return { ok: false, error: `id「${id}」也撞了，请显式指定 id` };
	}
	const args = Array.isArray(input?.args)
		? input.args.map(String)
		: typeof input?.args === "string" && input.args.trim().length > 0
			? input.args.trim().split(/\s+/)
			: [];
	const env = input?.env && typeof input.env === "object" && !Array.isArray(input.env)
		? Object.fromEntries(Object.entries(input.env).map(([k, v]) => [String(k), String(v)]))
		: {};
	const now = new Date().toISOString();
	const entry = {
		id, name, command, args, env,
		description: String(input?.description ?? "").trim(),
		timeoutMs: Number.isFinite(input?.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : undefined,
		// 首次 npx 可能要拉包（如 100MB 级文档包），默认放宽到 180s 再转后台重连
		mountTimeoutMs: Number.isFinite(input?.mountTimeoutMs) && input.mountTimeoutMs > 0 ? input.mountTimeoutMs : 180_000,
		createdAt: now,
		updatedAt: now,
	};
	writeStore([...store.items, entry]);
	return { ok: true, entry: toConnector(entry) };
}

/** 删除本地连接器。返回是否真的删了。 */
export function removeLocal(id) {
	const store = readStore();
	const next = store.items.filter((it) => it.id !== id);
	if (next.length === store.items.length) return false;
	writeStore(next);
	return true;
}

/**
 * 编辑本地连接器（id 不可改；未提供的字段保留原值）。
 * 注意：接入中的会话挂的是旧配置，编辑后需重新接入才生效。
 * @returns {{ok:true, entry:object} | {ok:false, error:string}}
 */
export function updateLocal(id, patch = {}) {
	const store = readStore();
	const idx = store.items.findIndex((it) => it.id === id);
	if (idx === -1) return { ok: false, error: `本地没有 id「${id}」的连接器` };
	const cur = store.items[idx];
	const command = patch.command !== undefined ? String(patch.command).trim() : cur.command;
	if (command.length === 0) return { ok: false, error: "command 不能为空" };
	const args = Array.isArray(patch.args)
		? patch.args.map(String)
		: typeof patch.args === "string"
			? (patch.args.trim().length > 0 ? patch.args.trim().split(/\s+/) : [])
			: cur.args;
	const env = patch.env !== undefined
		? (patch.env && typeof patch.env === "object" && !Array.isArray(patch.env)
			? Object.fromEntries(Object.entries(patch.env).map(([k, v]) => [String(k), String(v)]))
			: {})
		: cur.env;
	const next = {
		...cur,
		name: patch.name !== undefined ? (String(patch.name).trim() || command) : cur.name,
		command,
		args,
		env,
		description: patch.description !== undefined ? String(patch.description ?? "").trim() : cur.description,
		mountTimeoutMs: Number.isFinite(patch.mountTimeoutMs) && patch.mountTimeoutMs > 0 ? patch.mountTimeoutMs : cur.mountTimeoutMs,
		updatedAt: new Date().toISOString(),
	};
	const items = [...store.items];
	items[idx] = next;
	writeStore(items);
	return { ok: true, entry: toConnector(next) };
}

/* ─────────────────────────── 目录合并 ─────────────────────────── */

/**
 * 把本地条目并入在线目录快照。本地优先：同 id 时覆盖在线条目
 * （用户显式配置应赢过上游）；addLocal 已尽量避撞，这里是兜底语义。
 * 返回浅拷贝，不改动缓存对象。
 */
export function withLocal(built) {
	const locals = listLocal();
	if (locals.length === 0) return built;
	const localIds = new Set(locals.map((c) => c.id));
	const connectors = [...built.connectors.filter((c) => !localIds.has(c.id)), ...locals];
	return {
		...built,
		connectors,
		byId: new Map(connectors.map((c) => [c.id, c])),
		localCount: locals.length,
	};
}
