/**
 * WorkBuddy 专家市场目录（在线优先，本地兜底）。
 *
 * 三个数据源，按可用性自动降级，任一环节失败都不会让插件失效：
 *   1) 腾讯云 COS 公开静态清单（无需登录）—— 唯一能「跟着他的数据动」的通道
 *   2) 本插件的缓存目录（~/.dsh/workbuddy-summon/cache）—— 断网时继续可用
 *   3) 本机 WorkBuddy 镜像（wb-resources/expert-market）—— 离线兜底
 *
 * 去重口径：按 (plugin, id) 主键去重，三份清单叠加；同一 plugin 被多个条目引用时
 * 保留首个（清单顺序即展示顺序），并记录 aliases 供排查。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

export const COS_BASE =
	"https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace";
/** 三份同构清单，客户端本身就是叠加使用（公共 + 内部作用域 + 外部作用域）。 */
export const MANIFESTS = ["expert_center.json", "internalExpert.json", "externalExpert.json"];
/** 本机镜像根（若存在则作为离线兜底源）。 */
export const MIRROR_ROOT = join(
	homedir(),
	"Documents/deepseek/wb-resources/expert-market",
);
export const STATE_ROOT = join(homedir(), ".dsh/workbuddy-summon");
export const CACHE_ROOT = join(STATE_ROOT, "cache");

const log = (msg, err) =>
	console[err ? "warn" : "log"](`[dsh-workbuddy-summon] ${msg}${err ? `: ${err?.message ?? err}` : ""}`);

function local(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function writeIfChanged(path, text) {
	if (local(path) === text) return false;
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
	return true;
}

async function httpText(url, timeoutMs) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "*/*" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.text();
	} finally {
		clearTimeout(timer);
	}
}

/* ────────────────────────────── 清单 ────────────────────────────── */

function readManifest(name) {
	const cached = join(CACHE_ROOT, "manifests", name);
	const mirrored = join(MIRROR_ROOT, "expert-market", name);
	return { cachedText: local(cached), cachedAt: cached, mirrorText: local(mirrored) };
}

/**
 * 拉取（或复用缓存）三份清单并合并去重。
 * @param {{fresh?: boolean, timeoutMs?: number}} opts fresh=强制联网
 * @returns {{entries: object[], sources: object[], degraded: boolean}}
 */
export async function loadCatalog(opts = {}) {
	const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 12_000;
	const sources = [];
	const merged = [];
	const catNames = new Map(); // 清单顶层 categories 才是权威中文名
	let degraded = false;

	for (const name of MANIFESTS) {
		const { cachedText, cachedAt, mirrorText } = readManifest(name);
		let text;
		let origin;
		if (opts.fresh !== false) {
			try {
				text = await httpText(`${COS_BASE}/${name}`, timeoutMs);
				origin = "cos";
				writeIfChanged(cachedAt, text);
			} catch (error) {
				log(`${name} 在线拉取失败，改用本地副本`, error);
			}
		}
		if (text === undefined) {
			// 联网失败：缓存 → 镜像
			if (cachedText) {
				text = cachedText;
				origin = "cache";
			} else if (mirrorText) {
				text = mirrorText;
				origin = "mirror";
			}
			degraded = true;
		}
		if (text === undefined) {
			sources.push({ name, origin: "unavailable", count: 0 });
			continue;
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			log(`${name} 解析失败（来自 ${origin}）`, error);
			sources.push({ name, origin: "bad-json", count: 0 });
			continue;
		}
		const list = Array.isArray(parsed?.experts) ? parsed.experts : [];
		for (const c of parsed?.categories ?? []) {
			if (typeof c?.id === "string" && !catNames.has(c.id)) catNames.set(c.id, zh(c.name) || c.id);
		}
		sources.push({
			name,
			origin,
			count: list.length,
			version: parsed?.version,
			lastUpdated: parsed?.lastUpdated,
		});
		for (const e of list) {
			const known = e.categoryId !== undefined ? catNames.get(e.categoryId) : undefined;
			merged.push({
				...e,
				_manifest: name,
				...(e.categoryName === undefined && known !== undefined ? { categoryName: known } : {}),
			});
		}
	}

	// 第四个源：本机已下载的专家包（社区包/自建包不在云端公开清单里，如 novel-workshop-pro）
	let locals = [];
	if (opts.includeLocal !== false) {
		try {
				locals = scanLocalMarketplaces();
		} catch (error) {
			log("本机市场扫描失败（忽略，不影响云端目录）", error);
		}
	}
	for (const e of locals) {
		const known = e.categoryId !== undefined ? catNames.get(e.categoryId) : undefined;
		merged.push({ ...e, ...(e.categoryName === undefined && known !== undefined ? { categoryName: known } : {}) });
	}

	const { entries, categories } = dedupe(merged);
	if (locals.length > 0) {
		sources.push({ name: "localMarketplace", origin: "local", count: locals.length });
	}
	return { entries, categories, sources, degraded, fetchedAt: new Date().toISOString() };
}

