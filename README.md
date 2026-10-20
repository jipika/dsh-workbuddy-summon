<div align="center">
  <img src="assets/icon.svg" width="72" alt="dsh-workbuddy-summon icon">
</div>

# dsh-workbuddy-summon

把 **WorkBuddy 的「专家 / 专家团」做成在线目录 + 对话框召唤**：插件按需拉 WorkBuddy 云端公开清单，跟着他的数据动，不用每次同步到本地；**用户不召唤就一个字都不注入**。

连接器（Connector）本轮只留入口（UI 置灰 + `config.connectors.enabled` 开关），等专家团测通后再接。

---

## 它解决什么

| 需求 | 做法 |
|---|---|
| 不每次同步到本地 | 目录在线优先（COS 公开静态清单，无需登录）；包体按需取并缓存 |
| 跟着他的数据动 | 每次拉取按 TTL（6 小时）刷新；`refresh: true` / `?refresh=1` 强制联网 |
| 保持去重 | 三份云端清单 + 本机市场按 `(plugin, id)` 主键去重，重复项记进 `_aliases` |
| 召唤才用，默认不注入 | `systemPrompt.section` 的求值器按 sessionId 查表，**未命中返回空串**（宿主 renderPrompt 过滤，零残留） |
| 和他一样的召唤逻辑 | 对话框提交区一个「召唤」按钮 → 面板选人 → 该会话生效，可一键取消；只影响当前会话 |
| 连接器也按会话接入 | 同一面板的「连接器」tab → 接入到当前会话（`agent.ctx.plugin(mcp-client)`），不写 profile、不影响其他会话 |

## 数据源（四路，逐级降级）

```
① https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace
     /expert_center.json (429) + /internalExpert.json (21) + /externalExpert.json (15)
② ~/.dsh/workbuddy-summon/cache/            上一次成功拉取的副本（断网可用）
③ ~/Documents/deepseek/wb-resources/expert-market/remote/   本机镜像（离线兜底）
④ ~/.workbuddy/plugins/marketplaces/*/plugins/*/            本机已下载的社区/自建包
```

任一源失败只降级不报错；四路合并后 **451 条**（54 专家团 + 397 单专家）。

## 文件

```
index.js            Host 半边：注入段 + 4 个工具 + HTTP 路由 + 垫片自装
lib/catalog.js      四源清单、去重、包体加载、YAML 子集解析、references 索引
lib/state.js        会话级召唤状态（~/.dsh/workbuddy-summon/summons.json）
lib/inject.js       把专家包翻译成 DSH 可执行的系统提示段
lib/avatars.js      头像实时代理（COS 服务端缩略 + LRU + 并发合并）
lib/connectors.js   连接器在线目录（zip 解包、ETag 缓存、去重）
lib/connector-probe.js  可接入性分级（只认真实 initialize 握手）
lib/connector-session.js  按会话挂载 mcp-client（agent.ctx.plugin）
lib/shims.js        兼容垫片自装（见下节）
bin/westock-data    命令兼容垫片（含参数翻译）
bin/westock-tool    把技能包内的 Node CLI 挂进 PATH
lib/client.js       浏览器半边：conversation.input.right 的召唤按钮 + 面板
tests/*.mjs         离线回归（不需重启 DSH；session-isolation 需 Electron 跑，见下）
```

## 连接器：按会话接入（与召唤专家同构）

| 端点 / 工具 | 作用 |
|---|---|
| `wb_connectors_list` | 列目录（317 条在线），带可接入性分级 + 标记本会话是否已接入 |
| `wb_connector_install` | 接入 / 移除到**当前会话**（不传 connectorId = 查本会话已接入清单） |
| `GET /connectors?sessionId=` `POST /connector-{install,remove,probe}` | 面板与外部调用 |

**作用域 = 单个会话**：接入只给该会话挂 `mcp__<serverName>__*` 工具，不写 profile 配置、
不影响其他会话、会话销毁自动回收。这与「召唤专家」一致 —— 早期版本写成 profile 级
（往 `cordis.patch.yml` 加受管块），那会让所有会话白付一堆工具 schema 的 token，已废弃。

