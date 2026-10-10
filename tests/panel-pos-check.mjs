/* 面板定位探针：mock React/DOM，直接调「召唤」按钮的 onClick，
   断言 openPanel 的定位是 bottom 锚定（底边贴按钮上沿）+ maxHeight 由可用空间给出，
   而不再用「r.top - 8 - min(560, vh*0.72)」预估内容高度。 */
const VIEW = { w: 1568, h: 1005 };
const BTN = { left: 1104, top: 941, width: 88, height: 26 };
const setters = [];
/* useState 走真状态机：setter 改槽位并记脏，外层循环重渲染直到拿到面板 */
let slots = []; let cursor = 0; let dirty = false;

const el = (type, props, ...kids) => {
	if (typeof type === "function") return type({ ...(props ?? {}), children: kids }); // 渲染函数组件
	return { type, props: props ?? {}, kids };
};
const React = {
	createElement: el,
	Fragment: Symbol("Frag"),
	useState: (v) => {
		const i = cursor++;
		if (i >= slots.length) slots.push({ v, has: false });
		const cur = slots[i].has ? slots[i].v : v;
		return [cur, (next) => {
			const val = typeof next === "function" ? next(slots[i].v) : next;
			if (slots[i].v !== val || !slots[i].has) { slots[i].v = val; slots[i].has = true; dirty = true; }
			setters.push(val);
		}];
	},
	useEffect: () => {},
	useRef: (() => { let n = 0; return () => (n++ === 0 ? { current: { getBoundingClientRect: () => BTN } } : { current: null }); })(),
	useCallback: (f) => f,
	useMemo: (f) => f(),
};
globalThis.window = { innerWidth: VIEW.w, innerHeight: VIEW.h, addEventListener() {}, removeEventListener() {} };
globalThis.document = { getElementById: () => null, createElement: () => ({ id: "", textContent: "", remove() {} }), head: { appendChild() {} }, body: {} };

let Comp;
globalThis.window.__ModuleLoader__ = {
	load({ id, factory }) {
		const m = factory((n) => (n === "react" ? React : { createPortal: (x) => x }));
		Comp = m;
	},
};
await import("/Users/lixiongwei/.dsh/local-plugins/dsh-workbuddy-summon/lib/client.js");

const ctx = {
	effect: (f) => f(),
	locale: { register: () => () => {}, bind: () => (k) => k },
	slots: { inject: () => {}, register: () => {} },
};
Comp.apply(ctx);

// 渲染：拿到最外层「召唤」按钮元素 → 调它的 onClick
function findButton(node) {
	if (!node || typeof node !== "object") return null;
	if (node.type === "button" && node.props?.className === "wbsum-btn") return node;
	for (const k of node.kids ?? []) { const r = findButton(k); if (r) return r; }
	return null;
}
const tree = Comp.__comp ?? null;
// SummonEntry 不在 exports 上，通过 slots.register 的组件参数拿
let EntryComp = null;
const ctx2 = { ...ctx, slots: { inject: (a, b) => b?.(), register: (cfg, C) => { EntryComp = C; } } };
Comp.apply(ctx2);
if (!EntryComp) { console.log("✗ 没拿到 SummonEntry 组件"); process.exit(1); }
let rendered = null; let panel = null;
for (let round = 0; round < 4; round++) {
	cursor = 0; dirty = false;
	rendered = EntryComp({ sessionId: "s1", t: (k) => k });
	panel = (function walk(n) { if (!n || typeof n !== "object") return null; if (n.props?.className === "wbsum-panel") return n; for (const k of n.kids ?? []) { const r = walk(k); if (r) return r; } return null; })(rendered);
	if (round === 0) {
		const b = findButton(rendered);
		if (!b) { console.log("✗ 没找到召唤按钮"); process.exit(1); }
		b.props.onClick(); // → openPanel()
	}
	if (panel && !dirty) break;
}

const pos = setters.find((s) => s && typeof s === "object" && ("bottom" in s || "top" in s));
const phase = setters.includes("open");

const GAP = 8, EDGE = 8;
const expectBottom = VIEW.h - BTN.top + GAP;          // 底边贴按钮上沿
const expectMaxH = Math.min(560, Math.max(160, BTN.top - GAP - EDGE));
const checks = [
	["面板进入 open", phase === true],
	["用 bottom 锚定（不再用 top 猜高度）", pos && "bottom" in pos && !("top" in pos)],
	[`bottom = ${expectBottom}（= 视口高 - 按钮上沿 + 8 间隙）`, pos?.bottom === expectBottom],
	[`maxHeight = ${expectMaxH}（= 按钮上方可用空间，capped 560）`, pos?.maxHeight === expectMaxH],
	["left 仍做视口内 clamp", pos?.left === Math.max(EDGE, Math.min(BTN.left, VIEW.w - 404))],
];
for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);
console.log(panel ? `✓ 面板 style = ${JSON.stringify(panel.props.style)}` : "✗ 面板未渲染");
const pass = checks.every(([, ok]) => ok) && !!panel && "bottom" in panel.props.style && "maxHeight" in panel.props.style;
console.log(pass ? "\n== 全部通过：底边锚定 + 高度由空间决定 ==" : "\n== 有失败项 ==");
process.exit(pass ? 0 : 1);
