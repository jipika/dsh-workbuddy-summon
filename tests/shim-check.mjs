/**
 * 垫片安装的安全边界验证（全程在临时 HOME 里跑，绝不碰真实 PATH）。
 *   node tests/shim-check.mjs
 * 断言：首次安装 → 幂等不动盘 → 更新覆盖自己装的 → **他人文件一律跳过** →
 *       无可写目录时安全失败 → 依赖检测给出可执行安装指引。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const SRC = join(homedir(), ".dsh/local-plugins/dsh-workbuddy-summon");
const realPath = process.env.PATH;
const realHome = process.env.HOME;
const tmpDirs = [];
let fails = 0;
const ok = (label, cond, extra = "") => { if (!cond) fails += 1; console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`); };

function freshEnv() {
	const home = mkdtempSync(join(tmpdir(), "wbshim-"));
	tmpDirs.push(home);
	const bin = join(home, ".local/bin");
	mkdirSync(bin, { recursive: true });
	process.env.HOME = home;
	process.env.PATH = `${join(home, ".workbuddy/bin")}:${bin}`;
	return { home, bin };
}
async function loadFresh() {
	// 每次重新导入：模块内 BIN_DIR 由 import.meta.url 定死，但落点靠 env，所以换 env 即换行为
	const mod = await import(`../lib/shims.js?v=${Math.random()}`);
	return mod;
}
const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);

console.log("① 首次安装");
{
	const { bin } = freshEnv();
	const { installShims } = await loadFresh();
	const r = installShims({});
	ok("落点选中 ~/.local/bin", r.dir === bin, String(r.dir));
	ok("装上 westock-data", existsSync(join(bin, "westock-data")));
	ok("装上 westock-tool", existsSync(join(bin, "westock-tool")));
	ok("权限可执行", (statSync(join(bin, "westock-data")).mode & 0o111) !== 0);
	ok("内容与源一致", readFileSync(join(bin, "westock-data"), "utf8") === readFileSync(join(SRC, "bin/westock-data"), "utf8"));

	console.log("\n② 幂等（第二次不应动盘）");
	const t1 = mtime(join(bin, "westock-data"));
	const { installShims: again } = await loadFresh();
	const r2 = again({});
	ok("unchanged 命中", r2.unchanged.includes("westock-data"), JSON.stringify(r2.unchanged));
	ok("mtime 未变", mtime(join(bin, "westock-data")) === t1);

	console.log("\n③ 源更新 → 覆盖自己装的");
	writeFileSync(join(bin, "westock-data"), "#!/usr/bin/env bash\n# shim-of: dsh-workbuddy-summon\n# 旧版本\n");
	const { installShims: third } = await loadFresh();
	const r3 = third({});
	ok("updated 命中", r3.updated.includes("westock-data"), JSON.stringify(r3.updated));
	ok("已刷新为最新内容", readFileSync(join(bin, "westock-data"), "utf8").includes("WorkBuddy 专家包的命令兼容垫片"));

	console.log("\n④ 他人文件必须跳过（最关键的一条）");
	writeFileSync(join(bin, "westock-tool"), "#!/bin/sh\necho '别人家的 westock-tool'\n");
	chmodSync(join(bin, "westock-tool"), 0o755);
	const foreign = readFileSync(join(bin, "westock-tool"), "utf8");
	const { installShims: fourth } = await loadFresh();
	const r4 = fourth({});
	ok("skipped 命中 westock-tool", r4.skipped.includes("westock-tool"), JSON.stringify(r4.skipped));
	ok("他人内容未被覆盖", readFileSync(join(bin, "westock-tool"), "utf8") === foreign);

	console.log("\n⑤ 无可写目录 → 安全失败不抛异常");
	// 注意：不能拿「不存在的 HOME」当不可写 —— writableDir 的 mkdirSync(recursive)
	// 会把它整个建出来，那是可写的。必须用真实只读目录。
	const ro = mkdtempSync(join(tmpdir(), "wbreadonly-"));
	tmpDirs.push(ro);
	chmodSync(ro, 0o500);
	process.env.HOME = ro;
	process.env.PATH = ro;
	const { installShims: fifth } = await loadFresh();
	let threw = false;
	try { const rr = fifth({}); ok("返回而非抛错", rr.dir === undefined); } catch { threw = true; }
	ok("未抛异常", !threw);

	console.log("\n⑥ 依赖检测");
	process.env.HOME = realHome;
	process.env.PATH = realPath;
	const { checkShimDeps } = await loadFresh();
	const deps = checkShimDeps();
	for (const d of deps) ok(`${d.name} 检测结果有指引`, typeof d.hint === "string" && d.hint.length > 10, `ok=${d.ok}`);
	const westock = deps.find((d) => d.name === "westock");
	ok("westock 在本机已就位", westock?.ok === true, "若为 false 说明 hasInPath 判定有问题");
}

// 收尾：只读目录要先放开权限才能删
for (const d of tmpDirs) {
	try { chmodSync(d, 0o700); } catch { /* 已可写 */ }
	rmSync(d, { recursive: true, force: true });
}
console.log(fails === 0 ? "\nSHIM 全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