机制依据（源码事实，逐条实测）：

| 事实 | 出处 |
|---|---|
| agent 实例本身就是 scope key | `dsh-agent-loop`: `this.scope = createScope(loopCtx, this)` |
| 按会话注册工具是官方入口 | `dsh-tools` 重复注册报错原文：*for a per-agent variant, register through that agent's `agent.ctx` instead* |
| MCP serverName 按 scope 分桶，跨会话可同名 | `dsh-mcp-client`: *Agent-scoped MCP servers may reuse a namespace in another Agent* |
| 子 fiber 随 scope 自动清理 | 真 cordis 实测：dispose 计数 0→1，且不影响其他会话 |
| root 层插件能收到会话事件 | 真 cordis 实测 `ctx.serial(scopeTarget(agent,agent),"agent/created",…)` 可被 root 层 `ctx.on` 收到 |

所以实现就是 `agent.ctx.plugin(mcpClient, config)` 一行挂载，**不需要生成 YAML、
不需要 reconcile、不需要备份轮转**。`agent/created` 时按存储的接入意图重建挂载
（重启后恢复），`agent/disposed` 时摘引用。

### 凭据：只在内存解析，绝不落盘

WorkBuddy 的 `${VAR}` 在挂载时用 `process.env` 就地解析；**落盘的只有「哪个会话接了哪个
连接器」的意图，不含 config**。踩过把带真实令牌的 config 写进 `session-connectors.json`
的坑，已由 `tests/session-isolation-check.mjs` ④ 断言守住（磁盘不含明文、不含 config 字段）。

### 分级只认实测握手，不认清单标签

实测 248 条无占位变量的远端 endpoint：按静态规则（auth_mode 为空 + URL 无 `${VAR}`）判成
ready 的有 **232 条**，而真实 `initialize` 握手只有 **32 条 200**、**201 条 401/403** ——
乐观 7 倍。清单标签本身也不可信：`kdocs` 标 `server-side` 却握手 200，
`westock-mcp` 标签为空却要 WorkBuddy 代持的 Bearer。

所以分级来自 `connector-probe-cache.json`（真实握手结果，TTL 7 天），没探测过的一律
`unverified`，**不猜可用**：

| level | 含义 | 实测条数 |
|---|---|---:|
| `ready` | 握手 200，免鉴权可直接用 | 32 |
| `needs-token` | 握手 401/403，需自行获取 Bearer 填 headers | 200 |
| `needs-credential` | URL/env 含 `${VAR}`，填了就能用 | 13 |
| `unreachable` | 握手 404/超时/网络错误 | 15 |
| `blocked` | CLI 型，无 MCP server 定义 | 46 |
| `unverified` | stdio 型或未探测 | 11 |

按需验证：`POST /connector-probe {connectorIds:[…]}`（并发限 6；**stdio 型不自动探测** ——
那会真的执行 `npx` 拉包，有副作用）。

## 兼容垫片：让专家包不改一个字就能跑

WorkBuddy 金融类专家团的成员 prompt 里写着 `westock-data quote sh600519`、
`westock-tool filter "..."`，但**这两个名字在 WorkBuddy 里只是技能目录名**——
技能自己的文档（`skills/westock-data/SKILL.md`、`references/commands.md`）通篇是
`westock <子命令>`，`westock-data quote` 出现 **0 次**；真实命令是官方 Go 二进制 `westock`
（`stockbuddy.qq.com/release/workbuddy/cli`，技能包自带安装脚本 + SHA256 信任根校验）。
所以模型报「CLI 不可用，改用 curl/WebSearch」是**上游文档笔误**，不是环境缺装。

插件 `bin/` 自带两个垫片，启动时由 `lib/shims.js` 装进 PATH：

