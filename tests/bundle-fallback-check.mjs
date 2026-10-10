/**
 * 新包 tar.gz 回退源的回归：
 *   node tests/bundle-fallback-check.mjs            # 离线（只查策略与代码契约）
 *   node tests/bundle-fallback-check.mjs --online   # 联网实测真实取包
 *
 * 背景：2026-06 之后进市场的包不在公开 COS 的 `plugins/<p>/` 下（老包才在那里），
 * 正文只能从官方留的无签名回退源 `<COS_BASE>/bundles/<plugin>.tar.gz` 取。
 * 契约：① 老包仍走逐文件路径；② 新包 manifest 拿不到时才整包兜底，且只兜一次；
 *       ③ 兜底成功落 `.bundle-fetched` 标记，二次不再下载。
 */
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

let fails = 0;
const ok = (label, cond, extra = "") => { if (!cond) fails += 1; console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`); };

const src = readFileSync(new URL("../lib/catalog.js", import.meta.url), "utf8");

/* ── 契约断言（离线） ── */
ok("存在 fetchBundle 且指向 bundles/<p>.tar.gz", /bundles\/\$\{plugin\}\.tar\.gz/.test(src));
ok("bundle 只在 manifest 缺失时触发（不逐文件白试）", /parseJsonSafe\(manifestText\) === undefined[\s\S]{0,200}fetchBundle/.test(src));
ok("整包兜底后有 noBundle 防止重复下载", /noBundle: true/.test(src));
ok("用标记文件做幂等", /\.bundle-fetched/.test(src));
ok("解包走系统 tar（Electron 无内置 tar）", /execFileSync\("tar"/.test(src));
// 注意：不能比较全文件索引 —— fetchBundle 是函数定义，必然排在 pkgFile 之前。
// 要验的是「pkgFile 体内的调用顺序」，下一段已经覆盖它。
{
	const inPkgFile = src.slice(src.indexOf("async function pkgFile("), src.indexOf("function parseJsonSafe("));
	ok("老包逐文件路径在 pkgFile 内先于 bundle 回落", inPkgFile.indexOf("`${COS_BASE}/plugins/${plugin}/${rel}`") < inPkgFile.indexOf("fetchBundle(plugin, opts)"));
}

/* ── 决策链：pkgFile 里老路径失败才轮到 bundle ── */
const pkgFileBody = src.slice(src.indexOf("async function pkgFile("), src.indexOf("function parseJsonSafe("));
ok("pkgFile 先试 plugins/ 再回落 bundle", pkgFileBody.indexOf("/plugins/${plugin}/${rel}") < pkgFileBody.indexOf("fetchBundle(plugin, opts)"));
ok("noBundle 能关掉回落（供内部二次调用）", /opts\.noBundle !== true/.test(pkgFileBody));

/* ── 联网实测 ── */
if (process.argv.includes("--online")) {
	const { loadPackage } = await import("../lib/catalog.js");
	const PKG = join(homedir(), ".dsh/workbuddy-summon/cache/packages");
	console.log("\n  联网实测：");
	// 新包（必须走 tar.gz 回退）
	for (const p of ["ai-humanizer", "content-writer"]) {
		rmSync(join(PKG, p), { recursive: true, force: true });
		const t = Date.now();
		const k = await loadPackage(p);
		ok(`新包 ${p} 冷启动可召回`, !!k?.manifest, `${k?.agentNames?.length ?? 0} agents, ${Date.now() - t}ms`);
		ok(`  · 留下 .bundle-fetched 标记`, existsSync(join(PKG, p, ".bundle-fetched")));
		const t2 = Date.now();
		await loadPackage(p);
		ok(`  · 二次读命中缓存（<300ms）`, Date.now() - t2 < 300, `${Date.now() - t2}ms`);
	}
	// 老包（本机有镜像，不该被新逻辑影响）
	for (const p of ["humanize-ppt-team", "novel-workshop-pro"]) {
		const k = await loadPackage(p);
		ok(`老包 ${p} 不受影响`, !!k?.manifest && k.agentNames.length > 0, `${k?.agentNames?.length ?? 0} agents`);
	}
}

console.log(fails === 0 ? "\n== 全部通过：新包有回退源、老包路径未变 ==" : `\n== ${fails} 项失败 ==`);
process.exit(fails === 0 ? 0 : 1);
