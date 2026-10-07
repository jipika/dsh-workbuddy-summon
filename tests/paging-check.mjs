import { EventEmitter } from "node:events";
const calls = { tools: [] };
const ctx = {
	effect: (f) => { const d = f(); return typeof d === "function" ? d : () => {}; },
	on: () => () => {},
	systemPrompt: { section: () => () => {} },
	tools: { register: (d) => { calls.tools.push(d); return () => {}; } },
	webServer: { register: () => () => {} },
	agents: { currentInitiator: () => ({ sessionId: "pg" }) },
	logger: { info() {}, warn() {} },
};
const m = await import("../index.js");
await m.apply(ctx, { warmCatalog: false });
const read = calls.tools.find((t) => t.name === "wb_expert_read");

// 1) 清单
const list = await read.execute({ plugin: "novel-workshop-pro" });
console.log(`清单：lead=${list.lead} agents=${list.agents.length} skills=${list.skills.length}`);
const sk = list.skills[0];
console.log(`  skill "${sk.name}": refs=${sk.references.length} 首个=${sk.references[0]}`);

// 2) 技能正文分页：必须分段且能续读完
let from;
let total = 0;
let pages = 0;
let guard = 0;
for (;;) {
	const r = await read.execute({ plugin: "novel-workshop-pro", skill: sk.name, ...(from ? { from } : {}) });
	pages += 1;
	total += r.text.length;
	if (r.nextFrom === null || r.nextFrom === undefined) {
		console.log(`  正文分页：${pages} 段共 ${total} 字符，totalChars=${r.totalChars} truncated=${r.truncated} ${total === r.totalChars ? "✓ 可完整续读" : "✗ 长度不吻合"}`);
		break;
	}
	from = r.nextFrom;
	if (++guard > 12) { console.log("  ✗ 续读未收敛"); process.exit(1); }
}

// 3) ref 取用
const ref = await read.execute({ plugin: "novel-workshop-pro", skill: sk.name, ref: sk.references[3] });
console.log(`  ref=${ref.ref} → ${ref.text?.length ?? 0} 字符 ${ref.text ? "✓" : "✗"} truncated=${ref.truncated}`);
const badRef = await read.execute({ plugin: "novel-workshop-pro", skill: sk.name, ref: "references/查无此文件.md" });
console.log(`  不存在的 ref → error="${badRef.error}" 回列表 ${(badRef.available ?? []).length} 项 ${badRef.error ? "✓" : "✗"}`);
const traversal = await read.execute({ plugin: "novel-workshop-pro", skill: sk.name, ref: "../../../etc/passwd" });
console.log(`  路径穿越 → ${traversal.text === undefined ? "✓ 已拒绝" : "✗ 竟然取到了！"}`);

// 4) 成员分页
const mem = await read.execute({ plugin: "design-engine", agent: "prototype-builder" });
console.log(`  成员正文：${mem.text.length} 字符 nextFrom=${mem.nextFrom} ${mem.nextFrom === null ? "✓ 单段够" : "需续读"}`);
