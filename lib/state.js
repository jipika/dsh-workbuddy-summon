/**
 * 召唤状态：每个会话一个「当前召唤」的专家/专家团。
 *
 * 落盘在插件自持文件（~/.dsh/workbuddy-summon/summons.json），与宿主版本无关，
 * 改完立即生效 —— 与 dsh-switch-armor 的会话级开关同款做法。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "./catalog.js";

const STORE = join(STATE_ROOT, "summons.json");

/** @type {Map<string, {plugin: string, kind: string, entryId?: string, at: string}>} */
const summons = new Map();
let loaded = false;
/** 订阅者：状态变化时通知（用于 UI 轮询之外的即时刷新）。 */
const listeners = new Set();

const isScalar = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** 规范化一条召唤记录：固定字段 + 透传其它标量元数据（chars / pkgAgents / truncated…）。 */
function normalize(record) {
	const next = {
		plugin: record.plugin,
		kind: record.kind === "team" ? "team" : "expert",
	};
	if (typeof record.entryId === "string") next.entryId = record.entryId;
	for (const [k, v] of Object.entries(record)) {
		if (k in next || k === "at") continue;
		if (isScalar(v)) next[k] = v;
	}
	next.at = new Date().toISOString();
	return next;
}

function readStore() {
	try {
		const parsed = JSON.parse(readFileSync(STORE, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out = {};
		for (const [sessionId, value] of Object.entries(parsed)) {
			if (typeof sessionId !== "string" || sessionId.length === 0) continue;
			if (value === null || typeof value !== "object") continue;
			if (typeof value.plugin !== "string" || value.plugin.length === 0) continue;
			const next = normalize(value);
			// 保留原时间戳，别让每次读盘都把「最后召唤时间」推后
			if (typeof value.at === "string") next.at = value.at;
			out[sessionId] = next;
		}
		return out;
	} catch {
		return {};
	}
}

function ensureLoaded() {
	if (loaded) return;
	loaded = true;
	for (const [k, v] of Object.entries(readStore())) summons.set(k, v);
}

function persist() {
	try {
		mkdirSync(STATE_ROOT, { recursive: true });
		writeFileSync(STORE, JSON.stringify(Object.fromEntries(summons), null, 1));
		return true;
	} catch (error) {
		console.warn(`[dsh-workbuddy-summon] 状态落盘失败：${error?.message ?? error}`);
		return false;
	}
}

function emit(event) {
	for (const fn of listeners) {
		try {
			fn(event);
		} catch {
			/* 订阅者异常不影响状态本身 */
		}
	}
}

/** 从 assemble context / agent 里取会话 id（与 infinite-gen-4 同一套兜底顺序）。 */
export function sessionIdOf(context) {
	try {
		const agent = context?.agent ?? context;
		const id = agent?.sessionId ?? agent?.session?.header?.id ?? agent?.id;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

/** @returns {{plugin: string, kind: string, at: string} | undefined} */
export function getSummon(sessionId) {
	ensureLoaded();
	if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
	return summons.get(sessionId);
}

export function setSummon(sessionId, record) {
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw new Error("summon: 缺少 sessionId（请从具体会话里召唤）");
	}
	if (typeof record?.plugin !== "string" || record.plugin.length === 0) {
		throw new Error("summon: 缺少 plugin 名");
	}
	ensureLoaded();
	const prev = summons.get(sessionId);
	const next = normalize(record);
	summons.set(sessionId, next);
	persist();
	emit({ type: "summoned", sessionId, from: prev, to: next });
	return next;
}

export function clearSummon(sessionId) {
	ensureLoaded();
	const prev = summons.get(sessionId);
	if (prev === undefined) return false;
	summons.delete(sessionId);
	persist();
	emit({ type: "unsummoned", sessionId, from: prev });
	return true;
}

/** 全量快照（给 UI 与工具用）。 */
export function listSummons() {
	ensureLoaded();
	return Object.fromEntries(summons);
}

export function onSummonChange(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** 清理已经不存在的会话条目（避免文件无限增长）；只保留 liveIds 集合里的。 */
export function pruneSummons(liveIds) {
	ensureLoaded();
	if (!(liveIds instanceof Set)) return 0;
	let removed = 0;
	for (const id of [...summons.keys()]) {
		if (!liveIds.has(id)) {
			summons.delete(id);
			removed += 1;
		}
	}
	if (removed > 0) persist();
	return removed;
}
