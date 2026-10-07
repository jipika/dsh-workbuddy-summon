/*
 * dsh-workbuddy-summon — browser half
 *
 * 挂进 `conversation.input.right`（提交按钮前的紧凑控件区），一个「召唤」按钮 +
 * portal 面板：搜索 / 分类 / 专家团·专家·连接器三个 tab + 本地连接器管理区。
 *
 * 要点（本机踩过的坑）：
 *   · factory id 必须等于包名，否则设置页按 {only: row.id} 过滤会落空白行；
 *   · slot 出口是 display:contents，容器 rect 全是 0 → 浮层必须 portal 到 body；
 *   · 官方 overlay 天花板 z-index 20，取 15；
 *   · 样式与监听都在 apply 里用 ctx.effect 注册并返回清理函数；
 *   · 幂等守卫必须有，撞 id 会中断同 bundle 后续全部模块注册；
 *   · 只改本文件内容 → 刷新页面即可生效；新增/移除 client 半边 → 必须重启应用。
 *
 * 本轮改动（v0.2）：
 *   · 修复 en 词典重复键（英文界面被中文值覆盖）；
 *   · 连接器条目带 access.why 行动指引 + 本地徽标（source:"local"）；
 *   · 本地连接器管理区（列出 / 两段式删除 / 添加表单，stdio MCP）；
 *   · 接入中状态点（官方 token 自绘 6px dot + 呼吸环；StateDot 是 14px 行级
 *     组件，不适合列表内联，故按官方 ongoing 语义自绘 + reduced-motion 降级）；
 *   · 面板开合动效 160/120ms ease，transform-origin 锚定触发方向，
 *     prefers-reduced-motion 下降级为无位移；
 *   · 轮询只在面板打开时跑（4s），关闭即停；
 *   · tablist 方向键 + 列表方向键导航；错误区可滚动。
 */