| 垫片 | 做什么 |
|---|---|
| `westock-data` | ① 名字映射：`asfund/usfund/hkfund→fund flow`、`blocktrade→fund block`、`lgt→connect`、`newsdetail→news detail`、`etf-nav→etf nav`…；② **参数翻译**（见下）；③ 官方确实没有的能力（`board`/`watchlist`/`exdiv`…）明确报错并给替代命令 |
| `westock-tool` | 技能包里 `scripts/index.js` 的 `bin` 声明只在 WorkBuddy 进程内生效，不进 PATH。垫片按 `teamInfo`/市场目录动态定位该入口并转发，**不硬编码路径**（市场更新会换目录） |

**为什么不能只做名字转发**——实测真实 CLI 会**静默忽略**多余位置参数：

```
westock kline sh600519 day 20   → 返回 100 行（默认 limit），不报错
westock finance sh600519 4      → 返回默认 3 期，不报错
```

光改名字，模型会拿着 100 行数据以为是自己要的 20 行继续分析——**比直接报错危险得多**。
所以垫片把专家惯用形态翻译成真实 flag，实测：

```
westock-data kline sh600519 day 20      → 20 行 ✓
westock-data finance sh600519 lrb 4     → 4 行 + --type income ✓
westock-data asfund sh600000            → fund flow ✓
westock-data board                      → exit=2 明确报错（不静默返回空）
```

调试开关：`WB_SHIM_DRYRUN=1 westock-data kline sh600519 day 20` 只打印翻译结果。

**自装的安全边界**（`tests/shim-check.mjs` 逐条断言）：只覆盖带
`shim-of: dsh-workbuddy-summon` 标记的文件，目标位置被他人占用一律跳过并告警；
内容一致不动盘（幂等）；无可写目录时安全返回而非抛异常。**不代装** `westock` 本体
（腾讯发布的 9MB 二进制），只检测缺失并打印官方安装命令。

> 注：`~/.workbuddy/bin` 在 PATH 里排第 5 位、`~/.local/bin` 第 11 位。若 WorkBuddy
> 运行时自己注入了同名命令，会自然优先于本垫片——两者不冲突。

## 模型侧工具

| 工具 | 用途 |
|---|---|
| `wb_experts_list` | 列目录（kind / category / q / limit / refresh） |
| `wb_expert_read` | 取原文：不传参=包清单；`agent=`成员定义；`skill=`技能正文；`skill+ref=`分层细节 |
| `wb_summon` | 把某专家召唤进**当前会话**（等价于点 UI 的召唤） |
| `wb_unsummon` | 取消当前会话的召唤 |
| `wb_connectors_list` | 列连接器目录 + 可接入性分级 |
| `wb_connector_install` | 把连接器接入 / 移除出**当前会话** |

长文本一律分段返回（默认 24k 字符/段，`nextFrom` + `from=` 续读）——WorkBuddy 市场里 1315 个 SKILL.md 有 167 个超 20k、最大 257k，绝不整块灌。

## HTTP 路由（渲染进程同源 fetch，免 token）

```
GET  /dsh-workbuddy-summon/status[?sessionId=]      健康 + 目录状态 + 当前召唤
GET  /dsh-workbuddy-summon/catalog?kind&q&category&refresh=1
GET  /dsh-workbuddy-summon/entry?plugin=            单包详情（成员/技能/引导语/快捷提示）
GET  /dsh-workbuddy-summon/avatar?plugin=&size=&agent=   头像 image/png（缩略+缓存）
POST /dsh-workbuddy-summon/summon    {sessionId, plugin}
POST /dsh-workbuddy-summon/unsummon  {sessionId}
```

## 头像：实时代理，本地不存图

清单 465 条**全部带 `avatar` 字段**；去重后的 451 条目录按形态分布：

| 形态 | 数量 | 例 | 处理 |
|---|---|---|---|
| 市场根 `/avatars/…` | 433 | `/avatars/ContentCreator.png` | COS 服务端缩略 |
| 包内 `/plugins/<pkg>/avatars/…` | 15 | `/plugins/design-engine/avatars/team.png` | COS 服务端缩略 |
| 本机市场包相对路径 | 3 | `avatars/expert.png` | 读本机包目录（不联网） |

