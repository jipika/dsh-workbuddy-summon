/**
 * 召唤注入：把 WorkBuddy 专家包翻译成 DSH 可执行的系统提示段。
 *
 * 三条硬规则：
 *  1) **未召唤 = 完全不注入**：求值器返回空串，宿主 renderPrompt 过滤，零残留。
 *  2) **成员正文不整团注入**：只注入团长身份 + 成员编制表；成员全文由
 *     `wb_expert_read` 按需取，Lead 再原样塞进 spawn_teammate 的 prompt。
 *     一个 6 人团的全部 md 常有 30–60 KB，全量注入会挤爆上下文。
 *  3) **必须做工具名适配**：WorkBuddy 原文写的是 `TeamCreate` / `Agent(name,
 *     subagent_type)` / `SendMessage`，DSH 侧对应的是 `spawn_teammate` /
 *     `send_message`。原文不改（改了会破坏它的语义与去重稳定性），改为在注入段
 *     里显式给出映射，并保留官方那条「禁止成员互相直连」红线。
 */
import { parseFrontmatter, zh } from "./catalog.js";

/** 去掉 frontmatter，只留正文。 */
export function bodyOf(md) {
	if (typeof md !== "string") return "";
	return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/** 团长 md 的 frontmatter（name/description/maxTurns/skills）。 */
export function leadMeta(pkg) {
	const leadId = pkg?.manifest?.agentName ?? pkg?.manifest?.teamInfo?.leadAgent;
	const text = leadId ? pkg?.agents?.[leadId] : undefined;
	return { leadId, meta: parseFrontmatter(text ?? ""), text };
}

function teamRoster(pkg) {
	const members = pkg?.manifest?.members ?? [];
	const info = pkg?.manifest?.teamInfo ?? {};
	const ids = Array.isArray(info.memberAgents) && info.memberAgents.length > 0
		? info.memberAgents
		: members.filter((m) => m?.role !== "lead").map((m) => m?.id).filter(Boolean);
	return ids.map((id) => {
		const m = members.find((x) => x?.id === id);
		const md = pkg?.agents?.[id];
		const fm = parseFrontmatter(md ?? "");
		return {
			id,
			name: zh(m?.name ?? m?.displayName) || fm.displayName?.zh || id,
			profession: zh(m?.profession) || fm.profession?.zh || "",
			description: fm.description ?? "",
			hasBody: md !== undefined,
		};
	});
}

function skillList(pkg) {
	return (pkg?.skills ?? []).map((s) => ({
		name: s.name,
		// description 可能是 YAML 块标量（实测最长 600+ 字符），注入段里只留一行摘要
		description: oneLine(s.description, 160),
		referenceCount: (s.references ?? []).length,
		references: s.references ?? [],
	}));
}

/** 压成一行并截断，避免注入段被长描述撑爆。 */
function oneLine(text, max) {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * 渲染注入段。
 * @param {object} entry 目录条目（entryView 之后的形状，或原始清单条目）
 * @param {object} pkg   loadPackage 的结果
 * @param {{sessionId?: string, maxLeadChars?: number}} [opts]
 * @returns {string} 空串表示不注入
 */
export function composeSummon(entry, pkg, opts = {}) {
	if (pkg === undefined || pkg === null) return "";
	const maxLeadChars = Number.isFinite(opts.maxLeadChars) ? opts.maxLeadChars : 24_000;
	const isTeam = (entry?.expertType ?? pkg?.manifest?.expertType) === "team";
	const { leadId, text: leadText } = leadMeta(pkg);
	// 主标题对齐 WorkBuddy 卡片：profession 在前（如「中文网络小说创作顾问」），
	// displayName 花名在后（如「网文主编」）；两者相同就只留一个。
	const title =
		entry?.title ||
		zh(entry?.profession) ||
		zh(pkg?.manifest?.profession) ||
		zh(entry?.displayName) ||
		zh(pkg?.manifest?.displayName) ||
		entry?.plugin ||
		pkg?.plugin;
	const alias = zh(entry?.displayName) || zh(pkg?.manifest?.displayName) || "";
	const subtitle = alias.length > 0 && alias !== title ? ` · ${alias}` : "";
	const skills = skillList(pkg);

	const head = [];
	head.push(`# 本会话已召唤：${title}${subtitle}`);
	head.push("");
	head.push(
		`用户在本会话里主动召唤了你。你现在的身份与工作方法以下面这份「专家定义」为准，` +
			`它优先于通用助手默认人格；与身份无关的通用安全边界与文件纪律仍然有效。` +
			`本会话结束或用户取消召唤后，该身份不再适用。`,
	);
	head.push("");

	const out = [head.join("\n")];

	// ── 专家本体（团长 / 单专家）──
	if (typeof leadText === "string" && leadText.trim().length > 0) {
		let body = bodyOf(leadText);
		let truncated = false;
		if (body.length > maxLeadChars) {
			body = `${body.slice(0, maxLeadChars)}\n\n> （原文 ${leadText.length} 字符，此处截断。` +
				`需要完整定义可调用 wb_expert_read，参数 plugin=${pkg.plugin}${leadId ? `, agent=${leadId}` : ""}）`;
			truncated = true;
		}
		out.push(`## 你的定义（${truncated ? "节选" : "原文"}）`);
		out.push("");
		out.push(body);
		out.push("");
	} else {
		// 拿不到本体正文时不假装成功：明确告知，避免模型凭空扮演
		out.push(`## 你的定义`);
		out.push("");
		out.push(
			`> ⚠️ 专家包 \`${pkg.plugin}\` 的正文尚未取到（可能离线或该包走登录态分发）。` +
				`请先调用 wb_expert_read（plugin=${pkg.plugin}）取回定义再开始工作；` +
				`取不到就如实告知用户，不要凭名字虚构人设。`,
		);
		out.push("");
	}

	// ── 团队编制 + 运行时适配 ──
	if (isTeam) {
		const roster = teamRoster(pkg);
		const lines = [];
		lines.push(`## 团队编制与调度规程`);
		lines.push("");
		if (roster.length === 0) {
			lines.push(`> 该专家团未声明成员（或成员清单未取到）。按单专家模式工作，不要虚构成员。`);
		} else {
			lines.push(`你是主理人（Lead），团队共 ${roster.length + 1} 人。成员编制：`);
			lines.push("");
			lines.push(`| Agent ID | 名字 | 职业 |`);
			lines.push(`|---|---|---|`);
			for (const r of roster) {
				lines.push(`| \`${r.id}\` | ${r.name} | ${r.profession}${r.hasBody ? "" : "（正文未取到）"} |`);
			}
			lines.push("");
		}
		lines.push(`### 调度映射（原定义为 WorkBuddy 运行时，这里给出本环境的等价执行方式）`);
		lines.push("");
		lines.push(`| 定义里的写法 | 本会话实际怎么做 |`);
		lines.push(`|---|---|`);
		lines.push(`| \`TeamCreate\`（仅主理人可建团） | 你作为 Lead 直接调用 \`spawn_teammate\` 即为建团；建团与调度只能由你发起，不得交给成员 |`);
		lines.push(`| \`Agent\` 工具，参数 \`name\` / \`subagent_type\` = 成员 Agent ID | \`spawn_teammate(name="<Agent ID>", description="<职业+一句话职责>", prompt=<该成员完整定义 + 本次任务>)\`；**name 必须用上表里的 Agent ID**，禁止用中文名或自创名 |`);
		lines.push(`| 成员 \`SendMessage\` 回传主理人 | 成员用 \`send_message(target="lead", message=...)\` 交回；你收齐后再汇编 |`);
		lines.push(`| 「禁止成员互相直连，跨成员信息流必须经主理人中转」 | **原样保留**：给成员下发 prompt 时明确要求它只向 lead 回报，不要联系其他成员 |`);
		lines.push(`| \`maxTurns\` | 本环境无该参数；用「每阶段完成后向用户简报进度」的节奏自行控制轮次 |`);
		lines.push("");
		lines.push(`### 成员定义的取用方式`);
		lines.push("");
		lines.push(
			`成员的完整人设与工作规范**没有**预先注入（省上下文）。派发某成员前：`);
		lines.push(
			`1. 调用 \`wb_expert_read\`，参数 \`plugin="${pkg.plugin}"\`、\`agent="<Agent ID>"\`，取回该成员定义原文；`);
		lines.push(
			`2. 把取回的原文**完整**放进 \`spawn_teammate\` 的 \`prompt\` 开头，再接本次任务说明与上一阶段产出原文；`);
		lines.push(
			`3. 不要凭上表的职业名自行想象成员能力。`);
		lines.push("");
		lines.push(`### 协作铁律（来自专家团规范，本会话继续有效）`);
		lines.push("");
		lines.push(`1. 建立团队与调度成员只能由你（主理人）执行，严禁委派成员建团。`);
		lines.push(`2. 按 SOP 分阶段调度：同阶段无依赖的成员并行 spawn；有依赖的等上一阶段全部回传后，把产出**原文**传入下一阶段。`);
		lines.push(`3. 成员产出必须回传后由你汇总，不得跳过；所有跨成员信息流经你中转。`);
		lines.push(`4. 严禁你自己代写成员的专业产出，也严禁 spawn 你自己。`);
		lines.push(`5. 裁决型成员（审稿/风控/主管类）必须给明确结论，不得回避决策。`);
		lines.push(`6. 所有输出使用与用户原始需求相同的语言。`);
		out.push(lines.join("\n"));
		out.push("");
	}

	// ── 技能 ──
	if (skills.length > 0) {
		const lines = [];
		lines.push(`## 配套技能（按需取用，未预载）`);
		lines.push("");
		for (const s of skills) {
			const ref = s.referenceCount > 0 ? `（含 ${s.referenceCount} 个分层细节文件）` : "";
			lines.push(`- **${s.name}**${s.description ? `：${s.description}` : ""}${ref}`);
		}
		lines.push("");
		lines.push(
			`动手前先取回与当前任务匹配的技能正文再执行：\`wb_expert_read\`，` +
				`参数 \`plugin="${pkg.plugin}"\`、\`skill="<技能名>"\`。技能里通常含判定标准、模板与自检清单。`);
		lines.push(
			`技能正文很长时会分段返回（看 \`nextFrom\`，带上 \`from=<nextFrom>\` 续读）；` +
				`标注了分层细节的技能，先不传 \`ref\` 通读主干，需要某项细节时再 \`ref="references/<文件>.md"\` 单独取，` +
				`不要一次性把所有细节拉完。`);
		out.push(lines.join("\n"));
		out.push("");
	}

	// ── 连接器 ──
	if (entry?.kind === "connector" || entry?.connectorId !== undefined) {
		out.push(
			`> 该条目关联外部连接器。连接器尚未接入本环境，涉及外部读写前先与用户确认。`);
		out.push("");
	}

	return out.join("\n").trim();
}

/** 注入段的名字（systemPrompt.section 的 name 字段）。 */
export const SECTION_NAME = "dsh-workbuddy-summon:expert";
/**
 * 装配权重。放在较后位置：召唤是用户的显式会话级意图，需要压过通用默认人格，
 * 但仍在宿主工具规范与权限纪律之后（那些不该被专家身份覆盖）。
 */
export const SECTION_ORDER = 900;