if (!window.__dshWbSummonRegistered) {
	window.__dshWbSummonRegistered = true;
	window.__ModuleLoader__.load({
		id: "dsh-workbuddy-summon",
		factory: (require) => {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

			const React = require("react");
			const ReactDOM = require("react-dom");
			const h = React.createElement;

			const BASE = "/dsh-workbuddy-summon";
			const STYLE_ID = "dsh-wb-summon-style";
			const NS = "workbuddy-summon";
			const TAB_ORDER = ["team", "expert", "connector"];

			/* ───────────── 样式：只用官方 --dsw token（对齐全局 UI） ─────────────
			 * 全部 token 已在官方 asar 验证「定义处 > 0」；分级色用 --dsw-alias-state-*。
			 * 圆角四档 xs4/sm8/md12/lg16（胶囊 999px 亦为官方用法）；表面 = specific-menu +
			 * elevation-stroke（不写 border）；动效 120ms/160ms + ease；焦点环 focus-ring。
			 * 全部规则锚定 .wbsum-* 根类，不碰宿主 DOM。
			 */
			function installStyle() {
				if (document.getElementById(STYLE_ID)) return () => {};
				const el = document.createElement("style");
				el.id = STYLE_ID;
				el.textContent = [
					`.wbsum-btn{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:999px;border:0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease}`,
					`.wbsum-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
					`.wbsum-btn[data-active="1"]{color:var(--dsw-alias-state-business-primary);font-weight:600}`,
					`.wbsum-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}`,
					`.wbsum-caret{font-size:9px;opacity:.55}`,
					`.wbsum-panel{position:fixed;z-index:15;width:392px;max-width:calc(100vw - 24px);max-height:min(560px,72vh);display:flex;flex-direction:column;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);border-radius:var(--dsw-radius-lg);border:0;overflow:hidden;transform-origin:bottom left}`,
					`.wbsum-panel[data-state="open"]{animation:wbsum-in 160ms ease}`,
					`.wbsum-panel[data-state="closing"]{opacity:0;transform:translateY(6px) scale(.97);transition:opacity 120ms ease,transform 120ms ease}`,
					`@keyframes wbsum-in{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:none}}`,
					`@media (prefers-reduced-motion: reduce){.wbsum-panel[data-state="open"]{animation:none}.wbsum-panel[data-state="closing"]{opacity:0;transform:none;transition:opacity 120ms ease}}`,
					`.wbsum-head,.wbsum-cur{border-bottom:.5px solid var(--dsw-alias-border-l3)}`,
					`.wbsum-foot{border-top:.5px solid var(--dsw-alias-border-l3)}`,
					`.wbsum-head{padding:8px 10px 6px}`,
					`.wbsum-search{width:100%;box-sizing:border-box;padding:6px 9px;border-radius:var(--dsw-radius-sm);border:0;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);outline:none;transition:box-shadow .12s ease}`,
					`.wbsum-search:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}`,
					`.wbsum-search::placeholder{color:var(--dsw-alias-label-tertiary)}`,
					`.wbsum-tabrow{display:flex;align-items:center;gap:8px;margin-top:6px}`,
					/* 分段选择器：按官方 SegmentedControl 的规范做 —— 轨道 = interactive-bg-hover 实心，
					   指示器 = bg-layer-1 胶囊 + elevation-stroke/soft，位移 160ms ease。选中靠「指示器 vs 轨道」
					   的对比表达，不再给每个 tab 各画一层底色（那正是选中看不出来的原因）。 */
					`.wbsum-tabs{position:relative;display:inline-grid;grid-template-columns:repeat(3,minmax(58px,1fr));align-items:center;padding:3px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}`,
					`.wbsum-thumb{position:absolute;top:3px;bottom:3px;left:3px;width:calc((100% - 6px)/3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-soft);transform:translateX(calc(var(--wbsum-i,0) * 100%));transition:transform 160ms ease;pointer-events:none}`,
					`.wbsum-tab{position:relative;z-index:1;box-sizing:border-box;padding:3px 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;transition:color 120ms ease}`,
					`.wbsum-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:500}`,
					`.wbsum-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}`,
					`.wbsum-select{margin-left:auto;width:fit-content;padding:2px 6px;border-radius:var(--dsw-radius-sm);font:var(--dsw-font-xxs-12);background:transparent;color:var(--dsw-alias-label-secondary);border:0;cursor:pointer;transition:background .12s ease}`,
					`.wbsum-select:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
					`.wbsum-list{flex:1;min-height:0;overflow-y:auto;padding:4px 4px 6px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}`,
					`.wbsum-item{display:flex;align-items:flex-start;gap:9px;width:100%;text-align:left;padding:7px 9px;border-radius:var(--dsw-radius-md);border:0;background:transparent;color:inherit;font:var(--dsw-font-xxs-12);cursor:pointer;transition:background .12s ease}`,
					`.wbsum-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}`,
					`.wbsum-item:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
					`.wbsum-item:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}`,
					`.wbsum-item[data-on="1"]{background:var(--dsw-alias-bg-layer-1);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-soft)}`,
					`.wbsum-ava{margin-top:1px;width:28px;height:28px;flex:0 0 28px;border-radius:50%;object-fit:cover;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;line-height:1;overflow:hidden}`,
					`.wbsum-btn-ava{width:16px;height:16px;flex:0 0 16px;border-radius:50%;object-fit:cover;background:var(--dsw-alias-bg-layer-2);display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;line-height:1;overflow:hidden}`,
					`.wbsum-row1{display:flex;align-items:baseline;gap:6px}`,
					`.wbsum-name{font:var(--dsw-font-xxs-strong-12)}`,
					`.wbsum-prof{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}`,
					`.wbsum-badge{margin-left:auto;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);white-space:nowrap;display:inline-flex;align-items:center;gap:5px}[data-acc="ready"] .wbsum-badge{color:var(--dsw-alias-state-success-primary)}[data-acc="needs"] .wbsum-badge{color:var(--dsw-alias-state-warn-primary)}[data-acc="bad"] .wbsum-badge{color:var(--dsw-alias-state-error-primary)}.wbsum-item[data-on="2"]{opacity:.55}`,
					/* 状态点：官方 token 自绘。busy = business 色 + 呼吸环（对齐 StateDot ongoing 语义），
					   reduced-motion 下停帧为静态半透明环。 */
					`.wbsum-dot{width:6px;height:6px;border-radius:50%;flex:0 0 6px;display:inline-block}`,
					`.wbsum-dot-busy{background:var(--dsw-alias-state-business-primary);position:relative}`,
					`.wbsum-dot-busy::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:1.5px solid var(--dsw-alias-state-business-primary);animation:wbsum-pulse 1.6s ease infinite}`,
					`@keyframes wbsum-pulse{0%{transform:scale(.6);opacity:.6}70%,100%{transform:scale(1.25);opacity:0}}`,
					`@media (prefers-reduced-motion: reduce){.wbsum-dot-busy::after{animation:none;opacity:.35}}`,
					`.wbsum-dot-on{background:var(--dsw-alias-state-success-primary)}`,
					`.wbsum-dot-err{background:var(--dsw-alias-state-error-primary)}`,
					`.wbsum-dot-idle{background:var(--dsw-alias-label-tertiary)}`,
					`.wbsum-desc{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}`,
					`.wbsum-cur{padding:6px 10px;display:flex;align-items:center;gap:8px;background:var(--dsw-alias-bg-layer-1)}`,
					`.wbsum-curname{font:var(--dsw-font-xxs-strong-12);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
					`.wbsum-act{padding:3px 9px;border-radius:var(--dsw-radius-sm);border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;transition:background .12s ease,color .12s ease;white-space:nowrap}`,
					`.wbsum-act:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
					`.wbsum-act[data-danger="1"]{color:var(--dsw-alias-state-error-primary)}`,
					`.wbsum-note{padding:10px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:1.5}`,
					`.wbsum-err{margin:0 10px 6px;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxs-12);white-space:pre-wrap;max-height:120px;overflow-y:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}`,
					`.wbsum-ok{margin:0 10px 6px;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-success-primary);font:var(--dsw-font-xxs-12);white-space:pre-wrap}`,
					`.wbsum-foot{padding:6px 10px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);display:flex;gap:8px;align-items:center}`,
					`.wbsum-dots{letter-spacing:1px}`,
					/* 本地连接器管理区 */
					`.wbsum-lm{border-top:.5px solid var(--dsw-alias-border-l3)}`,
					`.wbsum-lm-head{width:100%;box-sizing:border-box;display:flex;align-items:center;gap:6px;padding:7px 10px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;transition:background .12s ease;text-align:left}`,
					`.wbsum-lm-head:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
					`.wbsum-lm-head:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}`,
					`.wbsum-lm-chev{margin-left:auto;font-size:9px;opacity:.55;transition:transform 160ms ease}`,
					`.wbsum-lm-head[aria-expanded="true"] .wbsum-lm-chev{transform:rotate(180deg)}`,
					`.wbsum-lm-body{max-height:200px;overflow-y:auto;padding:2px 8px 8px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}`,
					`.wbsum-lm-hint{padding:2px 2px 8px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:1.5}`,
					`.wbsum-lm-row{display:flex;align-items:center;gap:7px;padding:5px 4px;border-radius:var(--dsw-radius-sm);font:var(--dsw-font-xxs-12)}`,
					`.wbsum-lm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
					`.wbsum-lm-id{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
					`.wbsum-lm-cmd{color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-mono,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}`,
					`.wbsum-form{display:flex;flex-direction:column;gap:6px;padding:6px 2px 2px}`,
					`.wbsum-in{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:var(--dsw-radius-sm);border:0;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);outline:none;transition:box-shadow .12s ease}`,
					`.wbsum-in:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}`,
					`.wbsum-in::placeholder{color:var(--dsw-alias-label-tertiary)}`,
					`textarea.wbsum-in{resize:vertical;min-height:44px;font-family:var(--dsw-font-mono,SFMono-Regular,Menlo,Consolas,monospace)}`,
					`.wbsum-form-row{display:flex;gap:6px;align-items:center}`,
					`.wbsum-submit{margin-left:auto;padding:4px 12px;border-radius:999px;border:0;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-business,#fff);font:var(--dsw-font-xxs-12);cursor:pointer;transition:opacity .12s ease}`,
					`.wbsum-submit:disabled{opacity:.5;cursor:default}`,
					`.wbsum-submit:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}`,
				].join("\n");
				document.head.appendChild(el);
				return () => {
					try {
						el.remove();
					} catch {
						/* 已被移除 */
					}
				};
			}

			/* ───────────────────── 数据访问 ───────────────────── */
			async function apiCatalog(params) {
				const qs = new URLSearchParams(params || {}).toString();
				const res = await fetch(`${BASE}/catalog${qs ? `?${qs}` : ""}`, { headers: { Accept: "application/json" } });
				const data = await res.json().catch(() => ({}));
				if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
				return data;
			}
			async function apiConnectors(params) {
				const qs = new URLSearchParams(params || {}).toString();
				const res = await fetch(`${BASE}/connectors${qs ? `?${qs}` : ""}`, { headers: { Accept: "application/json" } });
				const data = await res.json().catch(() => ({}));
				if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
				return data;
			}
			async function apiStatus(sessionId) {
				const res = await fetch(`${BASE}/status?sessionId=${encodeURIComponent(sessionId ?? "")}`, {
					headers: { Accept: "application/json" },
				});
				const data = await res.json().catch(() => ({}));
				if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
				return data;
			}
			async function apiLocalList() {
				const res = await fetch(`${BASE}/local-connectors`, { headers: { Accept: "application/json" } });
				const data = await res.json().catch(() => ({}));
				if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
				return data;
			}
			async function apiPost(path, body) {
				const res = await fetch(`${BASE}${path}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				const data = await res.json().catch(() => ({}));
				if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
				return data;
			}

			/** 「KEY=VALUE」多行文本 → env 对象；非法行返回 bad 供提示。 */
			function parseEnvText(text) {
				const env = {};
				const bad = [];
				for (const raw of String(text ?? "").split(/\r?\n/)) {
					const line = raw.trim();
					if (line.length === 0) continue;
					const eq = line.indexOf("=");
					if (eq <= 0) { bad.push(line); continue; }
					env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
				}
				return { env, bad };
			}

			/* ───────────────────── 头像 ─────────────────────
			 * URL 直接由 plugin 拼（宿主路由自己查目录与缩略图），这样连改动前
			 * 写下的旧召唤状态也能显示头像。取不到图时回退首字，不留空洞。
			 */
			// 分级来自真实握手：unverified 不等于可用，别显示成绿色
			const ACC_KEY = {
				ready: "cReady",
				"needs-credential": "cNeedCred",
				"needs-token": "cNeedToken",
				"needs-cli-login": "cNeedCli",
				unverified: "cUnverified",
				unreachable: "cUnreach",
				blocked: "cBlocked",
				unsupported: "cBlocked",
			};
			const AVATAR_BASE = `${BASE}/avatar`;
			function avatarSrc(plugin, size) {
				if (typeof plugin !== "string" || plugin.length === 0) return null;
				return `${AVATAR_BASE}?plugin=${encodeURIComponent(plugin)}&size=${size ?? 64}`;
			}
			function Avatar(props) {
				const cls = props.small === true ? "wbsum-btn-ava" : "wbsum-ava";
				const initial = String(props.name ?? props.plugin ?? "?").trim().charAt(0) || "?";
				const [failed, setFailed] = React.useState(false);
				const src = props.src !== undefined ? props.src : avatarSrc(props.plugin, props.size);
				if (src === null || failed === true) {
					return h("span", { className: cls, "aria-hidden": "true" }, initial);
				}
				return h("img", {
					className: cls,
					src,
					alt: "",
					loading: "lazy",
					draggable: false,
					onError: () => setFailed(true),
				});
			}

			/* ───────────────────── 状态点 ─────────────────────
			 * 官方 StateDot 是 14px 行级组件，不适合列表条目内联；按官方 ongoing
			 * 语义自绘 6px 点（token/时长/reduced-motion 全对齐规范）。
			 */
			function StatusDot(props) {
				return h("span", { className: `wbsum-dot wbsum-dot-${props.kind ?? "idle"}`, "aria-hidden": "true" });
			}

			/* ───────────────────── 本地连接器管理区 ───────────────────── */
			function LocalManager(props) {
				const { t, busy, onChanged } = props;
				const [open, setOpen] = React.useState(false);
				const [rows, setRows] = React.useState(null);
				const [formErr, setFormErr] = React.useState(null);
				const [confirmId, setConfirmId] = React.useState(null);
				const [saving, setSaving] = React.useState(false);
				const [form, setForm] = React.useState({ name: "", command: "", args: "", env: "", desc: "" });
				const confirmTimer = React.useRef(null);

				React.useEffect(() => () => clearTimeout(confirmTimer.current), []);

				const reload = React.useCallback(() => {
					apiLocalList()
						.then((d) => setRows(d.items ?? []))
						.catch(() => setRows([]));
				}, []);
				React.useEffect(() => {
					if (open) reload();
				}, [open, reload]);

				const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

				const submit = async () => {
					if (saving) return;
					if (form.command.trim().length === 0) { setFormErr(t("cmdRequired")); return; }
					const { env, bad } = parseEnvText(form.env);
					if (bad.length > 0) { setFormErr(`${t("invalidEnv")}\n${bad.join("\n")}`); return; }
					setSaving(true);
					setFormErr(null);
					try {
						await apiPost("/local-connector-add", {
							name: form.name.trim() || undefined,
							command: form.command.trim(),
							args: form.args.trim() || undefined,
							env: Object.keys(env).length > 0 ? env : undefined,
							description: form.desc.trim() || undefined,
						});
						setForm({ name: "", command: "", args: "", env: "", desc: "" });
						reload();
						onChanged?.();
					} catch (e) {
						setFormErr(String(e?.message ?? e));
					} finally {
						setSaving(false);
					}
				};

				const remove = async (id) => {
					if (confirmId !== id) {
						setConfirmId(id);
						clearTimeout(confirmTimer.current);
						confirmTimer.current = setTimeout(() => setConfirmId(null), 3000);
						return;
					}
					clearTimeout(confirmTimer.current);
					setConfirmId(null);
					try {
						await apiPost("/local-connector-remove", { id });
						reload();
						onChanged?.();
					} catch (e) {
						setFormErr(String(e?.message ?? e));
					}
				};

				return h(
					"div",
					{ className: "wbsum-lm" },
					h(
						"button",
						{
							className: "wbsum-lm-head",
							"aria-expanded": String(open),
							onClick: () => setOpen((v) => !v),
						},
						h("span", { "aria-hidden": "true" }, "⌘"),
						h("span", null, t("localManage")),
						rows !== null && rows.length > 0 ? h("span", { className: "wbsum-prof" }, `${rows.length}`) : null,
						h("span", { className: "wbsum-lm-chev", "aria-hidden": "true" }, "▾"),
					),
					open
						? h(
								"div",
								{ className: "wbsum-lm-body" },
								h("div", { className: "wbsum-lm-hint" }, t("localHint")),
								rows === null
									? h("div", { className: "wbsum-lm-hint" }, "···")
									: rows.map((r) =>
											h(
												"div",
												{ className: "wbsum-lm-row", key: r.id },
												h("span", { className: "wbsum-name" }, r.name),
												h("span", { className: "wbsum-lm-cmd" }, `${r.command ?? ""}`),
												h(
													"button",
													{
														className: "wbsum-act",
														"data-danger": confirmId === r.id ? "1" : undefined,
														disabled: busy,
														onClick: () => remove(r.id),
													},
													confirmId === r.id ? t("delConfirm") : t("del"),
												),
											),
										),
								rows !== null && rows.length === 0 ? h("div", { className: "wbsum-lm-hint" }, t("localEmpty")) : null,
								formErr !== null ? h("div", { className: "wbsum-err" }, formErr) : null,
								h(
									"div",
									{ className: "wbsum-form" },
									h("input", { className: "wbsum-in", value: form.name, onChange: set("name"), placeholder: t("formName") }),
									h("input", { className: "wbsum-in", value: form.command, onChange: set("command"), placeholder: t("formCommand") }),
									h("input", { className: "wbsum-in", value: form.args, onChange: set("args"), placeholder: t("formArgs") }),
									h("textarea", { className: "wbsum-in", value: form.env, onChange: set("env"), placeholder: t("formEnv"), rows: 2 }),
									h("input", { className: "wbsum-in", value: form.desc, onChange: set("desc"), placeholder: t("formDesc") }),
									h(
										"div",
										{ className: "wbsum-form-row" },
										h("span", { className: "wbsum-prof" }, t("localAfter")),
										h(
											"button",
											{ className: "wbsum-submit", disabled: saving, onClick: submit },
											saving ? t("adding") : t("add"),
										),
									),
								),
							)
						: null,
				);
			}

			/* ───────────────────── 面板 ───────────────────── */
			function SummonPanel(props) {
				const { sessionId, current, connSum, pos, onClose, onChanged, t, phase } = props;
				const [kind, setKind] = React.useState("team");
				const [q, setQ] = React.useState("");
				const [debounced, setDebounced] = React.useState("");
				const [category, setCategory] = React.useState("");
				const [data, setData] = React.useState(null);
				const [error, setError] = React.useState(null);
				const [okNote, setOkNote] = React.useState(null);
				const [busy, setBusy] = React.useState(false);
				const [connectingId, setConnectingId] = React.useState(null);
				const boxRef = React.useRef(null);
				const inputRef = React.useRef(null);
				const okTimer = React.useRef(null);

				React.useEffect(() => () => clearTimeout(okTimer.current), []);

				React.useEffect(() => {
					const timer = setTimeout(() => setDebounced(q.trim()), 260);
					return () => clearTimeout(timer);
				}, [q]);

				React.useEffect(() => {
					let alive = true;
					setData(null);
					setError(null);
					(kind === "connector" ? apiConnectors : apiCatalog)({
						...(kind === "connector" ? { sessionId: sessionId ?? "" } : { kind }),
						...(debounced.length > 0 ? { q: debounced } : {}),
						...(category.length > 0 && kind !== "connector" ? { category } : {}),
					})
						.then((d) => {
							if (alive) setData(d);
						})
						.catch((e) => {
							if (alive) setError(String(e?.message ?? e));
						});
					return () => {
						alive = false;
					};
				}, [kind, debounced, category]);

				React.useEffect(() => {
					const onDoc = (ev) => {
						if (boxRef.current !== null && !boxRef.current.contains(ev.target)) onClose();
					};
					const onKey = (ev) => {
						if (ev.key === "Escape") onClose();
					};
					// 面板要能接住第一次外部点击，延一帧再挂监听
					const timer = setTimeout(() => {
						document.addEventListener("mousedown", onDoc, true);
						document.addEventListener("keydown", onKey, true);
					}, 0);
					inputRef.current?.focus?.();
					return () => {
						clearTimeout(timer);
						document.removeEventListener("mousedown", onDoc, true);
						document.removeEventListener("keydown", onKey, true);
					};
				}, [onClose]);

				const flashOk = (text) => {
					setOkNote(text);
					clearTimeout(okTimer.current);
					okTimer.current = setTimeout(() => setOkNote(null), 4000);
				};

				const doSummon = async (item) => {
					if (sessionId === undefined || busy) return;
					setBusy(true);
					setError(null);
					try {
						const r = await apiPost("/summon", { sessionId, plugin: item.plugin });
						onChanged(r);
						onClose();
					} catch (e) {
						setError(String(e?.message ?? e));
					} finally {
						setBusy(false);
					}
				};

				const doConnector = async (item) => {
					if (busy) return;
					setBusy(true);
					setError(null);
					setOkNote(null);
					try {
						if (item.access === "blocked" || item.access === "unsupported") {
							setError(`${item.name}：${item.why ?? t("connBlocked")}`);
							return;
						}
						if (sessionId === undefined) { setError(t("noSession")); return; }
						const installing = item.installed !== true;
						setConnectingId(item.id);
						await apiPost(installing ? "/connector-install" : "/connector-remove", {
							sessionId,
							connectorId: item.id,
						});
						// 重新拉一次列表反映状态；不关面板，便于连续接入多个
						const d = await apiConnectors({
							sessionId,
							...(debounced.length > 0 ? { q: debounced } : {}),
						});
						setData(d);
						if (installing) {
							flashOk(item.transportKind === "stdio" ? `${item.name}：${t("connStarting")}` : `${item.name}：${t("connOk")}`);
						}
					} catch (e) {
						setError(String(e?.message ?? e));
					} finally {
						setBusy(false);
						setConnectingId(null);
					}
				};

				const doClear = async () => {
					if (sessionId === undefined || busy) return;
					setBusy(true);
					try {
						await apiPost("/unsummon", { sessionId });
						onChanged(null);
					} catch (e) {
						setError(String(e?.message ?? e));
					} finally {
						setBusy(false);
					}
				};

				const onTabKey = (e) => {
					if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
					e.preventDefault();
					const i = TAB_ORDER.indexOf(kind);
					const n = (i + (e.key === "ArrowRight" ? 1 : TAB_ORDER.length - 1)) % TAB_ORDER.length;
					setKind(TAB_ORDER[n]);
					e.currentTarget.querySelectorAll("[role=tab]")[n]?.focus?.();
				};
				const onListKey = (e) => {
					if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
					const btns = [...e.currentTarget.querySelectorAll("button.wbsum-item")];
					if (btns.length === 0) return;
					e.preventDefault();
					const i = btns.indexOf(document.activeElement);
					const n = i === -1 ? 0 : Math.min(btns.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)));
					btns[n]?.focus?.();
				};

				const items = data?.items ?? [];
				const isConnector = kind === "connector";
				// 本地条目置顶（与在线目录同列表，靠 source 区分）
				const sorted = isConnector
					? [...items].sort((a, b) => (b.source === "local" ? 1 : 0) - (a.source === "local" ? 1 : 0))
					: items;
				const cats = (data?.categories ?? []).filter((c) => c.count > 2);

				const renderItem = (it) =>
					h(
						"button",
						{
							key: isConnector ? it.id : `${it.plugin}::${it.id}`,
							className: "wbsum-item",
							"data-acc": isConnector
								? it.source === "local"
									? "local"
									: it.access === "ready"
										? "ready"
										: /^(needs-|unreachable)/.test(String(it.access))
											? it.access === "unreachable" ? "bad" : "needs"
											: it.access === "blocked" || it.access === "unsupported"
												? ""
												: "needs"
								: "",
							"data-on": isConnector
								? it.installed === true
									? it.disabled === true ? "2" : "1"
									: "0"
								: current?.plugin === it.plugin
									? "1"
									: "0",
							disabled: busy,
							title: isConnector
								? `${it.name} — ${it.why ?? it.summary ?? ""}`
								: `${it.title}${it.name && it.name !== it.title ? ` · ${it.name}` : ""}`,
							onClick: () => (isConnector ? doConnector(it) : doSummon(it)),
						},
						isConnector
							? connectingId === it.id
								? h("span", { className: "wbsum-ava", style: { display: "inline-flex", alignItems: "center", justifyContent: "center" } }, h(StatusDot, { kind: "busy" }))
								: h("span", { className: "wbsum-ava", "aria-hidden": "true" }, "🔌")
							: h(Avatar, { plugin: it.plugin, name: it.title, src: it.avatarUrl }),
						h(
							"div",
							{ className: "wbsum-main" },
							h(
								"div",
								{ className: "wbsum-row1" },
								// 主标题 = profession（如「中文网络小说创作顾问」），
								// 副标题 = displayName 花名（如「网文主编」）—— 对齐 WorkBuddy 卡片
								h("span", { className: "wbsum-name" }, isConnector ? it.name : (it.title ?? it.profession ?? it.name)),
								!isConnector && it.name && it.name !== it.title
									? h("span", { className: "wbsum-prof" }, it.name)
									: null,
								// 接入状态点：已接入=success 实点（含呼吸中=busy），未接入不显示
								isConnector && (connectingId === it.id || it.installed === true)
									? h(StatusDot, { kind: connectingId === it.id ? "busy" : (it.disabled === true ? "idle" : "on") })
									: null,
								h(
									"span",
									{ className: "wbsum-badge" },
									isConnector
										? `${it.installed === true ? (it.disabled === true ? t("cOff") : t("cOn")) : t(ACC_KEY[it.access] ?? "cTry")}·${it.source === "local" ? `${t("localTag")}·` : ""}${it.transportKind}`
										: it.expertType === "team"
											? `${t("teamTag")}·${(it.memberCount ?? 0) + 1}`
											: it.category,
								),
							),
							h("div", { className: "wbsum-desc" }, it.summary),
						),
					);

				return h(
					"div",
					{
						ref: boxRef,
						className: "wbsum-panel",
						style: { left: pos?.left ?? 12, top: pos?.top ?? 12 },
						role: "dialog",
						"aria-label": t("title"),
						"data-state": phase,
					},
					h(
						"div",
						{ className: "wbsum-head" },
						h("input", {
							ref: inputRef,
							className: "wbsum-search",
							value: q,
							placeholder: t("search"),
							onChange: (e) => setQ(e.target.value),
						}),
						h(
							"div",
							{ className: "wbsum-tabrow" },
							h(
								"div",
								{
									className: "wbsum-tabs",
									role: "tablist",
									style: { "--wbsum-i": String(TAB_ORDER.indexOf(kind)) },
									onKeyDown: onTabKey,
								},
								h("span", { className: "wbsum-thumb", "aria-hidden": "true" }),
								h(
									"button",
									{ className: "wbsum-tab", role: "tab", "aria-selected": String(kind === "team"), onClick: () => setKind("team") },
									t("tabTeam"),
								),
								h(
									"button",
									{ className: "wbsum-tab", role: "tab", "aria-selected": String(kind === "expert"), onClick: () => setKind("expert") },
									t("tabExpert"),
								),
								h(
									"button",
									{ className: "wbsum-tab", role: "tab", "aria-selected": String(kind === "connector"), onClick: () => setKind("connector") },
									t("tabConn"),
								),
							),
							cats.length > 0
								? h(
									"select",
									{
										className: "wbsum-select",
										value: category,
										onChange: (e) => setCategory(e.target.value),
									},
									h("option", { value: "" }, t("allCats")),
									cats.map((c) => h("option", { key: c.id, value: c.id }, `${c.name} ${c.count}`)),
								)
								: null,
						),
					),
					current !== null && current !== undefined
						? h(
								"div",
								{ className: "wbsum-cur" },
								h(Avatar, { plugin: current.plugin, name: current.title ?? current.name, src: current.avatarUrl }),
								h("span", { className: "wbsum-curname" }, `✓ ${current.title ?? current.name ?? current.plugin}`),
								h(
									"button",
									{ className: "wbsum-act", disabled: busy, onClick: doClear },
									t("unsummon"),
								),
							)
						: null,
					connSum !== undefined && connSum.length > 0
						? h(
								"div",
								{ className: "wbsum-cur" },
								h("span", { className: "wbsum-btn-ava", "aria-hidden": "true" }, "🔌"),
								h(
									"span",
									{ className: "wbsum-curname" },
									`${t("connActive")}${connSum.map((c) => c.name ?? c.serverName).join("、")}`,
								),
							)
						: null,
					error !== null ? h("div", { className: "wbsum-err", role: "alert" }, error) : null,
					okNote !== null ? h("div", { className: "wbsum-ok" }, okNote) : null,
					h(
						"div",
						{ className: "wbsum-list", onKeyDown: onListKey },
						sessionId === undefined
							? h("div", { className: "wbsum-note" }, t("noSession"))
							: data === null && error === null
								? h("div", { className: "wbsum-note" }, h("span", { className: "wbsum-dots" }, "···"), " ", t("loading"))
								: sorted.length === 0
									? h("div", { className: "wbsum-note" }, t("empty"))
									: sorted.map(renderItem),
					),
					isConnector
						? h(LocalManager, { t, busy, onChanged: () => {
							apiConnectors({ sessionId: sessionId ?? "", ...(debounced.length > 0 ? { q: debounced } : {}) }).then((d) => setData(d)).catch(() => {});
						} })
						: null,
					h(
						"div",
						{ className: "wbsum-foot" },
						data !== null
							? h("span", null, `${data.total}${t("countSuffix")}${data.degraded ? ` · ${t("offline")}` : ""}`)
							: null,
						h("span", { style: { marginLeft: "auto" } }, t("footHint")),
					),
				);
			}

			/* ───────────────────── 入口按钮 ───────────────────── */
			function SummonEntry(props) {
				const sessionId = props.sessionId ?? props.session?.id;
				// phase: closed → open →（关闭时）closing → closed；closing 期间播退场动效
				const [phase, setPhase] = React.useState("closed");
				const [current, setCurrent] = React.useState(null);
				const [pos, setPos] = React.useState(null);
				const btnRef = React.useRef(null);
				const closeTimer = React.useRef(null);
				const t = typeof props.t === "function" ? props.t : (k) => k;

				const [connSum, setConnSum] = React.useState([]);
				const refresh = React.useCallback(() => {
					apiStatus(sessionId)
						.then((d) => {
							const s = d.summon;
							setCurrent(s === null || s === undefined ? null : { ...s, name: s.name ?? s.plugin });
						})
						.catch(() => {
							/* host 未就绪时保持原状 */
						});
					apiConnectors({ sessionId })
						.then((d) => setConnSum(d.installed ?? []))
						.catch(() => {
							/* 连接器状态拉不到时保持原状 */
						});
				}, [sessionId]);

				// 轮询只在面板打开时跑（打开即手动刷一次），关闭即停，不再常驻 5s
				React.useEffect(() => {
					if (phase === "closed") return undefined;
					refresh();
					const timer = setInterval(refresh, 4000);
					return () => clearInterval(timer);
				}, [phase, refresh]);

				React.useEffect(() => () => clearTimeout(closeTimer.current), []);

				const openPanel = () => {
					clearTimeout(closeTimer.current);
					if (btnRef.current !== null) {
						const r = btnRef.current.getBoundingClientRect();
						// 向上展开：控件在底部工具行，面板往左上角放
						setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 404)), top: Math.max(8, r.top - 8 - Math.min(560, window.innerHeight * 0.72)) });
					}
					setPhase("open");
				};
				const closePanel = () => {
					if (phase !== "open") return;
					setPhase("closing");
					closeTimer.current = setTimeout(() => setPhase("closed"), 130);
				};
				const toggle = () => (phase === "open" ? closePanel() : openPanel());

				const label = current === null ? t("btn") : current.title ?? current.name ?? current.plugin;
				return h(
					React.Fragment,
					null,
					h(
						"button",
						{
							ref: btnRef,
							className: "wbsum-btn",
							"data-active": current === null ? "0" : "1",
							"aria-expanded": String(phase === "open"),
							title: current === null ? t("btnHint") : `${t("current")}：${label}`,
							onClick: toggle,
							type: "button",
						},
						current === null
							? h("span", null, "✦")
							: h(Avatar, { small: true, plugin: current.plugin, name: current.title ?? current.name, src: current.avatarUrl }),
						h("span", null, label),
						h("span", { className: "wbsum-caret" }, "▾"),
					),
					phase !== "closed"
						? ReactDOM.createPortal(
								h(SummonPanel, {
									sessionId,
									current,
									connSum,
									pos,
									t,
									phase,
									onClose: closePanel,
									onChanged: (r) =>
										setCurrent(r === null ? null : { ...r, title: r?.title ?? r?.name ?? r?.plugin }),
								}),
								document.body,
							)
						: null,
				);
			}

			/* ───────────────────── 文案 ───────────────────── */
			const STRINGS = {
				zh: {
					btn: "召唤",
					btnHint: "召唤 WorkBuddy 专家 / 专家团进本会话",
					title: "召唤专家",
					search: "搜索专家、职业、能力关键词…",
					tabTeam: "专家团",
					tabExpert: "专家",
					tabConn: "连接器",
					allCats: "全部分类",
					loading: "载入目录…",
					empty: "没有匹配的条目",
					unsummon: "取消召唤",
					current: "已召唤",
					teamTag: "团",
					noSession: "本会话还没有 id，发一条消息后再召唤。",
					countSuffix: " 条",
					offline: "离线副本",
					footHint: "召唤与连接器都只作用于当前会话",
					cReady: "可直接接入",
					cNeedCred: "需凭据",
					cNeedCli: "需 CLI 登录",
					cTry: "待验证",
					cUnverified: "未验证",
					cBlocked: "不可接入",
					cOn: "已接入",
					cOff: "已停用",
					cNeedToken: "需令牌",
					cUnreach: "连不上",
					connBlocked: "此连接器无法接入",
					connOk: "已接入本会话，mcp__ 工具现在可见",
					connStarting: "接入中…（首次启动可能要拉包，稍候）",
					localTag: "本地",
					localManage: "本地连接器",
					localHint: "注册本机 stdio MCP server（npx / node / uvx 起进程）。接入后工具仅本会话可见。",
					localEmpty: "还没有本地条目",
					localAfter: "添加后出现在连接器列表顶部",
					formName: "名称（选填，如「企微文档检索」）",
					formCommand: "命令（必填，如 npx）",
					formArgs: "参数（空格分隔，如 -y some-mcp@latest）",
					formEnv: "环境变量（每行 KEY=VALUE，值可写 ${VAR} 从环境求值）",
					formDesc: "备注（选填）",
					add: "添加",
					adding: "添加中…",
					del: "删除",
					delConfirm: "确认删除？",
					cmdRequired: "命令不能为空",
					invalidEnv: "这些行不是 KEY=VALUE 格式：",
				},
				en: {
					btn: "Summon",
					btnHint: "Summon a WorkBuddy expert or expert team into this session",
					title: "Summon expert",
					search: "Search experts, roles, capabilities…",
					tabTeam: "Teams",
					tabExpert: "Experts",
					tabConn: "Connectors",
					allCats: "All categories",
					loading: "Loading catalog…",
					empty: "No matches",
					unsummon: "Unsummon",
					current: "Summoned",
					teamTag: "Team",
					noSession: "This session has no id yet; send a message first.",
					countSuffix: " items",
					offline: "offline copy",
					footHint: "Summoning and connectors apply to this session only",
					cReady: "ready",
					cNeedCred: "needs credential",
					cNeedCli: "needs CLI login",
					cTry: "unverified",
					cUnverified: "unverified",
					cBlocked: "blocked",
					cOn: "installed",
					cOff: "disabled",
					cNeedToken: "needs token",
					cUnreach: "unreachable",
					connBlocked: "this connector cannot be installed",
					connOk: "installed in this session; mcp__ tools are now visible",
					connStarting: "connecting… (first start may download packages, hang tight)",
					localTag: "local",
					localManage: "Local connectors",
					localHint: "Register a local stdio MCP server (spawned via npx / node / uvx). Tools are visible in this session only.",
					localEmpty: "No local entries yet",
					localAfter: "New entries appear at the top of the connector list",
					formName: "Name (optional)",
					formCommand: "Command (required, e.g. npx)",
					formArgs: "Args (space-separated, e.g. -y some-mcp@latest)",
					formEnv: "Env vars (one KEY=VALUE per line; ${VAR} resolved from environment)",
					formDesc: "Description (optional)",
					add: "Add",
					adding: "Adding…",
					del: "Delete",
					delConfirm: "Confirm delete?",
					cmdRequired: "Command is required",
					invalidEnv: "These lines are not KEY=VALUE:",
				},
			};

			function apply(ctx) {
				installStyle();
				// 词典注册放进 effect：热重载时替换而不是撞 namespace。
				// 真实签名是 register(ns, lang, dict)，各自返回 disposer。
				ctx.effect(() => {
					const offZh = ctx.locale.register(NS, "zh", STRINGS.zh);
					const offEn = ctx.locale.register(NS, "en", STRINGS.en);
					return () => {
						if (typeof offZh === "function") offZh();
						if (typeof offEn === "function") offEn();
					};
				}, "dsh-workbuddy-summon: dictionaries");
				const t = ctx.locale.bind(NS);
				try {
					ctx.slots.inject("conversation.input.right", () =>
						ctx.slots.register(
							{
								name: "conversation.input.right",
								id: "dsh-workbuddy-summon",
								order: 40,
								label: () => t("title"),
								inject: () => ({ t }),
							},
							SummonEntry,
						),
					);
					console.log("[dsh-workbuddy-summon] client half mounted on conversation.input.right");
				} catch (error) {
					console.error("[dsh-workbuddy-summon] slot inject failed", error);
				}
			}

			exports.name = "dsh-workbuddy-summon";
			exports.inject = ["slots", "locale"];
			exports.apply = apply;
			return module.exports;
		},
	});
}
