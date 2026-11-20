/**
 * WorkBuddy 官方市场全量目录同步（wb.http 门面 · 登录态走官方 UI 的鉴权链路）。
 *
 * 前置：WorkBuddy 以调试端口启动（Electron 主进程带 --remote-debugging-port=9222），
 *       登录态由官方自己的 wb.http (preload bridge) 注入 —— 本脚本不碰 token。
 * 输出：~/.dsh/workbuddy-summon/cache/market/experts.json
 *       { version, syncedAt, total, experts:[插件目录映射后的条目] }
 * 断点续传：~/.dsh/workbuddy-summon/cache/market/.sync-progress.json
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEBUG = process.env.WB_CDP ?? "http://127.0.0.1:9222";
const OUT_DIR = join(homedir(), ".dsh/workbuddy-summon/cache/market");
const OUT = join(OUT_DIR, "experts.json");
const PROGRESS = join(OUT_DIR, ".sync-progress.json");
const ENDPOINT = "/portal/operation-platform/market/expert/list";
const PAGE_SIZES = [200, 100]; // 从大到小试上限

const targets = await (await fetch(`${DEBUG}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (page === undefined) throw new Error("WorkBuddy CDP 上没有任何 page target —— 应用是否以 9222 启动并完成预载？");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const send = (m, p = {}) => new Promise((res, rej) => { const mid = ++id; ws.send(JSON.stringify({ id: mid, method: m, params: p })); const h = (ev) => { const d = JSON.parse(ev.data); if (d.id === mid) { ws.removeEventListener("message", h); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); } }; ws.addEventListener("message", h); });
const evalJs = (expr) => send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description ?? "");

/** renderer 里批量调 wb.http.post：一次 evaluate 拉一页并 JSON 串回 */
const fetchPage = async (body) => {
	const js = `wb.http.post(${JSON.stringify(ENDPOINT)}, ${JSON.stringify(body)}, {}).then(v=>JSON.stringify(v)).catch(e=>'ERRM '+(e&&e.message||e))`;
	const out = await evalJs(js);
	if (typeof out !== "string" || out.startsWith("ERRM")) throw new Error(`page fetch failed: ${String(out).slice(0, 120)}`);
	return JSON.parse(out);
};

const callPage = async (body) => {
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			return await fetchPage(body);
		} catch (e) {
			if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
			else throw e;
		}
	}
};

mkdirSync(OUT_DIR, { recursive: true });

let pageSize = Number(JSON.parse(existsSync(PROGRESS) ? readFileSync(PROGRESS, "utf8") : "0").pageSize ?? 0);
if (!PAGE_SIZES.includes(pageSize)) {
	const js = `wb.http.post(${JSON.stringify(ENDPOINT)}, {"page_size":200,"page":1}, {}).then(v=>(v&&v.data&&v.data.experts||[]).length).catch(e=>'ERR '+(e&&e.message||e))`;
	const n = String(await evalJs(js));
	pageSize = n.startsWith("200") ? 200 : 100;
	if (n.startsWith("ERR")) throw new Error(`page_size 探测失败（wb.http 未就绪？登录态缺失？）: ${n.slice(0, 160)}`);
}

const mapEntry = (e) => ({
	id: e.expert_id,
	plugin: e.plugin_id,
	expertType: e.expert_type === "team" ? "team" : "agent",
	agentName: e.agent_name,
	displayName: { zh: e.display_name_zh ?? "" },
	profession: { zh: e.profession_zh ?? "" },
	description: { zh: e.description_zh ?? "" },
	quickPrompts: (e.quick_prompts ?? []).slice(0, 1).map((p) => ({ zh: p.zh ?? "" })),
	avatar: e.icon ?? null,
	sourceId: e.source_id ?? e.expert_id,
	pluginVersion: e.plugin_version,
	lifecycle: e.lifecycle_status,
	marketSource: e.source,
});

let total = 0;
let merged = new Map(); // expert_id -> entry（续传合并）
let version = "0.1.3";
let syncedAt = new Date().toISOString();
if (existsSync(OUT)) {
	try {
		const prev = JSON.parse(readFileSync(OUT, "utf8"));
		for (const e of prev.experts ?? []) merged.set(e.id, e);
		if (prev.version) version = prev.version;
	} catch {}
}
if (existsSync(PROGRESS)) {
	try {
		const p = JSON.parse(readFileSync(PROGRESS, "utf8"));
		for (const e of p.partial ?? []) merged.set(e.id, e);
	} catch {}
}
console.log(`[sync] 起始本地已有 ${merged.size} 条，page_size=${pageSize}`);

const probe = await callPage({ page: 1, page_size: pageSize });
total = probe?.data?.total_count ?? 40221;
console.log(`[sync] total_count=${total}`);

const expectedPages = Math.ceil(total / pageSize);
for (let pNum = 1; pNum <= expectedPages + 5; pNum += 1) {
	const res = await callPage({ page: pNum, page_size: pageSize });
	const list = res?.data?.experts ?? [];
	let added = 0;
	for (const raw of list) {
		const entry = mapEntry(raw);
		if (entry.id && !merged.has(entry.id)) { merged.set(entry.id, entry); added += 1; }
	}
	if (pNum % 5 === 0 || pNum === expectedPages) {
		console.log(`[sync] page ${pNum}/${expectedPages} +${added} 累计 ${merged.size}/${total}`);
		writeFileSync(PROGRESS, JSON.stringify({ pageSize, partial: [...merged.values()] }));
	}
	if (list.length === 0) break;
}

const experts = [...merged.values()];
writeFileSync(OUT, JSON.stringify({ version, syncedAt, total, experts }, null, 1));
try { rmSync(PROGRESS, { force: true }); } catch {}
console.log(`[SYNC DONE] ${experts.length} 条 → ${OUT}`);
process.exit(0);