**专家团成员各有头像**（`members[].avatar`，55 个专家团全含，如 `avatars/CloudOpsTeam-CloudQ.png`）——面板里最该露脸的部分。

### 关键发现：COS 开了服务端图片处理

腾讯云 COS 的「数据万象」在这条公开桶上可用，**缩略由 COS 实时完成**：

```
GET <原图>?imageMogr2/thumbnail/64x
  /avatars/ContentCreator.png   313KB/512px → 8.2KB/64px，alpha 通道保留
  /plugins/…/avatars/team.png   1.4MB       → 1.8KB（包内路径同样有效）
  *.jpg                        → image/jpeg（不会误报 png）
  不存在的文件                  → 404（不会伪造 200）
  非图片文件带该参数            → 400
```

所以 `lib/avatars.js` 只做**代理**：按目录条目的 `avatar` 字段拼出带处理参数的 URL 向 COS 取，进程内 LRU（6MB 上限）+ 同 key 并发合并兜住一屏几十张的重复请求。**插件里不存任何图片资产**——这是"跟着他的数据动"的必要条件：预生成一份缩略图等于把数据冻在本地，WorkBuddy 新增专家或换头像都会看不到。

（曾走过构建期 `sips` 预生成 799 张 64px 落进插件 `thumbs/` 的路线，已废弃并删除：一是违背实时，二是发现同名冲突 bug —— 不同包的 `avatars/expert.png` 会互相覆盖成同一张。`wb-resources/expert-market/build_avatars.py` 保留但输出改到本地审阅目录，插件不再消费。）

### 为什么不放行渲染进程直连 COS

① 会把「插件在替谁拉数据」暴露在浏览器网络面板；② Electron CSP 的 `img-src` 白名单不含该域；③ 走宿主同源路由（`webServer` prefix，免 token）才可控缓存语义。

### 缓存：短 max-age + 内容 ETag

```
GET /dsh-workbuddy-summon/avatar?plugin=&size=&agent=
  ETag: W/"<内容 sha1 前 16 位>"
  Cache-Control: public, max-age=300
```

不能像静态资源那样 cache 一天 —— 那会让 WorkBuddy 换头像后最长一天看不到新图。命中 `If-None-Match` 返回 304 空体，既省流量又不挡更新。

### 安全边界

`ref` 一律由服务端从目录条目里查出（`entry.avatar` / `members[].avatar`），**不接受调用方传入路径**；仍额外挡一次 `..` 与非图片扩展名。实测 `/avatars/../../etc/passwd` → 404 `no-avatar`。`Content-Type` 按字节魔数嗅探而非照抄扩展名。

取不到图时组件 `onError` 回退首字圆形，不留空洞。URL 由 `plugin` 现拼而非依赖持久化状态，所以**改动前写下的旧召唤状态也能正常显示头像**。


## 召唤后注入什么

1. 身份声明 + **团长/单专家的完整定义原文**（超 24k 截断并给出续读指引）；
2. 团队编制表（Agent ID / 花名 / 职业）+ **调度映射表**；
3. 协作铁律（TeamCreate 只能主理人做、成员结论为准、禁止代写、禁止 spawn 自己…）；
4. 配套技能清单（只给名字 + 一行摘要 + 分层细节数量，正文按需取）。

**成员定义不预先整团注入** —— 派发谁才用 `wb_expert_read` 取谁，再放进 `spawn_teammate` 的 prompt。实测一个 6 人团注入约 6.4k 字符（≈4k token），而不是整团 15k+。

### 为什么要「调度映射表」

WorkBuddy 原文写的是它自己运行时的原语，DSH 里不是这些名字，不改写模型会去调不存在的工具：

| 定义里的写法 | DSH 实际怎么做 |
|---|---|
| `TeamCreate` | Lead 直接 `spawn_teammate` 即建团 |
| `Agent(name, subagent_type)` | `spawn_teammate(name="<Agent ID>", prompt=…)` |
| `SendMessage` 回传主理人 | `send_message(target="lead")` |
| `maxTurns` | 无等价参数，用「每阶段简报进度」控制节奏 |

