const { loadConnectors } = await import("../lib/connectors.js");
const r = await loadConnectors({});
const vars = new Map(); let withVar = 0, plain = 0;
for (const c of r.connectors) for (const s of c.servers) {
  const hay = `${s.url ?? ""} ${JSON.stringify(s.env ?? {})} ${s.args.join(" ")}`;
  const found = [...hay.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
  if (found.length) { withVar += 1; for (const f of found) vars.set(f, (vars.get(f) || 0) + 1); } else plain += 1;
}
console.log(`server 总数 ${withVar + plain} | 含 \${} 模板 ${withVar} | 纯字面 ${plain}`);
console.log("\n变量写法 top12:");
[...vars.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}×  \${${k}}`));
console.log("\n带 env 键的连接器:");
let n = 0;
for (const c of r.connectors) { const s = c.servers[0]; if (s && Object.keys(s.env || {}).length) { console.log(`  ${c.id.padEnd(24)} env=${JSON.stringify(s.env).slice(0, 86)}`); n += 1; if (n >= 6) break; } }
console.log(`  共 ${r.connectors.filter((c) => Object.keys(c.servers[0]?.env || {}).length).length} 条带 env`);
console.log("\nstdio 型（可直接接）:");
for (const c of r.connectors.filter((x) => x.transportKind === "stdio")) console.log(`  ${c.id.padEnd(22)} ${c.name} | cmd=${c.servers[0]?.command} ${c.servers[0]?.args.join(" ").slice(0,44)} | cli=${c.hasCliJson}`);
