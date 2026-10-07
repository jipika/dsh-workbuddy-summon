/**
 * 连接器在线目录（WorkBuddy 官方源，实时）。
 *
 * 为什么必须在线：本机快照只有 213 条，而上游 `connectors-config.zip` 已经是
 * **317 条**（新增 107、下架 3）。按本机快照做，一上手就少 1/3。
 *
 * 刷新策略：源支持 ETag/If-None-Match（实测 304），所以平时只花一个 HEAD 请求；
 * 只有真变了才下载 26MB。zip 整体缓存到本地，解析结果另存一份 JSON 供离线兜底。
 *
 * 可接入性**不靠清单里的 auth_mode 标签**——实测证明标签不可信：
 *   kdocs 标 server-side，但 initialize 握手 200 直接可用；
 *   westock-mcp 标空，却要 WorkBuddy 代持的 Bearer。
 * 所以分级来自真实握手结果（见 probeEndpoints），标签只作为提示。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { withLocal } from "./local-connectors.js";
import { STATE_ROOT } from "./state-root.js";

export { STATE_ROOT }; // 真身在 state-root.js；re-export 保持既有导入方兼容

export const CONNECTOR_ZIP_URL =
	"https://static.workbuddy.cn/connectors-config-v2/connectors-config.zip";
const CACHE_DIR = join(STATE_ROOT, "connector-cache");
const SNAPSHOT = join(CACHE_DIR, "snapshot.json");
const TTL_MS = 6 * 60 * 60 * 1000;

const log = (msg, err) =>
	console[err ? "warn" : "log"](`[dsh-workbuddy-summon] ${msg}${err ? `: ${err?.message ?? err}` : ""}`);

/** 从 zip 里读一个文件（不引第三方依赖：手写 store/deflate 解包）。 */
async function readZipEntry(buf, wanted) {
	const { inflateRawSync } = await import("node:zlib");
	// 找 End of Central Directory
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i -= 1) {
		if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	}
	if (eocd < 0) throw new Error("zip: 找不到中央目录结尾");
	const count = buf.readUInt16LE(eocd + 10);
	let off = buf.readUInt32LE(eocd + 16);
	for (let n = 0; n < count; n += 1) {
		if (buf.readUInt32LE(off) !== 0x02014b50) break;
		const method = buf.readUInt16LE(off + 10);
		const compSize = buf.readUInt32LE(off + 20);
		const nameLen = buf.readUInt16LE(off + 28);
		const extraLen = buf.readUInt16LE(off + 30);
		const commentLen = buf.readUInt16LE(off + 32);
		const localOff = buf.readUInt32LE(off + 42);
		const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
		off += 46 + nameLen + extraLen + commentLen;
		if (name !== wanted) continue;
		// 跳本地头，取数据
		const lName = buf.readUInt16LE(localOff + 26);
		const lExtra = buf.readUInt16LE(localOff + 28);
		const start = localOff + 30 + lName + lExtra;
		const data = buf.subarray(start, start + compSize);
		if (method === 0) return data;
		if (method === 8) return inflateRawSync(data);
		throw new Error(`zip: 不支持的压缩方法 ${method}`);
	}
	return undefined;
}

function listZipNames(buf) {
	const names = [];
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i -= 1) {
		if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	}
	if (eocd < 0) return names;
	const count = buf.readUInt16LE(eocd + 10);
	let off = buf.readUInt32LE(eocd + 16);
	for (let n = 0; n < count; n += 1) {
		if (buf.readUInt32LE(off) !== 0x02014b50) break;
		const nameLen = buf.readUInt16LE(off + 28);
		const extraLen = buf.readUInt16LE(off + 30);
		const commentLen = buf.readUInt16LE(off + 32);
		names.push(buf.subarray(off + 46, off + 46 + nameLen).toString("utf8"));
		off += 46 + nameLen + extraLen + commentLen;
	}
	return names;
}

let cached = null; // { at, connectors, byId, etag, source }

/** 归一化单个连接器的 MCP 定义。 */
function shapeOf(servers) {
	const list = Object.values(servers ?? {});
	if (list.length === 0) return { kind: "none", servers: [] };
	const out = list.map((s) => ({
		name: s?.serverName ?? null,
		transport: s?.url ? "streamable-http" : s?.command ? "stdio" : "unknown",
		url: s?.url ?? null,
		command: s?.command ?? null,
		args: Array.isArray(s?.args) ? s.args : [],
		env: s?.env && typeof s.env === "object" ? s.env : {},
		timeout: Number.isFinite(s?.timeout) ? s.timeout : null,
		// WorkBuddy 专有字段，接入 DSH 时必须丢弃
		ignored: Object.keys(s ?? {}).filter((k) =>
			["runtime", "staticEnv", "type", "defer_loading", "npmRegistry"].includes(k)),
	}));
	return { kind: out.every((s) => s.transport === "streamable-http") ? "remote" : out.every((s) => s.transport === "stdio") ? "stdio" : "mixed", servers: out };
}

