/**
 * 兼容垫片的自动安装。
 *
 * 背景：WorkBuddy 金融类专家包的成员 prompt 里调用 `westock-data` / `westock-tool`，
 * 而这两个名字在 WorkBuddy 里只是**技能目录名**（技能文档通篇用 `westock <子命令>`），
 * 系统 PATH 里并不存在。插件自带垫片（bin/），启动时装进 PATH，让专家包不改一个字就能跑。
 *
 * 安全边界（重要）：
 *   · 只覆盖带 `shim-of: dsh-workbuddy-summon` 标记的文件 —— 目标位置若被别的工具或用户
 *     占着，一律跳过并告警，绝不静默覆盖；
 *   · 只在内容变化时写盘（幂等，不每次启动都动文件系统）；
 *   · 不代装第三方 CLI（官方 `westock` 本体是腾讯发布的 9MB 二进制），只检测并提示。
 */
import {
	accessSync,
	chmodSync,
	copyFileSync,
	constants,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "shim-of: dsh-workbuddy-summon";
const BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");

const log = (msg) => console.log(`[dsh-workbuddy-summon] ${msg}`);

function isFile(p) {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

/** 垫片源文件清单（插件 bin/ 下的全部可执行脚本）。 */
function shimSources() {
	let names;
	try {
		names = readdirSync(BIN_DIR);
	} catch {
		return [];
	}
	return names.map((name) => join(BIN_DIR, name)).filter(isFile);
}

/** 目录存在（或可创建）且可写。用一次真实写探针，比 accessSync 可靠。 */
function writableDir(dir) {
	try {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		if (!statSync(dir).isDirectory()) return false;
		const probe = join(dir, `.dsh-wbsummon-probe-${process.pid}`);
		writeFileSync(probe, "");
		rmSync(probe, { force: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * 选落点：优先 ~/.local/bin（本机实测已在 PATH 且用户可写），
 * 否则取 PATH 里第一个可写目录（跳过 fnm_multishells 这类随 shell 失效的软链）。
 */
function pickTargetDir() {
	const home = process.env.HOME ?? "";
	if (home.length > 0) {
		const preferred = join(home, ".local/bin");
		if (writableDir(preferred)) return preferred;
	}
	for (const dir of String(process.env.PATH ?? "").split(":")) {
		if (dir.length === 0 || dir.includes("fnm_multishells")) continue;
		if (writableDir(dir)) return dir;
	}
	return undefined;
}

/** 目标位置是否由本插件所装（认标记，不认路径）。 */
function ownedByUs(path) {
	try {
		return readFileSync(path, "utf8").includes(MARKER);
	} catch {
		return false;
	}
}

function sameContent(a, b) {
	try {
		return readFileSync(a).equals(readFileSync(b));
	} catch {
		return false;
	}
}

/**
 * 安装全部垫片到 PATH。
 * @param {{dryRun?: boolean}} [opts]
 */
export function installShims(opts = {}) {
	const result = { dir: undefined, installed: [], unchanged: [], updated: [], skipped: [], failed: [] };
	const sources = shimSources();
	if (sources.length === 0) return result;

	const dir = pickTargetDir();
	if (dir === undefined) {
		log(`⚠ 找不到可写的 PATH 目录，垫片未安装：${sources.map((s) => s.split("/").pop()).join(", ")}`);
		result.failed.push(...sources.map((s) => s.split("/").pop()));
		return result;
	}
	result.dir = dir;

	for (const src of sources) {
		const name = src.split("/").pop();
		const dest = join(dir, name);
		if (existsSync(dest) && !ownedByUs(dest)) {
			result.skipped.push(name);
			log(`⚠ ${dest} 已存在且不是本插件所装，跳过（不覆盖他人文件）`);
			continue;
		}
		if (existsSync(dest) && sameContent(src, dest)) {
			result.unchanged.push(name);
			continue; // 幂等：内容一致不动盘
		}
		if (opts.dryRun === true) {
			result.installed.push(name);
			continue;
		}
		try {
			copyFileSync(src, dest);
			chmodSync(dest, 0o755);
			result.updated.push(name);
		} catch (error) {
			result.failed.push(name);
			log(`⚠ 安装 ${name} 失败：${error?.message ?? error}`);
		}
	}
	if (result.updated.length > 0) log(`垫片 → ${dir}：${result.updated.join(", ")}`);
	return result;
}

/** 某命令是否已在 PATH 上可执行。 */
function hasInPath(cmd) {
	for (const dir of String(process.env.PATH ?? "").split(":")) {
		if (dir.length === 0) continue;
		if (isFile(join(dir, cmd))) {
			try {
				accessSync(join(dir, cmd), constants.X_OK);
				return true;
			} catch {
				/* 不可执行，继续找 */
			}
		}
	}
	return false;
}

/**
 * 检测垫片依赖的外部 CLI 是否就位（不代装：那是腾讯发布的二进制，有官方安装脚本）。
 * @returns {{name: string, ok: boolean, hint: string}[]}
 */
export function checkShimDeps() {
	return [
		{
			name: "westock",
			ok: hasInPath("westock"),
			hint: "bash ~/.workbuddy/plugins/marketplaces/cb_teams_marketplace/plugins/finance-data/skills/westock-data/scripts/setup.sh -y",
		},
		{ name: "node", ok: hasInPath("node"), hint: "westock-tool 垫片需要 node ≥ 18" },
	];
}
