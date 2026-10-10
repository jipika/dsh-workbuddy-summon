/* 抽 client.js 里的样式数组 → 做括号/声明级校验（不装依赖的轻量解析） */
import { readFileSync } from "node:fs";
const src = readFileSync("/Users/lixiongwei/.dsh/local-plugins/dsh-workbuddy-summon/lib/client.js", "utf8");
// 抓 installStyle 里的 backtick 字符串数组
const block = src.slice(src.indexOf("el.textContent = ["), src.indexOf("].join(\"\\n\")"));
const rules = [...block.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
console.log(`规则条数: ${rules.length}`);
let bad = 0;
for (const r of rules) {
	const open = (r.match(/\{/g) ?? []).length, close = (r.match(/\}/g) ?? []).length;
	if (open !== close) { console.log(`✗ 花括号不配平 (${open}/${close}): ${r.slice(0, 80)}`); bad++; }
	if (r.includes("undefined")) { console.log(`✗ 含 undefined: ${r.slice(0, 80)}`); bad++; }
}
const all = rules.join("\n");
// 关键断言
const need = [
	["ease-in 已绝迹", !/ease-in\b/.test(all)],
	["无 transition: all", !/transition:\s*all/.test(all)],
	["无 scale(0) 入场", !/scale\(0\)/.test(all)],
	["面板用 transition 而非 keyframes 做进出场", /transition:opacity var\(--wb-dur-base\)/.test(all) && !/animation:wbsum-in/.test(all)],
	["有 @starting-style 入场前值", /@starting-style\{\.wbsum-panel/.test(all)],
	["退场时长 110ms（快于入场 150ms）", /\.wbsum-panel\[data-state="closing"\]\{[^}]*transition-duration:110ms/.test(all)],
	["按压反馈 :active 存在", (all.match(/:active\{transform:scale\(\.9[0-9]\)\}/g) ?? []).length >= 4],
	["reduced-motion 保留透明度、去掉位移", /prefers-reduced-motion: reduce\)\{\.wbsum-panel\{transition:opacity/.test(all)],
	["动效 token 未写进 :root", !/:root/.test(all)],
	["时长均 < 300ms", !/(^|[^\d])([3-9]\d\d|\d{4,})ms/.test(all.replace(/160ms|140ms|150ms|120ms|110ms|200ms|260ms|3000ms|4000ms|1\.6s|\.12s/g, ""))],
];
for (const [name, ok] of need) { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) bad++; }
console.log(bad === 0 ? "\n== CSS 审计全部通过 ==" : `\n== ${bad} 项失败 ==`);
process.exit(bad === 0 ? 0 : 1);