官方那条「禁止成员互相直连」红线**原样保留**（DSH 本身允许 peer 互发，所以要在 prompt 里显式约束）。

## 离线回归（不用重启 DSH）

```bash
cd ~/.dsh/local-plugins/dsh-workbuddy-summon
node tests/render-check.mjs         # 目录→取包→注入文本，8 项断言
node tests/host-probe.mjs           # 假 ctx 跑 apply()：路由/工具/求值器/取消，全链路
node tests/paging-check.mjs         # 分页续读、ref 取用、路径穿越防护
node tests/matrix-check.mjs         # 多形态（6人团/21人团/单专家/骨架包）+ 去重
node tests/ui-shape-check.mjs       # UI 依赖字段与分类下拉
node tests/local-package-check.mjs  # 本机社区包（云端清单里没有的）能否召唤
node tests/avatar-check.mjs         # 头像三类路径 / LRU / 并发 / 尺寸归一 / 安全边界
node tests/avatar-route-check.mjs   # 头像 HTTP 路由：PNG magic、ETag、304
node tests/section-gc-check.mjs     # 注入段落盘：删除而非写空串、sweep 不误删活文件
node tests/shim-check.mjs           # 垫片自装：幂等、只覆盖自己装的、无可写目录不抛异常
node tests/connector-route-check.mjs # 连接器路由与工具面（会话挂载、隔离、幂等、分级）
node tests/session-isolation-check.mjs  # 会话隔离：需 ELECTRON_RUN_AS_NODE 跑（import asar 内的真 cordis/dsh-scope）
# 垫片翻译是否正确（改完 bin/westock-data 必跑）
WB_SHIM_DRYRUN=1 westock-data kline sh600519 day 20   # 只看翻译，不联网
```

## 生效边界与回滚

- 本包是 **bundle 型**（`package.json` 带 `dsh.bundle.patch`）→ 进 profile 的 `dsh.profile.bundles`，**不要再往 `cordis.patch.yml` 里 insert 同 id**，否则 `duplicate loader entry id` 整树起不来。
- 安装：`plugin_manager` → `install_bundle`，target 填本目录绝对路径。已装好（`application: applied`）。
- **新增 Host 半边 JS / 新增 client 半边 → 必须完全退出并重开 DSH**（Cmd+Q）。只改已挂载插件的 `lib/client.js` 内容 → 刷新页面即可。
- 回滚：`plugin_manager` → `remove_bundle`，target `dsh-workbuddy-summon`；再删 `~/.dsh/workbuddy-summon/`。

## 已知边界

- **200 个包只有骨架**：它们在 COS 上 `plugin.json` 与 `promptFile` 都 404（走登录态 zip 分发）。召唤这类包会明确报「定义取不到」而不是假装成功。补法：在 WorkBuddy 里召唤一次，包落到 `~/.workbuddy/plugins/` 后本机市场源（④）就能读到。
- 连接器的 200 条 `needs-token` 是**实测 401/403** 得来的：WorkBuddy 用自己的账号态换 Bearer，
  DSH 侧要么让用户自己提供令牌，要么复用 WorkBuddy 登录态（后者涉及读解密凭据存储，未实现）。
- 连接器接入是**会话级**：换会话需重新接入；重启后由 `agent/created` 按存储意图自动重建。
- `config.connectors.enabled: false` 可整体关掉连接器工具与 tab（默认开）。
- 专家包的 `skills/`、`bin/` 里的可执行脚本**不会**被自动执行，只作为文本按需读取。

---

## ☕ 赞赏支持

如果 dsh-workbuddy-summon 对你的研究与测试有所帮助，欢迎请作者喝杯咖啡 ☕

<p align="center">
  <img src="assets/sponsor.jpg" width="260" alt="微信赞赏码" />
  <img src="assets/afdian_reward.jpg" width="200" alt="爱发电赞助码" />
</p>

<p align="center">
  <b>给项目点个 Star ⭐</b> 同样是对开发者最大的鼓励！
</p>