/** 按 (plugin,id) 去重；plugin 缺失时退回 id。 */
export function dedupe(list) {
	const seen = new Map();
	const categories = new Map();
	for (const e of list) {
		const key = `${e.plugin ?? ""}::${e.id ?? ""}`;
		const prev = seen.get(key);
		if (prev !== undefined) {
			if (prev._manifest !== e._manifest) {
				(prev._aliases ??= []).push({ manifest: e._manifest, id: e.id });
			}
			continue;
		}
		seen.set(key, e);
		if (e.categoryId && !categories.has(e.categoryId)) {
			categories.set(e.categoryId, { id: e.categoryId, name: e.categoryName ?? null });
		}
	}
	return { entries: [...seen.values()], categories: [...categories.values()] };
}

/**
 * 本机包目录注册表：plugin → 该包在 ~/.workbuddy 下的真实目录。
 * localMarketplaceEntries() 扫描时填充，loadPackage() 自动查用 —— 这样调用方
 * 不必层层透传 localRoot。
 */
const LOCAL_ROOTS = new Map();

let localScanCache = null; // { at, entries }
const LOCAL_SCAN_TTL_MS = 60_000;

/** 扫描（或复用 60 秒内的结果）本机市场，填充 LOCAL_ROOTS。 */
function scanLocalMarketplaces() {
	if (localScanCache !== null && Date.now() - localScanCache.at < LOCAL_SCAN_TTL_MS) {
		return localScanCache.entries;
	}
	const out = collectLocalMarketplaceEntries();
	localScanCache = { at: Date.now(), entries: out };
	return out;
}

function ensureLocalScanned() {
	scanLocalMarketplaces();
}

/**
 * 第四个数据源：本机 WorkBuddy 已下载的专家包（含用户自建与社区包）。
 *
 * 这些不在云端公开清单里 —— 例如 `novel-workshop-pro`（截图中的「中文网络小说创作顾问／
 * 网文主编」）走登录态开放平台分发，本机有包但云端清单没有。只收带 `expertType`
 * 的目录；市场里另外 500 多个是 CodeBuddy IDE 插件，不是专家，跳过。
 */
function collectLocalMarketplaceEntries() {
	const base = join(homedir(), ".workbuddy/plugins/marketplaces");
	const out = [];
	let markets;
	try {
		markets = readdirSync(base);
	} catch {
		return out;
	}
	for (const market of markets) {
		const pluginsDir = join(base, market, "plugins");
		let dirs;
		try {
			dirs = readdirSync(pluginsDir);
		} catch {
			continue;
		}
		for (const dir of dirs) {
			const root = join(pluginsDir, dir);
			const manifestText =
				local(join(root, ".codebuddy-plugin/plugin.json")) ??
				local(join(root, ".workbuddy-plugin/plugin.json"));
			if (manifestText === undefined) continue;
			const d = parseJsonSafe(manifestText);
			if (d === undefined || (d.expertType !== "agent" && d.expertType !== "team")) continue;
			out.push({
				id: d.agentName ?? d.name ?? dir,
				plugin: d.name ?? dir,
				expertType: d.expertType,
				agentName: d.agentName ?? dir,
				displayName: d.displayName ?? { zh: d.name ?? dir },
				profession: d.profession ?? d.displayName ?? { zh: d.name ?? dir },
				description: d.displayDescription ?? d.description ?? { zh: "" },
				categoryId: d.categoryId,
				tags: d.tags ?? [],
				quickPrompts: d.quickPrompts ?? [],
				defaultInitPrompt: d.defaultInitPrompt ?? { zh: "" },
				members: d.members ?? [],
				teamInfo: d.teamInfo,
				agents: d.agents ?? [],
				skills: d.skills ?? [],
				avatar: d.avatar,
				_manifest: `local:${market}`,
				_localRoot: root,
			});
			LOCAL_ROOTS.set(d.name ?? dir, root);
		}
	}
	return out;
}

