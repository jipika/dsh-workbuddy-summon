/**
 * 头像层：实时代理腾讯云 COS 的服务端图片处理。
 *
 * 为什么代理而不是预生成缩略图：预生成 = 把图下载到本地，WorkBuddy 一加新专家或换头像
 * 就看不到，违背「跟着他的数据动」。实测 COS 开了数据万象：
 *   GET <原图URL>?imageMogr2/thumbnail/64x
 *   → 313KB/512px 原图实时变 8.2KB/64px，alpha 通道保留，包内路径与 .jpg 同样有效，
 *     非图片文件返回 400（不会被误当图片），缺失文件返回 404（不会伪造 200）。
 * 所以本模块不存任何图片资产，每次按需向 COS 取，浏览器再用 HTTP 缓存兜住重复请求。
 *
 * 为什么不放行渲染进程直连 COS：① 会把「插件在替谁拉数据」暴露在浏览器网络面板；
 * ② Electron CSP 的 img-src 白名单不含该域；③ 走宿主同源路由免 token 且可控缓存语义。
 *
 * 安全边界：ref 一律由服务端从目录条目里查出来（entry.avatar / members[].avatar），
 * **不接受调用方传入路径**；仍额外挡一次 ".." 与非图片扩展名。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { COS_BASE, localRootOf } from "./catalog.js";

export const AVATAR_SIZES = [32, 48, 64, 96, 128, 256];
export const AVATAR_DEFAULT_SIZE = 64;

/**
 * 本机包原图上限。node 侧无法重采样 PNG，只能原图直出。
 * 实测这类条目只有个位数（用户自己下载/自建的包，如 ai-tell-hunter 149KB、
 * novel-workshop-pro 2KB），且 UI 用 loading=lazy，一屏最多撞到几条 ——
 * 所以这里只是「防异常大图」的保护阈值，不是省流量的手段。
 */
const LOCAL_MAX_BYTES = 2 * 1024 * 1024;

/** 进程内 LRU：面板一次要渲染几十张，避免同一张在同一屏里被反复回源。 */
const MEM_CAP_BYTES = 6 * 1024 * 1024;
const mem = new Map(); // key → { bytes, mime, at }
let memBytes = 0;

const log = (msg, err) =>
	console[err ? "warn" : "log"](`[dsh-workbuddy-summon] ${msg}${err ? `: ${errorText(err)}` : ""}`);
function errorText(e) {
	try {
		return String(e?.message ?? e);
	} catch {
		return "unknown";
	}
}

function clampSize(size) {
	const n = Number(size);
	if (!Number.isFinite(n)) return AVATAR_DEFAULT_SIZE;
	return AVATAR_SIZES.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), AVATAR_DEFAULT_SIZE);
}

/** 把 avatar 字段归一化；非法输入返回 undefined。前导 "/" 表示云端资源，否则是本机包相对路径。 */
function normalizeRef(raw) {
	if (typeof raw !== "string") return undefined;
	const rel = raw.trim().replace(/^\/+/, "");
	if (rel.length === 0 || rel.includes("..") || !/\.(png|jpe?g|webp)$/i.test(rel)) return undefined;
	return { rel, remote: raw.trim().startsWith("/") };
}

function mimeOf(rel) {
	return /\.jpe?g$/i.test(rel) ? "image/jpeg" : /\.webp$/i.test(rel) ? "image/webp" : "image/png";
}

function memPut(key, entry) {
	mem.set(key, entry);
	memBytes += entry.bytes.length;
	while (memBytes > MEM_CAP_BYTES && mem.size > 0) {
		const oldest = mem.keys().next().value;
		const gone = mem.get(oldest);
		mem.delete(oldest);
		memBytes -= gone?.bytes.length ?? 0;
	}
}

/** 同 key 并发合并（一屏 60 张里可能有多条指向同一张图）。 */
const inFlight = new Map();

/**
 * 取某个条目（或某成员）的头像。
 * @param {{avatar?: string|null, members?: {id:string, avatar?:string}[]}} entry
 * @param {number} size
 * @param {{agent?: string, plugin?: string}} [opts] plugin 用于定位本机包目录
 */
export async function getAvatar(entry, size, opts = {}) {
	if (entry === undefined || entry === null) return fail("no-entry", 404);
	const want = clampSize(size);

	let raw = entry.avatar;
	if (typeof opts.agent === "string" && opts.agent.length > 0) {
		const member = (entry.members ?? []).find((m) => m?.id === opts.agent);
		raw = member?.avatar ?? raw;
	}
	const ref = normalizeRef(raw);
	if (ref === undefined) return fail("no-avatar", 404);

	const key = `${ref.remote ? "r" : "l"}:${ref.rel}:${want}`;
	const hit = mem.get(key);
	if (hit !== undefined) {
		// 命中即刷新 LRU 位置
		mem.delete(key);
		memPut(key, hit);
		return { data: hit.bytes, mime: hit.mime, status: 200, note: "mem" };
	}
	const pending = inFlight.get(key);
	if (pending !== undefined) return pending;

	const task = (async () => {
		try {
			if (ref.remote) {
				// 云端：让 COS 服务端出缩略图
				const url = `${COS_BASE}/${ref.rel}?imageMogr2/thumbnail/${want}x`;
				const res = await fetch(url, { headers: { Accept: "image/*" } });
				if (res.status === 404) return fail("missing", 404);
				if (!res.ok) return fail(`upstream-${res.status}`, 502);
				const bytes = new Uint8Array(await res.arrayBuffer());
				if (bytes.length < 64) return fail("empty", 502);
				const out = { bytes, mime: mimeOf(ref.rel) };
				memPut(key, out);
				return { data: out.bytes, mime: out.mime, status: 200, note: "cos" };
			}
			// 本机包相对路径（用户自己下载/自建的包）：读它自己的目录，不联网。
			// 这条路径没有 COS 服务端缩放，纯 node 也做不了 PNG 重采样，所以原图超过
			// 阈值就不返回、让 UI 回退首字圆形 —— 为一张 335KB 的占位图拖慢面板不值得。
			const localRoot = localRootOf(opts.plugin);
			if (localRoot === undefined) return fail("missing", 404);
			let bytes;
			try {
				bytes = new Uint8Array(readFileSync(join(localRoot, ref.rel)));
			} catch {
				return fail("missing-local", 404);
			}
			if (bytes.length > LOCAL_MAX_BYTES) return fail("local-too-large", 404);
			const out = { bytes, mime: mimeOf(ref.rel) };
			memPut(key, out);
			return { data: out.bytes, mime: out.mime, status: 200, note: "local" };
		} catch (error) {
			log("头像取回失败", error);
			return fail("error", 502);
		} finally {
			inFlight.delete(key);
		}
	})();
	inFlight.set(key, task);
	return task;
}

/** note 决定语义：资源不存在一律 404（UI 直接回退首字），上游故障才 502。 */
function fail(note, status = 404) {
	return { data: new Uint8Array(), mime: "image/png", status, note };
}

/** 给 UI 用的头像 URL（宿主路由，同源）。 */
export function avatarUrl(plugin, size = AVATAR_DEFAULT_SIZE) {
	return `/dsh-workbuddy-summon/avatar?plugin=${encodeURIComponent(plugin)}&size=${clampSize(size)}`;
}
