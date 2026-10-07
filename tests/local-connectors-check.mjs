/**
 * 本地连接器注册表全链路验证：
 *   CRUD 校验 → 目录合并（source:"local"，stdio 不探测）→ 接入挂载（stdio config、
 *   mountTimeoutMs 透传、落盘不含 config）→ 重启恢复 → 删除后目录同步消失。
 *   node tests/local-connectors-check.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const home = mkdtempSync(join(tmpdir(), "wblocal-"));
process.env.HOME = home;
process.env.DSH_PROFILE_DIR = join(home, "profiles", "probe");
mkdirSync(join(home, ".dsh/workbuddy-summon"), { recursive: true });
const P = "/Users/lixiongwei/.dsh/local-plugins/dsh-workbuddy-summon";
const LC = await import(P + "/lib/local-connectors.js");
const { loadConnectors, connectorView } = await import(P + "/lib/connectors.js");
const { classify } = await import(P + "/lib/connector-probe.js");
const CS = await import(P + "/lib/connector-session.js");

let fails = 0;
const ok = (l, c, e = "") => { if (!c) fails += 1; console.log(`  ${c ? "✓" : "✗"} ${l}${e ? ` — ${e}` : ""}`); };

// ① CRUD：缺 command 拒绝；正常添加；中文名 slug 兜底 hash；撞名加短 hash
const bad = LC.addLocal({ name: "x" });
ok("缺 command 拒绝", bad.ok === false && /command/.test(bad.error), bad.error ?? "");
const r1 = LC.addLocal({ name: "企微文档检索", command: "npx", args: "-y doc-hub-mcp@latest", description: "冒烟" });
ok("添加成功", r1.ok === true, r1.error ?? "");
ok("中文 id 兜底 local-<hash>", /^local-[0-9a-f]{6}$/.test(r1.entry.id), r1.entry.id);
ok("stdio 传输", r1.entry.transportKind === "stdio" && r1.entry.servers[0]?.transport === "stdio");
ok("args 切分正确", JSON.stringify(r1.entry.servers[0].args) === JSON.stringify(["-y", "doc-hub-mcp@latest"]), JSON.stringify(r1.entry.servers[0].args));
ok("默认放宽挂载超时 180s", r1.entry.mountTimeoutMs === 180_000, String(r1.entry.mountTimeoutMs));
ok("source=local 标记", r1.entry.source === "local");
const r2 = LC.addLocal({ name: "企微文档检索", command: "node", args: "/tmp/a.mjs" });
ok("同名自动加短 hash 后缀", r2.ok === true && r2.entry.id !== r1.entry.id, r2.entry?.id ?? r2.error);
const r3 = LC.addLocal({ name: "npx", command: "npx" });
ok("slug 化 id 可直接得到", r3.ok === true && r3.entry.id === "npx", r3.entry?.id ?? r3.error);
ok("本地共 3 条", LC.localCount() === 3, String(LC.localCount()));

// ② 落盘是声明不是凭据实例：env 写 ${TOKEN} 原样存
const r4 = LC.addLocal({ name: "env-t", command: "npx", env: { API_KEY: "${MY_TOKEN}" } });
const disk = readFileSync(join(home, ".dsh/workbuddy-summon/local-connectors.json"), "utf8");
ok("env 占位原样落盘", disk.includes("${MY_TOKEN}"));
ok("entry.env 保留占位", r4.entry.servers[0].env.API_KEY === "${MY_TOKEN}");

// ③ 分类：stdio 本地条目 → unverified，绝不自动探测
const acc = classify(r1.entry);
ok("本地 stdio → unverified", acc.level === "unverified", JSON.stringify(acc));

// ④ 目录合并：loadConnectors 里能看到本地条目，在线条目不丢
const cat = await loadConnectors({ fresh: false });
ok("合并后 byId 含本地条目", cat.byId.get(r1.entry.id) !== undefined);
ok("合并后在线条目仍在（catalog>100）", cat.connectors.length > 100, String(cat.connectors.length));
ok("本地条目 connectorView 带 command", connectorView(cat.byId.get(r1.entry.id)).command === "npx");
ok("localCount 字段", cat.localCount === 4, String(cat.localCount));

// ⑤ withLocal 单测：同 id 本地覆盖在线
const fakeOnline = { id: "npx", name: "在线同名", servers: [], connectors: [], byId: new Map([["npx", { id: "npx", name: "在线同名", servers: [] }]]) };
const merged = LC.withLocal(fakeOnline);
ok("同 id 本地优先", merged.byId.get("npx")?.name === "npx", merged.byId.get("npx")?.name);
ok("合并返回新对象不动缓存", fakeOnline.connectors.length === 0);

// ⑥ 会话接入：本地条目走 connectInSession，stdio config + mountTimeoutMs 透传
CS.bindMcpClient({ name: "mcp-client", inject: [], apply() {} });
let mountedConfig = null;
const agent = {
	id: "sess-local",
	ctx: {
		plugin(_mod, config) {
			mountedConfig = config;
			return Object.assign(Promise.resolve(), { dispose: async () => {} });
		},
	},
};
const c1 = cat.byId.get(r1.entry.id);
const inst = await CS.connectInSession({ id: c1.id, name: c1.name, servers: c1.servers, mountTimeoutMs: c1.mountTimeoutMs }, agent);
ok("接入返回 stdio serverName", inst.serverName === r1.entry.id, inst.serverName);
ok("挂载 config 是 stdio", mountedConfig?.transport === "stdio" && mountedConfig.command === "npx", JSON.stringify(mountedConfig ?? {}));
ok("挂载 config 超时放宽", mountedConfig?.toolCallTimeoutMs === 60_000, String(mountedConfig?.toolCallTimeoutMs));
const rows = CS.listForSession("sess-local");
ok("意图行带 mountTimeoutMs", rows[0]?.mountTimeoutMs === 180_000, JSON.stringify(rows[0]));
const sessDisk = readFileSync(join(home, ".dsh/workbuddy-summon/session-connectors.json"), "utf8");
ok("落盘不含 config", !sessDisk.includes('"config"'));
ok("落盘含 mountTimeoutMs 标量", sessDisk.includes('"mountTimeoutMs"'));

// ⑦ ${VAR} 求值：env 占位缺变量 → missingEnv 报告，值置空
process.env.MY_TOKEN = "secret-value";
const { buildMcpConfig } = await import(P + "/lib/connector-session.js");
const built = buildMcpConfig(cat.byId.get(r4.entry.id), "env_t");
ok("env 占位求值成功", built.config.env?.API_KEY === "secret-value" && built.missing.length === 0, JSON.stringify(built));
delete process.env.MY_TOKEN;
const built2 = buildMcpConfig(cat.byId.get(r4.entry.id), "env_t");
ok("缺变量进 missing 报告", built2.missing.includes("MY_TOKEN") && built2.config.env.API_KEY === "", JSON.stringify(built2.missing));

// ⑧ 重启恢复：restoreForSession 按 connectorId 从合并目录重建本地挂载
CS.forgetSession("sess-local");
const byId = new Map([...cat.connectors].map((c) => [c.id, c]));
const rr = await CS.restoreForSession({ id: "sess-local", ctx: agent.ctx }, byId);
ok("恢复本地条目成功", rr.restored.includes(r1.entry.id) && rr.failed.length === 0, JSON.stringify(rr));

// ⑨ 编辑：updateLocal 改字段 / 空命令拒绝 / 不存在报错 / id 不变
const u0 = LC.updateLocal("不存在", { command: "node" });
ok("编辑不存在的 id 报错", u0.ok === false && /没有 id/.test(u0.error), u0.error ?? "");
const u1 = LC.updateLocal(r2.entry.id, { command: "", name: "x" });
ok("空命令拒绝", u1.ok === false && /command/.test(u1.error), u1.error ?? "");
const u2 = LC.updateLocal(r2.entry.id, {
	name: "改过名",
	command: "node",
	args: "a.mjs --watch",
	env: { A: "${TOKEN_A}" },
	description: "新描述",
});
ok("编辑成功", u2.ok === true, u2.error ?? "");
ok("编辑后 id 不变", u2.entry.id === r2.entry.id, u2.entry.id);
ok("编辑后 args 切分", JSON.stringify(u2.entry.servers[0].args) === JSON.stringify(["a.mjs", "--watch"]), JSON.stringify(u2.entry.servers[0].args));
ok("编辑后 env 更新", u2.entry.servers[0].env.A === "${TOKEN_A}", JSON.stringify(u2.entry.servers[0].env));
ok("编辑后 name 更新", u2.entry.name === "改过名", u2.entry.name);
const u3 = LC.updateLocal(r2.entry.id, { description: "只改描述" });
ok("局部更新保留其它字段", u3.ok === true && u3.entry.name === "改过名" && u3.entry.servers[0].command === "node" && u3.entry.description === "只改描述", JSON.stringify({ n: u3.entry?.name, c: u3.entry?.servers?.[0]?.command, d: u3.entry?.description }));
const catU = await loadConnectors({ fresh: false });
ok("编辑后目录同步", catU.byId.get(r2.entry.id)?.name === "改过名");

// ⑩ 删除后目录同步消失
ok("删除返回 true", LC.removeLocal(r1.entry.id) === true);
ok("删不存在返回 false", LC.removeLocal(r1.entry.id) === false);
const cat2 = await loadConnectors({ fresh: false });
ok("删除后 byId 不再含", cat2.byId.get(r1.entry.id) === undefined);
ok("其余仍在", cat2.byId.get(r2.entry.id) !== undefined);

// 清理
for (const id of [r1.entry.id, r2.entry.id, r3.entry.id, r4.entry.id]) LC.removeLocal(id);
try { rmSync(home, { recursive: true, force: true }); } catch { }
console.log(fails === 0 ? "\nLOCAL-CONNECTORS 全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