/**
 * 拉取（或复用缓存）在线连接器目录，并并入本地连接器注册表（withLocal）。
 * 本地条目 source:"local"，接入/恢复链路与在线条目完全共用。
 * @param {{fresh?: boolean, timeoutMs?: number}} [opts]
 */
export async function loadConnectors(opts = {}) {
	return withLocal(await loadConnectorsBase(opts));
}

async function loadConnectorsBase(opts = {}) {
	const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 60_000;
	if (cached !== null && opts.fresh !== true && Date.now() - cached.at < TTL_MS) return cached;

	mkdirSync(CACHE_DIR, { recursive: true });
	let etag;
	let zipBuf;
	try {
		const headers = { Accept: "*/*" };
		if (cached?.etag) headers["If-None-Match"] = cached.etag;
		const res = await fetch(CONNECTOR_ZIP_URL, { headers, signal: AbortSignal.timeout(timeoutMs) });
		if (res.status === 304 && cached !== null) {
			cached.at = Date.now();
			return cached;
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		etag = res.headers.get("etag") ?? undefined;
		zipBuf = Buffer.from(await res.arrayBuffer());
	} catch (error) {
		log("在线连接器清单拉取失败，改用本地缓存", error);
	}

	if (zipBuf !== undefined) {
		try {
			const indexRaw = await readZipEntry(zipBuf, ".codebuddy-connector/connectors.json");
			if (indexRaw === undefined) throw new Error("zip 内缺 .codebuddy-connector/connectors.json");
			const index = JSON.parse(Buffer.from(indexRaw).toString("utf8"));
			const names = new Set(listZipNames(zipBuf));
			const connectors = [];
			for (const item of index.connectors ?? []) {
				const defRaw = names.has(`connectors/${item.id}/mcp.json`)
					? await readZipEntry(zipBuf, `connectors/${item.id}/mcp.json`) : undefined;
				const def = defRaw === undefined ? undefined : JSON.parse(Buffer.from(defRaw).toString("utf8"));
				const hasCli = names.has(`connectors/${item.id}/cli.json`);
				const shape = shapeOf(def?.mcpServers);
				connectors.push({
					id: item.id,
					name: zh(item.name_zh ?? item.name ?? item.displayName),
					nameEn: zh(item.name_en ?? item.nameEn),
					description: zh(item.description_zh ?? item.description),
					authMode: item.auth_mode ?? null,
					type: item.type ?? null,
					transportKind: hasCli && shape.kind === "none" ? "cli" : shape.kind,
					servers: shape.servers,
					hasCliJson: hasCli,
					hasSkills: names.has(`connectors/${item.id}/skills/`) ||
						[...names].some((n) => n.startsWith(`connectors/${item.id}/skills/`)),
					preAuth: def?.preAuth ?? null,
					examples: (item.examples_zh ?? item.examples ?? []).slice(0, 3),
					tags: item.tags ?? [],
					categories: item.visible_in ?? [],
					version: item.version ?? null,
					minWorkbuddyVersion: item.minWorkbuddyVersion ?? null,
				});
			}
			const built = {
				at: Date.now(),
				etag,
				source: "online",
				connectors,
				byId: new Map(connectors.map((c) => [c.id, c])),
				authInjectionRules: index.auth_injection_rules ?? [],
				sha256: createHash("sha256").update(zipBuf).digest("hex"),
			};
			cached = built;
			// 落一份精简快照供离线兜底（不含 zip，26MB 没必要留盘）
			writeFileSync(SNAPSHOT, JSON.stringify({ at: built.at, etag, connectors, authInjectionRules: built.authInjectionRules }));
			return built;
		} catch (error) {
			log("在线包解析失败，改用本地快照", error);
		}
	}

	// 离线兜底
	if (cached !== null) return cached;
	try {
		const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
		cached = {
			at: snap.at ?? 0, etag: snap.etag, source: "snapshot",
			connectors: snap.connectors, byId: new Map(snap.connectors.map((c) => [c.id, c])),
			authInjectionRules: snap.authInjectionRules ?? [],
		};
		return cached;
	} catch {
		cached = { at: 0, etag: undefined, source: "none", connectors: [], byId: new Map(), authInjectionRules: [] };
		return cached;
	}
}

function zh(v) {
	if (v && typeof v === "object") return v.zh ?? v.en ?? "";
	return v ?? "";
}

/** 列表视图（给 UI / 工具，不含 servers 细节，避免响应肥大）。 */
export function connectorView(c) {
	return {
		id: c.id,
		name: c.name,
		description: oneLine(c.description, 130),
		authMode: c.authMode,
		type: c.type,
		transportKind: c.transportKind,
		serverCount: c.servers.length,
		url: c.servers[0]?.url ?? null,
		command: c.servers[0]?.command ?? null,
		needsCli: c.hasCliJson,
		preAuth: c.preAuth,
		examples: c.examples,
		tags: (c.tags ?? []).map(zh).slice(0, 4),
	};
}

function oneLine(text, max) {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export { oneLine, zh };