/* ────────────────────────────── 包体 ────────────────────────────── */

const PKG_CACHE = join(CACHE_ROOT, "packages");

function pkgCacheFile(plugin, rel) {
	return join(PKG_CACHE, plugin, rel);
}
function pkgMirrorFile(plugin, rel) {
	return join(MIRROR_ROOT, "expert-market/remote", plugin, rel);
}

/**
 * 2026-06 之后进市场的包**不再出现在公开 COS 的 `plugins/<p>/` 下**（那里只有 2026-05 及以前的老包）。
 * 这类包的正文只能从官方另留的**无签名回退源**取：
 *   `<COS_BASE>/bundles/<plugin>.tar.gz` —— 整套 429 个包实测 100% 命中（老包同样在）。
 * 来源：官方 `ExpertPluginService.downloadAndExtract()` 的 `buildExpertUrl('/bundles/<name>.tar.gz')` 分支
 * （运营平台签名 URL 缺失时走它）。tar 内是包根目录，含 `.codebuddy-plugin/plugin.json`。
 *
 * 取回后整包解开写入 PKG_CACHE，此后 `pkgFile` 直接命中缓存，不再重复下载。
 * 用 `.bundle-fetched` 标记做幂等；失败不写标记，下次自动重试。
 */
async function fetchBundle(plugin, opts = {}) {
	const mark = join(PKG_CACHE, plugin, ".bundle-fetched");
	if (local(mark) !== undefined) return true;
	const url = `${COS_BASE}/bundles/${plugin}.tar.gz`;
	let buf;
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
		try {
			const res = await fetch(url, { signal: ctrl.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			buf = Buffer.from(await res.arrayBuffer());
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		log(`${plugin} bundle 拉取失败`, error);
		return false;
	}
	const dest = join(PKG_CACHE, plugin);
	try {
		mkdirSync(dest, { recursive: true });
		const tgz = join(dest, ".bundle.tar.gz");
		writeFileSync(tgz, buf);
		// 用系统 tar：Electron 的 node 没有内置 tar，而 tar 在所有目标平台都在
		execFileSync("tar", ["-xzf", tgz, "-C", dest], { stdio: "ignore", timeout: 120_000 });
		rmSync(tgz, { force: true });
		writeFileSync(mark, new Date().toISOString());
		return true;
	} catch (error) {
		log(`${plugin} bundle 解包失败`, error);
		return false;
	}
}

/**
 * 取一个包里的单个文本文件：本机包目录 → 缓存 → 镜像 → 在线。
 * @param {{optional?: boolean}} [fileOpts] optional=true 时 404 属正常（README/settings），不记日志
 * @returns {Promise<string | undefined>}
 */
async function pkgFile(plugin, rel, opts = {}, fileOpts = {}) {
	// 本机就有这个包（用户下载过 / 自建）：直接读它自己的目录，优先级最高
	const localRoot =
		typeof opts.localRoot === "string" && opts.localRoot.length > 0
			? opts.localRoot
			: LOCAL_ROOTS.get(plugin);
	if (localRoot !== undefined) {
		const own = local(join(localRoot, rel));
		if (own !== undefined) return own;
	}
	const cache = pkgCacheFile(plugin, rel);
	if (opts.offlineOnly !== true) {
		const hit = local(cache);
		if (hit !== undefined) return hit;
		const mirror = local(pkgMirrorFile(plugin, rel));
		if (mirror !== undefined) {
			writeIfChanged(cache, mirror);
			return mirror;
		}
		// 路径①：老包的逐文件公开源
		try {
			const text = await httpText(`${COS_BASE}/plugins/${plugin}/${rel}`, opts.timeoutMs ?? 12_000);
			writeIfChanged(cache, text);
			return text;
		} catch {
			/* 交给调用方决定要不要走 bundle（见 loadPackage：只有 manifest 拿不到才整包兜底） */
		}
		if (opts.noBundle !== true && (await fetchBundle(plugin, opts))) {
			const fromBundle = local(cache);
			if (fromBundle !== undefined) return fromBundle;
		}
		if (fileOpts.optional !== true) log(`${plugin}/${rel} 拉取失败（两条路径都没有）`);
		return undefined;
	}
	return local(cache) ?? local(pkgMirrorFile(plugin, rel));
}

function parseJsonSafe(text) {
	if (typeof text !== "string") return undefined;
	try {
		return JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		return undefined;
	}
}

/**
 * 加载一个专家包的完整内容（plugin.json + settings.json + 所有 agents/*.md + skills 清单）。
 *
 * 注意：部分包的 `agents` 字段写成目录 `"./agents/""` 或干脆为 null，此时成员名只能从
 * `teamInfo.memberAgents` + `members[].id` 推导（官方真实包里 33 个 team 包有 6 个是这种）。
 * @param {string} plugin
 * @param {{fresh?: boolean, timeoutMs?: number, offlineOnly?: boolean}} [opts]
 */
export async function loadPackage(plugin, opts = {}) {
	if (typeof plugin !== "string" || plugin.length === 0 || plugin.includes("..")) return undefined;
	ensureLocalScanned();
	// 先试逐文件公开源；manifest 拿不到说明这是 2026-06 之后的新包，
	// 整包走一次 tar.gz 回退源（只试一次，之后全部命中缓存 —— 避免每个文件都白试 404）。
	let manifestText = await pkgFile(plugin, ".codebuddy-plugin/plugin.json", opts, { optional: true });
	if (parseJsonSafe(manifestText) === undefined && opts.offlineOnly !== true && opts.noBundle !== true) {
		if (await fetchBundle(plugin, opts)) {
			manifestText = await pkgFile(plugin, ".codebuddy-plugin/plugin.json", { ...opts, noBundle: true }, { optional: true });
		}
	}
	const manifest = parseJsonSafe(manifestText);
	const inner = { ...opts, noBundle: true };
	const settings = parseJsonSafe(await pkgFile(plugin, "settings.json", inner, { optional: true }));

	const declared = Array.isArray(manifest?.agents) ? manifest.agents : [];
	const names = new Set();
	for (const rel of declared) {
		const s = String(rel);
		if (s.endsWith(".md")) names.add(s.split("/").pop().replace(/\.md$/, ""));
	}
	if (names.size === 0 || declared.some((s) => String(s).replace(/\/$/, "").endsWith("agents"))) {
		const info = manifest?.teamInfo ?? {};
		if (info.leadAgent) names.add(info.leadAgent);
		for (const m of info.memberAgents ?? []) names.add(m);
		for (const m of manifest?.members ?? []) if (m?.id) names.add(m.id);
	}
	// 本地镜像里已存在但清单没写全的成员，也一并收进来
	for (const dir of [join(PKG_CACHE, plugin, "agents"), join(MIRROR_ROOT, "expert-market/remote", plugin, "agents")]) {
		try {
			for (const f of readdirSync(dir)) if (f.endsWith(".md")) names.add(f.replace(/\.md$/, ""));
		} catch {
			/* 目录不存在 */
		}
	}

	const agents = {};
	for (const name of names) {
		if (name === undefined || name === null) continue;
		const text = await pkgFile(plugin, `agents/${name}.md`, inner);
		if (text !== undefined) agents[String(name)] = text;
	}

	const skills = [];
	for (const rel of manifest?.skills ?? []) {
		const dir = String(rel).replace(/^\.\//, "").replace(/^\/+/, "");
		const text = await pkgFile(plugin, `${dir}/SKILL.md`, inner);
		if (text !== undefined) {
			skills.push({
				path: dir,
				name: dir.split("/").pop(),
				text,
				description: frontmatterField(text, "description"),
				references: referenceIndex(text),
			});
		}
	}

	return {
		plugin,
		manifest,
		manifestText,
		settings,
		agents,
		agentNames: Object.keys(agents),
		skills,
		readme: await pkgFile(plugin, "README.md", inner, { optional: true }),
	};
}

/**
 * 取技能里的单个 reference 文件（渐进式披露的第二层）。
 * @param {string} plugin
 * @param {string} skillDir 技能目录（如 skills/novel-workshop-pro）
 * @param {string} ref 形如 references/x.md 或 x.md
 */
export async function loadSkillReference(plugin, skillDir, ref, opts = {}) {
	const clean = String(ref ?? "").replace(/^\/+/, "");
	if (clean.includes("..") || !clean.endsWith(".md")) return undefined;
	const rel = clean.startsWith("references/") ? clean : `references/${clean}`;
	return pkgFile(plugin, `${String(skillDir).replace(/\/+$/, "")}/${rel}`, opts, { optional: true });
}

/**
 * 从技能正文里提取 references 清单（渐进式披露结构）。
 * WorkBuddy 的大技能把细节拆到 references/*.md，正文以 `references/x.md` 引用；
 * 在线没有列目录接口，所以清单只能从正文抠 —— 这也正好只暴露真的被引用到的文件。
 */
export function referenceIndex(skillText, limit = 80) {
	if (typeof skillText !== "string") return [];
	const out = [];
	const seen = new Set();
	for (const m of skillText.matchAll(/references\/([A-Za-z0-9_./-]+\.md)/g)) {
		const rel = `references/${m[1]}`;
		if (seen.has(rel)) continue;
		seen.add(rel);
		out.push(rel);
		if (out.length >= limit) break;
	}
	return out;
}

/** 从 markdown frontmatter 里取一个标量字段（含 YAML 块标量 `|` / `>`）。 */
export function frontmatterField(text, field) {
	const fm = parseYamlFrontmatter(text);
	const value = fm?.[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 解析 agent / skill md 的 frontmatter（保留原语义：标量、内联数组、两层嵌套、块标量）。
 * @returns {Record<string, unknown>}
 */
export function parseFrontmatter(text) {
	return parseYamlFrontmatter(text);
}

/**
 * YAML 子集解析器 —— 只覆盖 WorkBuddy 专家包 frontmatter 实际用到的形态：
 *   key: value / key: |（块标量，含 |- >- 变体）/ 两层嵌套映射 / 内联 [a, b] / `- item` 列表。
 * 不引第三方依赖（宿主 node_modules 里的 yaml 对本地 link 插件不可靠）。
 */
export function parseYamlFrontmatter(text) {
	if (typeof text !== "string") return {};
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!m) return {};
	const lines = m[1].split(/\r?\n/);
	const out = {};

	const strip = (v) => v.trim().replace(/^["']|["']$/g, "");
	const inlineList = (v) => {
		const inner = v.slice(1, -1).trim();
		if (inner.length === 0) return [];
		return inner.split(",").map((p) => strip(p)).filter((p) => p.length > 0);
	};

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.trim().length === 0 || /^\s*#/.test(line)) continue;
		const kv = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
		if (kv === null) continue; // 缩进层的键由下面的父键分支消费
		const key = kv[1];
		let rest = kv[2];

		// 块标量：|  | -  >  > -
		if (/^\s*[|>][-+]?\s*$/.test(rest)) {
			const fold = rest.trim().startsWith(">");
			const block = [];
			while (i + 1 < lines.length) {
				const next = lines[i + 1];
				if (next !== undefined && (/^\s+\S/.test(next) || next.trim().length === 0)) {
					block.push(next.replace(/^\s{1,6}/, ""));
					i += 1;
				} else break;
			}
			out[key] = fold
				? block.join(" ").replace(/\s+/g, " ").trim()
				: block.join("\n").replace(/\s+$/, "");
			continue;
		}

		if (rest.trim().length > 0) {
			const v = rest.trim();
			out[key] = v.startsWith("[") && v.endsWith("]") ? inlineList(v) : strip(v);
			continue;
		}

		// 空值：往后看是缩进映射（两层）还是 `- item` 列表
		const child = {};
		const list = [];
		let consumed = 0;
		while (i + 1 < lines.length) {
			const next = lines[i + 1];
			if (!/^\s+\S/.test(next)) break;
			const ckv = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(next);
			if (ckv !== null) {
				child[ckv[1]] = strip(ckv[2]);
			} else {
				const item = /^\s+-\s+(.*)$/.exec(next);
				if (item !== null) list.push(strip(item[1]));
				else break;
			}
			i += 1;
			consumed += 1;
		}
		if (consumed === 0) out[key] = "";
		else out[key] = list.length > 0 && Object.keys(child).length === 0 ? list : child;
	}
	return out;
}

/* ────────────────────────────── 条目视图 ────────────────────────────── */

const zh = (v) => (v && typeof v === "object" ? (v.zh ?? v.en) : v) ?? "";

/** 把清单条目压成给 UI / 工具用的轻量视图（不含正文）。 */
export function entryView(e) {
	const members = (e.members ?? []).map((m) => ({
		id: m.id,
		name: zh(m.name ?? m.displayName),
		profession: zh(m.profession),
		role: m.role ?? "member",
		avatar: m.avatar ?? null,
	}));
	return {
		id: e.id,
		plugin: e.plugin,
		kind: e.kind ?? "expert",
		expertType: e.expertType ?? "agent",
		// WorkBuddy 卡片的主标题是 profession（如「中文网络小说创作顾问」），
		// 副标题才是 displayName 花名（如「网文主编」）—— 这里 title 对齐主标题。
		title: zh(e.profession) || zh(e.displayName) || e.plugin,
		name: zh(e.displayName),
		nameEn: (e.displayName && typeof e.displayName === "object" ? e.displayName.en : e.displayName) ?? "",
		profession: zh(e.profession),
		description: zh(e.description),
		categoryId: e.categoryId,
		category: zh(e.categoryName) || e.categoryId,
		tags: (e.tags ?? []).map(zh),
		promptFile: e.promptFile,
		agentName: e.agentName,
		lead: members.find((m) => m.role === "lead")?.id ?? e.agentName,
		members: members.filter((m) => m.role !== "lead"),
		initPrompt: zh(e.defaultInitPrompt),
		isOPC: Boolean(e.isOPC),
		manifest: e._manifest,
		sourceId: e.sourceId,
		connectorId: e.connectorId,
		// 头像原始路径：云端两类（/avatars/<Id>.png、/plugins/<pkg>/avatars/x.png）+
		// 本机包相对路径（avatars/expert.png）。统一交给 lib/avatars.js 解析。
		avatar: e.avatar ?? null,
		// UI 与工具共用同一轻量形状：summary 是截断后的简介，memberCount 不含主理人
		memberCount: members.filter((m) => m.role !== "lead").length,
		summary: oneLine(zh(e.description), 140),
	};
}

/** 压成一行并截断（响应体与注入段都靠它控制体积）。 */
export function oneLine(text, max) {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export { zh };

/** 对外暴露：本机已下载专家包的目录条目（带 60 秒扫描缓存）。 */
export function localMarketplaceEntries() {
	return scanLocalMarketplaces();
}

/**
 * 某个 plugin 若在本机市场里有实体目录，返回它的路径；否则 undefined。
 * 头像层用它优先读本地原图，避免为一张 300KB 的图走网络。
 */
export function localRootOf(plugin) {
	ensureLocalScanned();
	return LOCAL_ROOTS.get(plugin);
}
