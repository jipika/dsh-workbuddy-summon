/**
 * dsh-workbuddy-summon — Host 半边
 *
 * 把 WorkBuddy 的「专家 / 专家团」做成在线目录 + 对话框召唤：
 *   · 目录在线优先（COS 公开清单），失败自动降级到本地缓存 / 本机镜像；
 *   · **未召唤的会话一个字都不注入**（求值器返回空串，宿主 renderPrompt 过滤）；
 *   · 召唤时异步取包 → 预计算注入文本 → 落盘；求值器只同步查表
 *     （求值器每个模型步都跑，里面绝不能有网络或磁盘扫描）；
 *   · 成员正文按需取（wb_expert_read），不整团预注入，避免一个 6 人团吃掉几万 token；
 *   · 连接器只留入口（kind="connector" + 开关），MCP 接线待专家团测完再做。
 *
 * 依赖服务：systemPrompt（注入段）、tools（模型侧工具）、webServer（UI 路由）、
 * agents（拿当前发起 Agent → sessionId）。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import {
	loadCatalog,
	loadPackage,
	loadSkillReference,
	entryView,
	COS_BASE,
	STATE_ROOT,
	zh,
} from "./lib/catalog.js";
import {
	getSummon,
	setSummon,
	clearSummon,
	listSummons,
	sessionIdOf,
	pruneSummons,
} from "./lib/state.js";
import { composeSummon, SECTION_NAME, SECTION_ORDER } from "./lib/inject.js";
import { getAvatar, avatarUrl, AVATAR_DEFAULT_SIZE } from "./lib/avatars.js";
import { installShims, checkShimDeps } from "./lib/shims.js";
import { loadConnectors, connectorView } from "./lib/connectors.js";
import { listLocal, localCount, addLocal, updateLocal, removeLocal } from "./lib/local-connectors.js";
import { classify, probeMany, probeCacheStats } from "./lib/connector-probe.js";
import {
	connectInSession,
	disconnectInSession,
	listForSession,
	allSessions,
	restoreForSession,
	forgetSession,
	bindAgents,
	safeServerName,
} from "./lib/connector-session.js";

export const name = "dsh-workbuddy-summon";
export const inject = ["systemPrompt", "tools", "webServer", "agents"];

const ROUTE = "/dsh-workbuddy-summon";
const SECTIONS_DIR = join(STATE_ROOT, "sections");
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SUMMON_SESSIONS = 200;
/**
 * 头像缓存策略：短 max-age + 内容 ETag。
 * 不能像静态资源那样 cache 一天 —— 那会让 WorkBuddy 换头像后最长一天看不到新图，
 * 而"跟着他的数据动"正是这个插件的立身之本。
 */
const AVATAR_CACHE_CONTROL = "public, max-age=300";

const log = (...a) => console.log("[dsh-workbuddy-summon]", ...a);

/* ─────────────────────────── 目录缓存（进程内） ─────────────────────────── */

let catalogCache = null; // { at, entries(byPlugin), views, sources, degraded }

function indexCatalog(result) {
	const byPlugin = new Map();
	const views = [];
	for (const raw of result.entries) {
		const view = entryView(raw);
		if (view.plugin !== undefined && !byPlugin.has(view.plugin)) byPlugin.set(view.plugin, raw);
		views.push(view);
	}
	// 同一 plugin 的多个条目（不同 id）都保留，供按 id 精确召唤
	const byKey = new Map();
	for (const raw of result.entries) byKey.set(`${raw.plugin}::${raw.id}`, raw);
	return { at: Date.now(), byPlugin, byKey, views, sources: result.sources, degraded: result.degraded };
}

async function catalog(opts = {}) {
	const fresh = opts.fresh === true;
	if (!fresh && catalogCache !== null && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
		return catalogCache;
	}
	const result = await loadCatalog({ fresh: fresh || catalogCache === null });
	catalogCache = indexCatalog(result);
	log(
		`目录就绪：${catalogCache.views.length} 条（${
			catalogCache.sources.map((s) => `${s.name}:${s.origin}/${s.count}`).join(" ")
		}）${catalogCache.degraded ? "（降级）" : ""}`,
	);
	return catalogCache;
}

/** 按 plugin 或 plugin::id 找条目。 */
function findEntry(cat, key) {
	if (typeof key !== "string" || key.length === 0) return undefined;
	if (cat.byKey.has(key)) return cat.byKey.get(key);
	return cat.byPlugin.get(key);
}

/* ─────────────────────────── 注入段（预计算 + 落盘） ─────────────────────────── */

/** sessionId → { text, plugin, chars, at } */
const sections = new Map();

