/**
 * 头像层验证（实时代理，无本地图片资产）。
 *   node tests/avatar-check.mjs
 * 断言：三类 ref 都能实时取到；尺寸归一；并发合并；非法 ref 与缺失安全降级；
 *       同一 key 第二次命中内存缓存（note=mem）。
 */
import { loadCatalog, entryView } from "../lib/catalog.js";
import { getAvatar, AVATAR_SIZES } from "../lib/avatars.js";

const views = (await loadCatalog({})).entries.map(entryView);
const withAvatar = views.filter((v) => typeof v.avatar === "string" && v.avatar.length > 0);
console.log(`条目 ${views.length}｜带 avatar ${withAvatar.length}｜档位 ${AVATAR_SIZES.join("/")}`);

const kind = (a) => (a.startsWith("/avatars/") ? "市场根" : a.startsWith("/plugins/") ? "包内" : "本机相对");
const byKind = new Map();
for (const v of withAvatar) byKind.set(kind(v.avatar), (byKind.get(kind(v.avatar)) ?? 0) + 1);
console.log("形态分布:", [...byKind.entries()].map(([k, n]) => `${k} ${n}`).join("｜"));

console.log("\n三类各取一张（64px）：");
for (const want of ["市场根", "包内", "本机相对"]) {
	const v = withAvatar.find((x) => kind(x.avatar) === want);
	if (v === undefined) { console.log(`  （无 ${want} 样例）`); continue; }
	const r = await getAvatar(v, 64, { plugin: v.plugin });
	console.log(`  ${r.status === 200 ? "✓" : "✗"} ${want.padEnd(6)} ${v.plugin.padEnd(24)} ${r.status} ${(r.data.length / 1024).toFixed(1)}KB note=${r.note} ${r.mime}`);
}

console.log("\n内存缓存（同 key 第二次应 note=mem）：");
const v0 = withAvatar.find((x) => x.avatar.startsWith("/avatars/"));
const a = await getAvatar(v0, 64, { plugin: v0.plugin });
const b = await getAvatar(v0, 64, { plugin: v0.plugin });
console.log(`  第一次 note=${a.note}｜第二次 note=${b.note} ${b.note === "mem" ? "✓" : "✗"}`);

console.log("\n并发合并（同一张 8 路并发，应只回源一次）：");
const v1 = withAvatar.find((x) => x.avatar.startsWith("/plugins/")) ?? v0;
const rs = await Promise.all(Array.from({ length: 8 }, () => getAvatar(v1, 96, { plugin: v1.plugin })));
console.log(`  ${rs.every((r) => r.status === 200) ? "✓" : "✗"} 8 个请求全部 200，note 集合 = ${[...new Set(rs.map((r) => r.note))].join(",")}`);

console.log("\n成员头像（专家团 members[].avatar）：");
const team = withAvatar.find((v) => v.expertType === "team" && (v.members ?? []).some((m) => m.avatar));
if (team) {
	const m = team.members.find((x) => x.avatar);
	const r = await getAvatar(team, 64, { plugin: team.plugin, agent: m.id });
	console.log(`  ${r.status === 200 ? "✓" : "✗"} ${team.plugin} / ${m.id} → ${r.status} ${(r.data.length / 1024).toFixed(1)}KB`);
}

console.log("\n尺寸归一：");
for (const s of [1, 40, 64, 100, 200, 9999, Number.NaN]) {
	const r = await getAvatar(v0, s, { plugin: v0.plugin });
	console.log(`  size=${String(s).padStart(5)} → ${r.status} ${(r.data.length / 1024).toFixed(1)}KB`);
}

console.log("\n边界与安全：");
const cases = [
	["entry 缺失", await getAvatar(undefined, 64, {})],
	["avatar=null", await getAvatar({ avatar: null }, 64, {})],
	["路径穿越", await getAvatar({ avatar: "/avatars/../../etc/passwd" }, 64, {})],
	["非图片扩展名", await getAvatar({ avatar: "/avatars/x.txt" }, 64, {})],
	["未知包", await getAvatar({ avatar: "/avatars/__NoSuchExpert__.png" }, 64, {})],
];
for (const [label, r] of cases) {
	const okReject = r.status !== 200 || r.data.length === 0;
	console.log(`  ${okReject ? "✓" : "✗"} ${label.padEnd(14)} → ${r.status} ${r.note} ${(r.data.length / 1024).toFixed(1)}KB`);
}

console.log("\n全量抽样（每 20 条取 1，统计成功率与体积）：");
let ok = 0, failN = 0, bytes = 0;
const fails = [];
for (let i = 0; i < withAvatar.length; i += 20) {
	const v = withAvatar[i];
	const r = await getAvatar(v, 64, { plugin: v.plugin });
	if (r.status === 200 && r.data.length > 64) { ok += 1; bytes += r.data.length; }
	else { failN += 1; fails.push(`${v.plugin}(${r.note})`); }
}
console.log(`  ✓ ${ok}｜✗ ${failN}｜平均 ${(bytes / Math.max(1, ok) / 1024).toFixed(1)}KB`);
if (fails.length) console.log("  失败样例:", fails.slice(0, 6).join(" "));
