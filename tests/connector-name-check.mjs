/**
 * 连接器中文名全链路验证：
 *   接入时存名 → 摘要行显示「已接入：通达信」→ 落盘含名但不含 config →
 *   老记录（无 name）恢复时从目录补名。
 *   node tests/connector-name-check.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const home = mkdtempSync(join(tmpdir(), "wbname-"));
process.env.HOME = home;
process.env.DSH_PROFILE_DIR = join(home, "profiles", "probe");
mkdirSync(join(home, ".dsh/workbuddy-summon"), { recursive: true });
const P = "/Users/lixiongwei/.dsh/local-plugins/dsh-workbuddy-summon";
const { loadConnectors } = await import(P + "/lib/connectors.js");
const cat = await loadConnectors({});
const CS = await import(P + "/lib/connector-session.js");
CS.bindMcpClient({ name: "mcp-client", inject: [], apply() {} });
const agent = { id: "sess-n", ctx: { plugin() { return Object.assign(Promise.resolve(), { dispose: async () => {} }); } } };

let fails = 0;
const ok = (l, c, e = "") => { if (!c) fails += 1; console.log(`  ${c ? "✓" : "✗"} ${l}${e ? ` — ${e}` : ""}`); };

// ① 通达信（tdx-connector）接入后摘要应有中文名
const tdx = cat.byId.get("tdx-connector");
const r = await CS.connectInSession({ id: tdx.id, name: tdx.name, servers: tdx.servers }, agent);
const rows = CS.listForSession("sess-n");
ok("接入返回名", r.serverName === tdx.id.replace(/[^A-Za-z0-9_-]/g, "_") || r.serverName.length > 0, r.serverName);
ok("listForSession 带中文名", rows[0]?.name === tdx.name, JSON.stringify(rows[0]));
ok("中文名确实是中文", /[\u4e00-\u9fff]/.test(rows[0]?.name ?? ""), rows[0]?.name);

// ② 落盘：意图含 name，但绝不含 config
const disk = readFileSync(join(home, ".dsh/workbuddy-summon/session-connectors.json"), "utf8");
ok("落盘含中文名", disk.includes(tdx.name), tdx.name);
ok("落盘不含 config", !disk.includes('"config"'));
ok("落盘不含 server 凭据字段", !disk.includes('"transport"'), disk.slice(0, 120));

// ③ 老记录恢复补名：手工造一条无 name 的记录，restoreForSession 应补
CS.forgetSession("sess-n");
const store = JSON.parse(readFileSync(join(home, ".dsh/workbuddy-summon/session-connectors.json"), "utf8"));
for (const k of Object.keys(store)) delete store[k];
store["sess-old"] = [{ connectorId: "tdx-connector", serverName: "tdx-connector", at: new Date().toISOString() }];
writeFileSync(join(home, ".dsh/workbuddy-summon/session-connectors.json"), JSON.stringify(store, null, 1));
const byId = new Map([...cat.connectors].map((c) => [c.id, c]));
const rr = await CS.restoreForSession({ id: "sess-old", ctx: agent.ctx }, byId);
ok("恢复成功", rr.restored.length === 1, JSON.stringify(rr));
const oldRows = CS.listForSession("sess-old");
ok("★ 恢复后补出中文名", oldRows[0]?.name === tdx.name, JSON.stringify(oldRows[0]));

try { rmSync(home, { recursive: true, force: true }); } catch { }
console.log(fails === 0 ? "\nNAME-LINK 全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