function sectionFile(sessionId) {
	return join(SECTIONS_DIR, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_")}.md`);
}

function loadSectionFromDisk(sessionId) {
	try {
		const text = readFileSync(sectionFile(sessionId), "utf8");
		if (text.length > 0) return text;
	} catch {
		/* 无缓存 */
	}
	return undefined;
}

/**
 * 删掉某会话的注入段落盘文件。
 * 取消召唤时**删文件而不是写空串** —— 写空串会留下 0 字节垃圾，
 * 时间一长 sections/ 里全是这种没有归属的空壳。
 */
function removeSectionFile(sessionId) {
	try {
		rmSync(sectionFile(sessionId), { force: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * 回收 sections/ 里的垃圾：0 字节文件 + 已经没有召唤记录的孤儿文件。
 * 启动时跑一次即可（求值器只查内存 Map，这些文件纯粹是磁盘卫生问题）。
 */
function sweepSectionFiles() {
	let files;
	try {
		files = readdirSync(SECTIONS_DIR);
	} catch {
		return 0;
	}
	const aliveNames = new Set(Object.keys(listSummons()).map((id) => basename(sectionFile(id))));
	let removed = 0;
	for (const name of files) {
		if (!name.endsWith(".md")) continue;
		const full = join(SECTIONS_DIR, name);
		try {
			// 0 字节（历史遗留或写入失败）与孤儿（已无召唤记录）都回收
			if (statSync(full).size === 0 || !aliveNames.has(name)) {
				rmSync(full, { force: true });
				removed += 1;
			}
		} catch {
			/* 单个文件出错不影响其余 */
		}
	}
	return removed;
}

/**
 * 取包并预计算注入文本；写盘 + 记进召唤状态。
 * @returns {Promise<{chars: number, truncated: boolean}>}
 */
async function buildSection(sessionId, entry, pkg, cfg) {
	const text = composeSummon(entry, pkg, {
		sessionId,
		maxLeadChars: Number.isFinite(cfg?.maxLeadChars) ? cfg.maxLeadChars : 24_000,
	});
	if (text.length === 0) {
		// 组装不出内容（例如包本体取不到）：删掉落盘而不是写空串，避免留 0 字节垃圾
		sections.delete(sessionId);
		removeSectionFile(sessionId);
		return { chars: 0, truncated: false };
	}
	mkdirSync(SECTIONS_DIR, { recursive: true });
	writeFileSync(sectionFile(sessionId), text);
	sections.set(sessionId, {
		text,
		plugin: pkg.plugin,
		chars: text.length,
		at: new Date().toISOString(),
	});
	const lead = pkg.agentNames?.[0];
	return {
		chars: text.length,
		truncated: (pkg.agents?.[lead]?.length ?? 0) > 24_000,
	};
}

/** 召唤一个专家/专家团进某会话。 */
async function summon(opts) {
	const { sessionId, key } = opts;
	const cat = await catalog({ fresh: opts.fresh === true });
	const entry = findEntry(cat, key);
	if (entry === undefined) {
		const avail = cat.views.slice(0, 12).map((v) => v.plugin).join(", ");
		throw Object.assign(new Error(`未找到专家包 "${key}"（目录共 ${cat.views.length} 条，例如：${avail}…）`), {
			code: "not-found",
		});
	}
	const plugin = entry.plugin;
	if (typeof plugin !== "string" || plugin.length === 0) {
		throw Object.assign(new Error(`条目 "${key}" 缺少 plugin 字段`), { code: "bad-entry" });
	}
	const kind = (entry.expertType ?? "agent") === "team" ? "team" : "expert";
	const pkg = await loadPackage(plugin, { fresh: opts.fresh === true });
	if (pkg === undefined || pkg.manifest === undefined) {
		throw Object.assign(
			new Error(
				`专家包 "${plugin}" 的定义取不到（该包可能走登录态分发，COS 上 404）。` +
					`可在 WorkBuddy 里召唤一次让它落到本机镜像后重试。`,
			),
			{ code: "package-unavailable" },
		);
	}
	// 先算注入段（buildSection 会把文本放进内存 sections，注入即刻生效），
	// 再一次性写召唤状态 —— 避免出现「状态说已召唤、注入段还没就绪」的窗口。
	const built = await buildSection(sessionId, entry, pkg, opts.config);
	const view = entryView(entry);
	const avatar = view.avatar === null || view.avatar === undefined ? null : avatarUrl(view.plugin);
	setSummon(sessionId, {
		plugin,
		kind,
		entryId: entry.id,
		title: view.title,
		alias: view.name,
		avatarUrl: avatar,
		pkgAgents: pkg.agentNames?.length ?? 0,
		pkgSkills: pkg.skills?.length ?? 0,
		chars: built.chars,
		truncated: built.truncated,
	});
	return {
		sessionId,
		plugin,
		kind,
		title: view.title,
		name: view.name,
		profession: view.profession,
		avatarUrl: avatar,
		members: view.members.map((m) => m.id),
		skills: (pkg.skills ?? []).map((s) => s.name),
		...built,
	};
}

/** 取消召唤（清注入 + 清状态）。 */
function unsummon(sessionId) {
	sections.delete(sessionId);
	removeSectionFile(sessionId);
	return clearSummon(sessionId);
}

/* ─────────────────────────── 模型侧工具 ─────────────────────────── */

const jsonRender = (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }];

function currentSessionId(ctx) {
	const agent = ctx.agents?.currentInitiator?.() ?? ctx.agents?.requireInitiator?.();
	return sessionIdOf(agent);
}

function toolList(ctx, cfg) {
	return {
		name: "wb_experts_list",
		description:
			"列出 WorkBuddy 专家 / 专家团在线目录（默认读 6 小时内的进程缓存，不联网）。" +
			"用于在召唤前确认有哪些角色：返回 plugin、名称、类型（team=专家团）、分类、成员数。" +
			"传 refresh:true 强制联网刷新清单。",
		parameters: {
			type: "object",
			properties: {
				kind: { type: "string", enum: ["all", "team", "expert"], description: "只看专家团 / 单专家 / 全部，默认 all" },
				category: { type: "string", description: "分类 ID 或中文名子串，如 02-Engineering 或 金融" },
				q: { type: "string", description: "在名称/职业/简介/标签里做子串匹配" },
				limit: { type: "number", description: "最多返回条数，默认 40，上限 200" },
				refresh: { type: "boolean", description: "true = 强制联网刷新清单" },
			},
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args) {
			const cat = await catalog({ fresh: args?.refresh === true });
			const kind = args?.kind ?? "all";
			const q = typeof args?.q === "string" ? args.q.trim().toLowerCase() : "";
			const category = typeof args?.category === "string" ? args.category.trim().toLowerCase() : "";
			const limit = Math.min(200, Math.max(1, Number.isFinite(args?.limit) ? args.limit : 40));
			let rows = cat.views;
			if (kind === "team") rows = rows.filter((v) => v.expertType === "team");
			else if (kind === "expert") rows = rows.filter((v) => v.expertType !== "team");
			if (category.length > 0) {
				rows = rows.filter(
					(v) =>
						String(v.categoryId ?? "").toLowerCase().includes(category) ||
						String(v.category ?? "").toLowerCase().includes(category),
				);
			}
			if (q.length > 0) {
				rows = rows.filter((v) =>
					`${v.name} ${v.nameEn} ${v.profession} ${v.description} ${v.tags.join(" ")} ${v.plugin}`
						.toLowerCase()
						.includes(q),
				);
			}
			const current = getSummon(currentSessionId(ctx));
			return {
				total: rows.length,
				returned: Math.min(limit, rows.length),
				degraded: cat.degraded,
				sources: cat.sources,
				currentSummon: current ?? null,
				items: rows.slice(0, limit).map((v) => ({
					plugin: v.plugin,
					id: v.id,
					title: v.title,
					name: v.name,
					expertType: v.expertType,
					category: v.category,
					profession: v.profession,
					memberCount: v.memberCount,
					tags: v.tags.slice(0, 4),
					summary: v.summary,
				})),
			};
		},
	};
}

/**
 * 长文本分页：技能正文最大实测 257k 字符（workbuddy 市场 1315 个 SKILL.md 里 167 个 >20k），
 * 绝不能整块塞回模型。默认给 24k 一段，带 nextFrom 让模型自己续读。
 */
function paginate(text, from, maxChars) {
	const start = Math.max(0, Number.isFinite(from) ? Math.floor(from) : 0);
	const cap = Math.max(2000, Number.isFinite(maxChars) ? Math.floor(maxChars) : 24_000);
	const total = typeof text === "string" ? text.length : 0;
	if (total === 0) return { chunk: "", from: 0, nextFrom: null, total: 0, truncated: false };
	const chunk = text.slice(start, start + cap);
	const nextFrom = start + chunk.length < total ? start + chunk.length : null;
	return { chunk, from: start, nextFrom, total, truncated: nextFrom !== null };
}

function toolRead(ctx, cfg) {
	const cap = Number.isFinite(cfg?.maxReadChars) ? cfg.maxReadChars : 24_000;
	return {
		name: "wb_expert_read",
		description:
			"按需取回 WorkBuddy 专家包里的原文，四种用法：" +
			"① 不传 agent/skill → 返回该包清单（成员 Agent ID、技能与其 references 目录）；" +
			"② agent=<Agent ID> → 取成员定义原文（专家团派发成员前必做，把返回的 text 完整放进 spawn_teammate 的 prompt）；" +
			"③ skill=<技能名> → 取技能正文；④ skill=<技能名> + ref=<references/x.md> → 取该技能的分层细节文件。" +
			"长文本按 24k 字符分段返回：nextFrom 非空表示还有后续，带 from=<nextFrom> 续读，不要凭截断内容臆测后半部分。",
		parameters: {
			type: "object",
			properties: {
				plugin: { type: "string", description: "专家包名（来自 wb_experts_list 的 plugin 字段）" },
				agent: { type: "string", description: "成员 Agent ID（团长用清单里的 lead 字段）" },
				skill: { type: "string", description: "技能名（清单 skills 里的 name）" },
				ref: { type: "string", description: "技能内的分层细节文件，形如 references/xxx.md" },
				from: { type: "number", description: "续读起始字符偏移（用上次返回的 nextFrom）" },
				what: { type: "string", enum: ["auto", "readme", "manifest"], description: "auto（默认）；readme / manifest 取包说明与原始元数据" },
			},
			required: ["plugin"],
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args) {
			const plugin = String(args?.plugin ?? "").trim();
			if (plugin.length === 0) throw new Error("wb_expert_read: 需要 plugin");
			const pkg = await loadPackage(plugin, {});
			if (pkg === undefined || pkg.manifest === undefined) {
				throw new Error(`wb_expert_read: 取不到包 "${plugin}"（该包可能走登录态分发，本机也没有）`);
			}
			if (args?.what === "manifest") return { plugin, manifest: pkg.manifest, settings: pkg.settings ?? null };
			if (args?.what === "readme") {
				const p = paginate(pkg.readme ?? "", args?.from, cap);
				return { plugin, readme: p.chunk, ...pickPage(p), empty: (pkg.readme ?? "").length === 0 };
			}
			if (typeof args?.skill === "string" && args.skill.length > 0) {
				const hit = (pkg.skills ?? []).find((s) => s.name === args.skill || s.path === args.skill);
				if (hit === undefined) {
					return { plugin, error: `无技能 "${args.skill}"`, available: (pkg.skills ?? []).map((s) => s.name) };
				}
				if (typeof args?.ref === "string" && args.ref.length > 0) {
					const text = await loadSkillReference(plugin, hit.path, args.ref, {});
					if (text === undefined) {
						return { plugin, skill: hit.name, error: `取不到 "${args.ref}"`, available: hit.references ?? [] };
					}
					const p = paginate(text, args?.from, cap);
					return { plugin, skill: hit.name, ref: args.ref, text: p.chunk, ...pickPage(p) };
				}
				const p = paginate(hit.text, args?.from, cap);
				return {
					plugin,
					skill: hit.name,
					description: hit.description ?? "",
					text: p.chunk,
					...pickPage(p),
					references: hit.references ?? [],
					hint:
						(hit.references?.length ?? 0) > 0
							? "该技能有分层细节：按需传 ref=<上面的路径> 取用，不要一次性全取。"
							: undefined,
				};
			}
			if (typeof args?.agent === "string" && args.agent.length > 0) {
				const text = pkg.agents?.[args.agent];
				if (text === undefined) {
					return { plugin, error: `无成员 "${args.agent}"`, available: pkg.agentNames ?? [] };
				}
				const p = paginate(text, args?.from, cap);
				return { plugin, agent: args.agent, text: p.chunk, ...pickPage(p) };
			}
			return {
				plugin,
				expertType: pkg.manifest?.expertType ?? "agent",
				lead: pkg.manifest?.agentName ?? pkg.manifest?.teamInfo?.leadAgent ?? null,
				agents: pkg.agentNames ?? [],
				skills: (pkg.skills ?? []).map((s) => ({
					name: s.name,
					description: s.description ?? "",
					references: s.references ?? [],
				})),
				hint: "传 agent=<Agent ID> 取成员定义原文；传 skill=<技能名> 取技能正文，再配 ref=<references/x.md> 取细节。",
			};
		},
	};
}

/** 只把分页元信息摊平进返回值（避免把整段原文重复一份）。 */
function pickPage(p) {
	return { from: p.from, nextFrom: p.nextFrom, totalChars: p.total, truncated: p.truncated };
}

function toolSummon(ctx, cfg) {
	return {
		name: "wb_summon",
		description:
			"把一个 WorkBuddy 专家 / 专家团召唤进**当前会话**（等价于用户在对话框点「召唤」）。" +
			"生效后该角色的身份、工作方法、团队编制与调度规程会注入本会话的系统提示词，" +
			"后续每一轮都保持生效，直到 wb_unsummon 或用户取消。只影响当前会话。",
		parameters: {
			type: "object",
			properties: {
				plugin: { type: "string", description: "专家包名（wb_experts_list 的 plugin 字段）" },
			},
			required: ["plugin"],
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args) {
			const sessionId = currentSessionId(ctx);
			if (sessionId === undefined) {
				throw new Error("wb_summon: 取不到当前会话 id（无法定位注入目标）");
			}
			const result = await summon({
				sessionId,
				key: String(args?.plugin ?? "").trim(),
				config: cfg,
			});
			return { ...result, note: "注入已生效，从下一轮请求开始按该专家身份工作。" };
		},
	};
}

function toolUnsummon(ctx) {
	return {
		name: "wb_unsummon",
		description:
			"取消当前会话的 WorkBuddy 专家召唤，恢复默认助手人格。不传参数即取消当前会话的召唤；" +
			"当前没有召唤时返回 summoned:false。",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute() {
			const sessionId = currentSessionId(ctx);
			const before = getSummon(sessionId);
			return { sessionId: sessionId ?? null, summoned: before !== undefined, cleared: unsummon(sessionId) };
		},
	};
}

/* ─────────────────────────── 连接器工具 ─────────────────────────── */

function toolConnectors(ctx) {
	return {
		name: "wb_connectors_list",
		description:
			"列出 WorkBuddy 连接器在线目录（默认 6 小时缓存，不联网）。返回 id、名称、传输方式、" +
			"可接入性分级（ready / needs-credential / needs-cli-login / try / blocked / unsupported）。" +
			"分级来自真实 initialize 握手探测（实测静态规则会把 232 条误判为 ready，握手仅 32 条真可用）；未探测过的一律标 unverified，不猜可用。" +
			"传 refresh:true 强制联网刷新（源支持 ETag，未变更时只花一个 304）。",
		parameters: {
			type: "object",
			properties: {
				access: { type: "string", description: "按可接入性过滤：ready / needs-credential / needs-token / unverified / blocked / all（默认 all）" },
				q: { type: "string", description: "在名称/描述/标签里做子串匹配" },
				transport: { type: "string", enum: ["all", "stdio", "remote", "cli"], description: "按传输方式过滤" },
				limit: { type: "number", description: "最多返回条数，默认 40，上限 200" },
				refresh: { type: "boolean", description: "true = 强制联网刷新清单" },
			},
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args) {
			const cat = await loadConnectors({ fresh: args?.refresh === true });
			// 接入是会话级的：标「已接入」只针对当前会话，不是全局
			const sessionId = currentSessionId(ctx);
			const installed = new Map((sessionId === undefined ? [] : listForSession(sessionId)).map((r) => [r.serverName, r]));
			let rows = cat.connectors.map((c) => ({ ...connectorView(c), access: classify(c) }));
			const want = (args?.access ?? "all").toLowerCase();
			if (want !== "all") rows = rows.filter((r) => r.access.level === want);
			if (typeof args?.transport === "string" && args.transport !== "all") {
				rows = rows.filter((r) => r.transportKind === args.transport);
			}
			const q = typeof args?.q === "string" ? args.q.trim().toLowerCase() : "";
			if (q.length > 0) {
				rows = rows.filter((r) => `${r.name} ${r.description} ${r.tags.join(" ")} ${r.id}`.toLowerCase().includes(q));
			}
			const limit = Math.min(200, Math.max(1, Number.isFinite(args?.limit) ? args.limit : 40));
			const levels = {};
			for (const r of cat.connectors.map((c) => classify(c))) levels[r.level] = (levels[r.level] ?? 0) + 1;
			return {
				total: rows.length,
				returned: Math.min(limit, rows.length),
				catalogTotal: cat.connectors.length,
				source: cat.source,
				etag: cat.etag ?? null,
				accessSummary: levels,
				installedCount: installed.size,
				items: rows.slice(0, limit).map((r) => ({
					id: r.id,
					name: r.name,
					transportKind: r.transportKind,
					access: r.access.level,
					why: r.access.why,
					needsEnv: r.access.needsEnv ?? [],
					url: r.url,
					command: r.command,
					installed: installed.has(safeServerName(r.id)),
					summary: r.description,
				})),
			};
		},
	};
}

function toolConnectorInstall(ctx) {
	return {
		name: "wb_connector_install",
		description:
			"把一个 WorkBuddy 连接器接入**当前会话**（与召唤专家同构：只作用于本会话，" +
			"不写 profile 配置、不影响其他会话）。成功后该会话即可用 mcp__<serverName>__<tool>。" +
			"仅在用户明确要求接入时调用；先查 wb_connectors_list 的 access 分级。" +
			"needs-credential 的连接器要先让用户提供环境变量，否则连不上。" +
			"不传 connectorId 时返回本会话已接入清单。",
		parameters: {
			type: "object",
			properties: {
				connectorId: { type: "string", description: "连接器 id（来自 wb_connectors_list）；省略=查已接入清单" },
				uninstall: { type: "boolean", description: "true = 从当前会话移除该连接器的接入" },
			},
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args) {
			const sessionId = currentSessionId(ctx);
			const id = typeof args?.connectorId === "string" ? args.connectorId.trim() : "";
			if (id.length === 0) {
				if (sessionId === undefined) return { error: "取不到当前会话 id" };
				const rows = listForSession(sessionId);
				return { sessionId, scoped: true, installed: rows, count: rows.length };
			}
			if (sessionId === undefined) {
				return { error: "取不到当前会话 id —— 连接器按会话接入，需在具体会话里调用" };
			}
			const agent = ctx.agents?.get?.(sessionId);
			if (agent === undefined) return { error: `会话「${sessionId}」没有活体 agent，无法挂载` };
			const cat = await loadConnectors({});
			if (args?.uninstall === true) {
				return disconnectInSession(sessionId, safeServerName(id));
			}
			const c = cat.byId.get(id);
			if (c === undefined) {
				return { error: `未找到连接器「${id}」（目录共 ${cat.connectors.length} 条，先查 wb_connectors_list）` };
			}
			const access = classify(c);
			if (access.level === "blocked" || access.level === "unsupported") {
				return { error: `连接器「${id}」无法接入：${access.why}` };
			}
			try {
				const result = await connectInSession({ id: c.id, name: c.name, servers: c.servers, mountTimeoutMs: c.mountTimeoutMs }, agent);
				return {
					...result,
					access: access.level,
					note: result.missingEnv.length > 0
						? `已挂载到本会话，但缺环境变量 ${result.missingEnv.join(", ")}，连不上；设置后重新接入`
						: "已挂载到本会话，mcp__ 工具现在只对本会话可见",
				};
			} catch (error) {
				return { error: `接入失败：${String(error?.message ?? error)}` };
			}
		},
	};
}

function toolLocalList(ctx) {
	return {
		name: "wb_local_connectors_list",
		description:
			"列出本机自建的「本地连接器」（stdio 型 MCP server 注册表，如 npx/uvx 起的本地 MCP）。" +
			"与在线目录分开维护；接入仍用 wb_connector_install（本地条目同样按会话挂载），installed 标记当前会话是否已接入。",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute() {
			const sessionId = currentSessionId(ctx);
			const installed = new Map((sessionId === undefined ? [] : listForSession(sessionId)).map((r) => [r.serverName, r]));
			const items = listLocal().map((c) => ({
				...connectorView(c),
				source: "local",
				installed: installed.has(safeServerName(c.id)),
			}));
			return { count: items.length, items, hint: items.length === 0 ? "本地还没有条目；用 wb_local_connectors_manage action=add 注册，或在 UI「本地」tab 里添加" : undefined };
		},
	};
}

function toolLocalManage(ctx) {
	return {
		name: "wb_local_connectors_manage",
		description:
			"注册 / 编辑 / 删除本机「本地连接器」（stdio 型 MCP server，如 `npx -y <pkg>`、`uvx <pkg>`）。" +
			"add 需要 command，可选 name/args（字符串按空格切）/env（值支持 ${VAR} 形式，接入时从环境求值，建议凭据用环境变量不落明文）。" +
			"update 按 id 改任意字段（id 不可改；编辑后已接入的会话要重新接入才生效）。" +
			"注册后用 wb_connectors_list 能看到（source=local），接入用 wb_connector_install。删除只移除注册，不影响已在会话里的挂载。",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["add", "update", "remove"], description: "add=注册新条目；update=编辑；remove=删除" },
				id: { type: "string", description: "update/remove 必填；add 可选（默认按 name 生成 slug）" },
				name: { type: "string", description: "显示名" },
				command: { type: "string", description: "可执行命令，如 npx（add 必填）" },
				args: { type: "string", description: "参数（按空格切分），如 `-y doc-hub-mcp@latest`" },
				env: { type: "object", additionalProperties: { type: "string" }, description: "环境变量（值支持 ${VAR} 占位）" },
				description: { type: "string", description: "一句话用途" },
			},
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args) {
			if (args?.action === "remove") {
				const id = String(args?.id ?? "").trim();
				if (id.length === 0) return { error: "remove 需要 id（先 wb_local_connectors_list 查）" };
				return { removed: removeLocal(id), id };
			}
			if (args?.action === "update") {
				const id = String(args?.id ?? "").trim();
				if (id.length === 0) return { error: "update 需要 id" };
				const r = updateLocal(id, {
					name: args?.name,
					command: args?.command,
					args: args?.args,
					env: args?.env,
					description: args?.description,
				});
				if (!r.ok) return { error: r.error };
				return { updated: true, entry: { ...connectorView(r.entry), source: "local" } };
			}
			const r = addLocal({
				id: args?.id,
				name: args?.name,
				command: args?.command,
				args: args?.args,
				env: args?.env,
				description: args?.description,
			});
			if (!r.ok) return { error: r.error };
			return { added: true, entry: { ...connectorView(r.entry), source: "local" } };
		},
	};
}

/* ─────────────────────────── HTTP 路由（UI 用） ─────────────────────────── */

function reply(res, status, obj) {
	try {
		res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
		res.end(JSON.stringify(obj));
	} catch {
		/* 客户端已断开 */
	}
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (c) => {
			data += c;
			if (data.length > 1e6) {
				reject(new Error("body too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

function makeHandler(ctx, cfg) {
	return async (req, res) => {
		// kind:"prefix" 下 req.url 是含前缀的完整路径；两种形态都收，避免静默 404。
		const url = new URL(req.url ?? "/", "http://localhost");
		let path = url.pathname;
		if (!path.startsWith(ROUTE)) path = `${ROUTE}${path.startsWith("/") ? "" : "/"}${path}`;
		path = path.replace(/\/+$/, "");
		const seg = path.slice(ROUTE.length).replace(/^\//, "");
		const status = () => {
			const sessionId = url.searchParams.get("sessionId") ?? undefined;
			return {
				ok: true,
				route: ROUTE,
				base: COS_BASE,
				catalog: catalogCache === null
					? null
					: {
							at: new Date(catalogCache.at).toISOString(),
							total: catalogCache.views.length,
							teams: catalogCache.views.filter((v) => v.expertType === "team").length,
							sources: catalogCache.sources,
							degraded: catalogCache.degraded,
						},
				summon: sessionId === undefined ? listSummons() : (getSummon(sessionId) ?? null),
				injected: sessionId === undefined ? sections.size : (sections.get(sessionId)?.chars ?? 0),
			};
		};
		try {
			if (req.method === "GET" && (seg === "" || seg === "health" || seg === "status")) return reply(res, 200, status());

			if (req.method === "GET" && seg === "catalog") {
				const cat = await catalog({ fresh: url.searchParams.get("refresh") === "1" });
				const kind = url.searchParams.get("kind") ?? "all";
				const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
				const category = (url.searchParams.get("category") ?? "").trim().toLowerCase();
				let views = cat.views;
				if (kind === "team") views = views.filter((v) => v.expertType === "team");
				else if (kind === "expert") views = views.filter((v) => v.expertType !== "team");
				if (category.length > 0) {
					views = views.filter(
						(v) =>
							String(v.categoryId ?? "").toLowerCase().includes(category) ||
							String(v.category ?? "").toLowerCase().includes(category),
					);
				}
				if (q.length > 0) {
					views = views.filter((v) =>
						`${v.name} ${v.nameEn} ${v.profession} ${v.description} ${v.tags.join(" ")} ${v.plugin}`
							.toLowerCase()
							.includes(q),
					);
				}
				const categories = new Map();
				for (const v of cat.views) {
					const key = v.categoryId ?? "uncategorized";
					categories.set(key, { id: key, name: v.category || key, count: (categories.get(key)?.count ?? 0) + 1 });
				}
				return reply(res, 200, {
					ok: true,
					total: views.length,
					degraded: cat.degraded,
					sources: cat.sources,
					cachedAt: new Date(cat.at).toISOString(),
					categories: [...categories.values()].sort((a, b) => b.count - a.count),
					// 只回 UI 列表需要的字段：entryView 全文（description/initPrompt/members）
				// 一条就有几百字节，600 条直出会肥到 MB 级。
				items: views.slice(0, 600).map((v) => ({
					plugin: v.plugin,
					id: v.id,
					title: v.title,
					name: v.name,
					expertType: v.expertType,
					category: v.category,
					profession: v.profession,
					memberCount: v.memberCount,
					summary: v.summary,
					avatarUrl: v.avatar === null || v.avatar === undefined ? null : avatarUrl(v.plugin),
				})),
				});
			}

			if (req.method === "GET" && seg === "entry") {
				const key = url.searchParams.get("plugin") ?? "";
				const cat = await catalog({});
				const entry = findEntry(cat, key);
				if (entry === undefined) return reply(res, 404, { ok: false, error: `未找到 "${key}"` });
				const view = entryView(entry);
				const pkg = await loadPackage(view.plugin, {});
				return reply(res, 200, {
					ok: true,
					entry: view,
					pkgAvailable: pkg?.manifest !== undefined,
					agents: pkg?.agentNames ?? [],
					skills: (pkg?.skills ?? []).map((s) => ({ name: s.name, description: s.description ?? "" })),
					initPrompt: view.initPrompt,
					quickPrompts: (entry.quickPrompts ?? []).map(zh),
				});
			}

			// 头像：宿主实时代理 COS 的服务端缩略（?imageMogr2/thumbnail/Nx），本地不存图。
			if (req.method === "GET" && seg === "avatar") {
				const plugin = url.searchParams.get("plugin") ?? "";
				if (plugin.length === 0) return reply(res, 400, { ok: false, error: "缺少 plugin" });
				const size = Number(url.searchParams.get("size") ?? AVATAR_DEFAULT_SIZE);
				const agent = url.searchParams.get("agent") ?? undefined;
				const cat = await catalog({});
				const view = cat.views.find((v) => v.plugin === plugin);
				const img = await getAvatar(view, size, { agent, plugin });
				if (img.status !== 200) {
					// 没有头像也要可缓存：否则面板里每条无图条目每次都回源探一次
					res.writeHead(img.status === 502 ? 502 : 404, { "Cache-Control": "no-store" });
					res.end(JSON.stringify({ ok: false, error: img.note ?? "no avatar" }));
					return;
				}
				// 按内容算 ETag：WorkBuddy 换了头像 → 字节变 → ETag 变 → 不会长时间吃旧缓存。
				const etag = `W/"${createHash("sha1").update(Buffer.from(img.data)).digest("hex").slice(0, 16)}"`;
				if ((req.headers?.["if-none-match"] ?? "") === etag) {
					res.writeHead(304, { ETag: etag, "Cache-Control": AVATAR_CACHE_CONTROL });
					res.end();
					return;
				}
				try {
					res.writeHead(200, {
						"Content-Type": img.mime,
						"Content-Length": String(img.data.length),
						ETag: etag,
						"Cache-Control": AVATAR_CACHE_CONTROL,
					});
					res.end(Buffer.from(img.data));
				} catch {
					/* 客户端已断开 */
				}
				return;
			}

			// 连接器目录（UI 用；与专家目录分开两个端点，避免响应里混入无关字段）
			if (req.method === "GET" && seg === "connectors") {
				const cat = await loadConnectors({ fresh: url.searchParams.get("refresh") === "1" });
				// 接入是会话级的：UI 传了 sessionId 就只标本会话的已接入项
				const viewSession = url.searchParams.get("sessionId") ?? undefined;
				const installed = new Map(
					(viewSession === undefined ? [] : listForSession(viewSession)).map((r) => [r.serverName, r]),
				);
				const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
				const transport = url.searchParams.get("transport") ?? "all";
				const wantAccess = url.searchParams.get("access") ?? "all";
				let rows = cat.connectors.map((c) => {
					const v = connectorView(c);
					const a = classify(c);
					return { ...v, access: a.level, why: a.why, needsEnv: a.needsEnv ?? [] };
				});
				if (transport !== "all") rows = rows.filter((r) => r.transportKind === transport);
				if (wantAccess !== "all") rows = rows.filter((r) => r.access === wantAccess);
				if (q.length > 0) {
					rows = rows.filter((r) => `${r.name} ${r.description} ${r.tags.join(" ")} ${r.id}`.toLowerCase().includes(q));
				}
				const levels = {};
				for (const r of rows) levels[r.access] = (levels[r.access] ?? 0) + 1;
				const probeStats = probeCacheStats();
				return reply(res, 200, {
					ok: true,
					total: rows.length,
					catalogTotal: cat.connectors.length,
					source: cat.source,
					etag: cat.etag ?? null,
					degraded: cat.source !== "online",
					probe: probeStats,
					accessSummary: levels,
					sessionId: viewSession ?? null,
					installed: [...installed.values()],
					items: rows.slice(0, 600).map((r) => ({
						id: r.id, name: r.name, transportKind: r.transportKind, access: r.access,
						why: r.why, needsEnv: r.needsEnv, summary: r.description, needsCli: r.needsCli,
						source: r.source ?? "online",
						installed: installed.has(safeServerName(r.id)),
						disabled: installed.get(safeServerName(r.id))?.disabled === true,
					})),
				});
			}

			// 按需握手验证（UI「验证」按钮）：只测远端 HTTP，stdio 不自动执行
			if (req.method === "POST" && seg === "connector-probe") {
				const body = JSON.parse((await readBody(req)) || "{}");
				const ids = Array.isArray(body.connectorIds) ? body.connectorIds.slice(0, 40) : [];
				const cat = await loadConnectors({});
				const urls = [];
				for (const id of ids) {
					const c = cat.byId.get(String(id));
					const s0 = c?.servers?.[0];
					if (s0?.transport === "streamable-http" && s0.url && !s0.url.includes("${")) urls.push(s0.url);
				}
				const results = await probeMany(urls);
				const byId = {};
				for (const id of ids) {
					const c = cat.byId.get(String(id));
					if (c === undefined) continue;
					byId[id] = classify(c);
				}
				return reply(res, 200, { ok: true, probed: Object.keys(results).length, byId, cache: probeCacheStats() });
			}

			if (req.method === "POST" && (seg === "connector-install" || seg === "connector-remove")) {
				const body = JSON.parse((await readBody(req)) || "{}");
				const id = String(body.connectorId ?? "").trim();
				const sessionId = String(body.sessionId ?? "").trim();
				if (id.length === 0) return reply(res, 400, { ok: false, error: "缺少 connectorId" });
				if (sessionId.length === 0) return reply(res, 400, { ok: false, error: "缺少 sessionId（连接器按会话接入）" });
				const agent = ctx.agents?.get?.(sessionId);
				if (agent === undefined) return reply(res, 404, { ok: false, error: "该会话没有活体 agent，无法挂载" });
				if (seg === "connector-remove") {
					return reply(res, 200, { ok: true, ...(await disconnectInSession(sessionId, safeServerName(id))) });
				}
				const cat = await loadConnectors({});
				const c = cat.byId.get(id);
				if (c === undefined) return reply(res, 404, { ok: false, error: `未找到连接器「${id}」` });
				const a = classify(c);
				if (a.level === "blocked" || a.level === "unsupported") return reply(res, 400, { ok: false, error: a.why });
				try {
					const r = await connectInSession({ id: c.id, name: c.name, servers: c.servers, mountTimeoutMs: c.mountTimeoutMs }, agent);
					return reply(res, 200, { ok: true, ...r, access: a.level, needsEnv: a.needsEnv });
				} catch (error) {
					return reply(res, 502, { ok: false, error: String(error?.message ?? error) });
				}
			}

			// 本地连接器注册表（自建 stdio MCP）：列（带会话接入态）/ 加 / 改 / 删；接入仍走 connector-install
			if (req.method === "GET" && seg === "local-connectors") {
				const viewSession = url.searchParams.get("sessionId") ?? undefined;
				const installed = new Map(
					(viewSession === undefined || viewSession.length === 0 ? [] : listForSession(viewSession)).map((r) => [r.serverName, r]),
				);
				// 不走 connectorView：编辑表单需要 args/env/description 原文（connectorView 会截断且不带回）
				const items = listLocal().map((c) => {
					const s0 = c.servers[0] ?? {};
					return {
						id: c.id,
						name: c.name,
						command: s0.command ?? "",
						args: s0.args ?? [],
						env: s0.env ?? {},
						description: c.description ?? "",
						transportKind: "stdio",
						source: "local",
						mountTimeoutMs: c.mountTimeoutMs ?? null,
						installed: installed.has(safeServerName(c.id)),
					};
				});
				return reply(res, 200, { ok: true, count: items.length, items, sessionId: viewSession ?? null });
			}
			if (req.method === "POST" && (seg === "local-connector-add" || seg === "local-connector-update" || seg === "local-connector-remove")) {
				const body = JSON.parse((await readBody(req)) || "{}");
				if (seg === "local-connector-remove") {
					const id = String(body.id ?? "").trim();
					if (id.length === 0) return reply(res, 400, { ok: false, error: "缺少 id" });
					const removed = removeLocal(id);
					if (!removed) return reply(res, 404, { ok: false, error: `本地没有 id「${id}」的连接器` });
					return reply(res, 200, { ok: true, removed: true, id });
				}
				if (seg === "local-connector-update") {
					const id = String(body.id ?? "").trim();
					if (id.length === 0) return reply(res, 400, { ok: false, error: "缺少 id" });
					const r = updateLocal(id, {
						name: body.name,
						command: body.command,
						args: body.args,
						env: body.env,
						description: body.description,
						mountTimeoutMs: body.mountTimeoutMs,
					});
					if (!r.ok) return reply(res, r.error.includes("没有 id") ? 404 : 400, { ok: false, error: r.error });
					return reply(res, 200, { ok: true, entry: { ...connectorView(r.entry), source: "local" } });
				}
				const r = addLocal({
					name: body.name,
					command: body.command,
					args: body.args,
					env: body.env,
					description: body.description,
					mountTimeoutMs: body.mountTimeoutMs,
				});
				if (!r.ok) return reply(res, 400, { ok: false, error: r.error });
				return reply(res, 200, { ok: true, entry: { ...connectorView(r.entry), source: "local" } });
			}

			if (req.method === "POST" && (seg === "summon" || seg === "unsummon")) {
				const body = JSON.parse((await readBody(req)) || "{}");
				const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
				if (sessionId === undefined || sessionId.length === 0) {
					return reply(res, 400, { ok: false, error: "缺少 sessionId" });
				}
				if (seg === "unsummon") {
					const cleared = unsummon(sessionId);
					return reply(res, 200, { ok: true, cleared, sessionId });
				}
				const result = await summon({
					sessionId,
					key: String(body.plugin ?? "").trim(),
					fresh: body.refresh === true,
					config: cfg,
				});
				return reply(res, 200, { ok: true, ...result });
			}

			return reply(res, 404, { ok: false, error: `unknown route: ${seg || "/"}` });
		} catch (error) {
			const code = error?.code;
			const http = code === "not-found" || code === "package-unavailable" ? 404 : code === "bad-entry" ? 400 : 500;
			reply(res, http, { ok: false, error: String(error?.message ?? error) });
		}
	};
}

/* ─────────────────────────── apply ─────────────────────────── */

export async function apply(ctx, config) {
	const cfg = config ?? {};
	mkdirSync(SECTIONS_DIR, { recursive: true });

	// 重启恢复：把已落盘的注入段读回内存（缺失的异步补算，补算前不注入 = 安全）。
	for (const [sessionId, record] of Object.entries(listSummons())) {
		const text = loadSectionFromDisk(sessionId);
		if (text !== undefined && text.length > 0) {
			sections.set(sessionId, { text, plugin: record.plugin, chars: text.length, at: record.at });
		} else {
			void recompute(sessionId, record).catch(() => {});
		}
	}

	// 状态文件封顶：丢掉最老的会话，避免无限增长。
	const all = Object.entries(listSummons()).sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)));
	if (all.length > MAX_SUMMON_SESSIONS) {
		pruneSummons(new Set(all.slice(all.length - MAX_SUMMON_SESSIONS).map(([id]) => id)));
	}
	// 段落盘回收：0 字节历史遗留 + 上面封顶后新产生的孤儿（必须在 prune 之后跑）
	const swept = sweepSectionFiles();
	if (swept > 0) log(`回收 ${swept} 个失效注入段文件`);

	async function recompute(sessionId, record) {
		const cat = await catalog({});
		const entry = findEntry(cat, record.entryId ? `${record.plugin}::${record.entryId}` : record.plugin)
			?? findEntry(cat, record.plugin);
		const pkg = await loadPackage(record.plugin, {});
		if (entry === undefined || pkg?.manifest === undefined) return;
		await buildSection(sessionId, entry, pkg, cfg);
	}

	// ── 注入段：未召唤 → 空串（零残留）──
	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: SECTION_NAME,
				order: SECTION_ORDER,
				text: (context) => {
					const sessionId = sessionIdOf(context);
					if (sessionId === undefined) return "";
					const hit = sections.get(sessionId);
					if (hit !== undefined) return hit.text;
					const record = getSummon(sessionId);
					if (record === undefined) return "";
					// 有召唤记录但段没就绪（重启补算中）：本轮先不注入，后台补算。
					void recompute(sessionId, record).catch(() => {});
					return "";
				},
			}),
		"dsh-workbuddy-summon: system prompt section",
	);

	// ── 模型侧工具 ──
	const builtTools = [toolList(ctx, cfg), toolRead(ctx, cfg), toolSummon(ctx, cfg), toolUnsummon(ctx)];
	// 连接器工具默认注册（数据面只读；写操作在 wb_connector_install 里，由用户显式触发）
	if (cfg.connectors?.enabled !== false) {
		builtTools.push(toolConnectors(ctx), toolConnectorInstall(ctx), toolLocalList(ctx), toolLocalManage(ctx));
	}
	for (const tool of builtTools) {
		ctx.effect(() => ctx.tools.register(tool), `dsh-workbuddy-summon: tool ${tool.name}`);
	}

	// ── UI 路由 ──
	ctx.effect(
		() => ctx.webServer.register({ kind: "prefix", path: ROUTE, handler: makeHandler(ctx, cfg) }),
		"dsh-workbuddy-summon: http route",
	);

	// ── 会话级连接器的生命周期 ──
	// agent/created：该会话之前接入过的连接器重新挂载（配置不落盘，按 connectorId 重建）
	ctx.effect(
		() =>
			ctx.on("agent/created", async ({ agent }) => {
				const rows = listForSession(agent.id);
				if (rows.length === 0) return;
				const cat = await loadConnectors({});
				const byId = new Map([...cat.connectors].map((c) => [c.id, c]));
				const r = await restoreForSession(agent, byId);
				if (r.restored.length > 0) log(`会话 ${agent.id.slice(0, 14)}… 恢复接入：${r.restored.join(", ")}`);
				for (const f of r.failed) log(`会话 ${agent.id.slice(0, 14)}… 恢复失败：${f.connectorId} — ${f.why}`);
			}),
		"dsh-workbuddy-summon: agent/created restore",
	);
	// agent/disposed：scope 会自己清掉子 fiber（实测验证），这里只摘掉本模块的引用
	ctx.effect(
		() => ctx.on("agent/disposed", ({ agent }) => forgetSession(agent?.id)),
		"dsh-workbuddy-summon: agent/disposed cleanup",
	);
	bindAgents(ctx.agents);

	// 兼容垫片：把插件 bin/ 下的 westock-data / westock-tool 装进 PATH，
	// 让 WorkBuddy 专家包（其 prompt 调用的是技能目录名而非真实命令）不改一字即可运行。
	// 只覆盖带自身标记的文件，他人占用一律跳过 —— 见 lib/shims.js。
	if (cfg.installShims !== false) {
		const shims = installShims({});
		if (shims.dir !== undefined) {
			for (const dep of checkShimDeps()) {
				if (!dep.ok) log(`垫片依赖缺失：\`${dep.name}\` 不在 PATH。安装：${dep.hint}`);
			}
		}
	}

	// 目录预热：不阻塞启动，失败也不影响（首次使用会再拉）。
	if (cfg.warmCatalog !== false) {
		setTimeout(() => {
			void catalog({}).catch((error) => log("目录预热失败（首次使用时会重试）", error));
		}, 1500).unref?.();
	}

	log(
		`host half mounted｜召唤注入 order=${SECTION_ORDER}｜路由 ${ROUTE}/catalog｜` +
			`连接器=${cfg.connectors?.enabled === false ? "关闭" : "会话级已开"}`,
	);
}
