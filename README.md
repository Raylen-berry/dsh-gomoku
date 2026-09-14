# dsh-gomoku · 会话页小游戏（五子棋）

给 DSH Desktop 的会话页加一个 **「小游戏」** 标签页（就在「对话 / 轨迹 / 审批」旁边），
内含五子棋：**可弹出右下角浮窗（可收起）**，并且能调度你**已配置的任意模型**互相或与你对战。

> 模型走棋是真的调 LLM：把 15×15 棋盘转成 15 行文本发过去，只要它回一个「行,列」。
> 用的是你自己配置的 provider，**按你该 provider 的计费走**（一步棋约几百 input + 几百 output token）。

---

## 1. 功能

| 模式 | 说明 |
| --- | --- |
| 我 vs 模型 | 你执黑先手；对手从模型下拉里选（默认 = 本会话当前模型）。**注意：目录里列出的模型不一定你账号可用，先点「体检模型」** |
| 模型 vs 模型 | 黑白各选一个模型，自动对局（每步之间停 450ms，便于观战） |
| 我 vs 我（双人） | 同机两人轮流落子 |

- **浮窗**：会话页右侧点「弹出小窗」→ 右下角浮窗；点标题栏收起（只剩一行），点 `×` 关闭。
  浮窗和标签页**共享同一盘棋**，切来切去不会丢局。
- **悔棋**：我 vs 模型退两步（你和它各一步）；双人 / 机机退一步。
- **战术引擎**：host 半先用引擎算出 8 个候选点（成五 / 挡五 / 活四 / 挡活四 / 活三…），
  把清单和理由一起发给模型，模型只需在好点里挑一个 ⇒ flash 级小模型也不会"乱下"。
  棋盘下方同时显示「模型下了哪」「引擎首选是哪」，弱模型弱在哪一眼可见。
- **引擎否决权（强制手）**：引擎判定"必须先处理这里"时（对方活三及以上、双方五连），
  **不由模型说了算** —— 直接按引擎下，并写明「模型选了 (x,y)，但引擎判定必须先处理 (r,c)：原因」。
  起因是用户实测反馈"我明显有活三，它却不堵"：这种局面不是该信任弱模型的地方。
- **省额度模式（默认关）**：控制栏里的「省额度」勾选框。打开后，**引擎判定为强制手的那一手
  直接落引擎坐标、根本不发模型请求** —— 因为那种局面在评测模式下模型答什么都会被引擎改回来，
  那一次调用纯属白花 token。非强制手照旧问模型（棋力不变），落点与关着时**逐手相同**
  （自检 `tools/verify-quota.mjs` 里对拍了同一盘 20 手棋谱）。
  界面上用一句话标出这一手的来源：`⚙ 引擎直落（没花 token）` / `⚙ 引擎对手（不花 token）` /
  `⚙ 模型想下的被引擎否决` / 模型名 + 坐标。
  **开关状态记在浏览器 `localStorage`（key `dsh-gomoku:save-quota`），重启后保留**；
  host 半仍然不存任何设置/对局状态（只认请求里的 `saveQuota` 字段，缺省 = 关）。
  实测：一盘 20 手的棋谱里强制手占 11 手 ⇒ 开着时模型调用 20 次降到 9 次（用假 llm 计数，
  没有真调模型）。
- **内置引擎三档**（不花 token、0.03s）：`引擎·强`（多推一层对手回应）/
  `引擎·标准`（单层战术）/ `引擎·轻`（前几手随机，会失误，想赢就选它）。
- **体检模型**：点「体检模型」会**真调**该 provider 下的每一个模型，显示 `✓ 耗时 / ✗ 错误`。
  （实测价值：你的 moonshotai 账号 10 个模型里只有 4 个真能用，不体检根本看不出来。）
- **兜底**：模型没给出合法坐标时，直接采用引擎首选（比"就近随便下"强得多），并在状态行说明原因。
- **时间预算**：模型走棋慢的根源是推理模型的思考（实测 2.6s / 8.9s / 12.1s）。所以有「⚡快 2.5s /
  标准 5s / 耐心 15s / 不限时」四档：到点未回就让引擎接着下，界面会写明「超时未回 → 引擎代打」。
  不想花 token 也不想等，直接把对手选成 **⚙ 内置引擎**（0.03s）。
- 胜负判定：四方向连成五子即胜；棋盘落满为和棋。

---

## 发布前检查（CI 与本地同一条命令）

push / PR 都会跑 `.github/workflows/ci.yml`，它只做一件事：`npm test`。本地跑的就是同一条命令，
**不装任何依赖、不联网**：

```bash
npm test                       # = node tools/run-all.mjs
node tools/run-all.mjs --list  # 只看清单：跑哪些、以及哪些被排除、为什么
```

`tools/run-all.mjs` 把每套都跑完再汇总，任一套非 0 退出 ⇒ `npm test` 退出码 1 ⇒ CI 变红。
CI 用 Node 20/22/24 三档矩阵、windows-latest。

本机实测（Node 24.9.0）：

| 套件 | 本机结果 |
| --- | --- |
| `tools/verify-gomoku.mjs` | 52 项通过 |
| `tools/verify-race.mjs` | 29 项通过 |
| `tools/verify-quota.mjs` | 125 项通过（省额度模式） |

`tools/png-look.mjs` 是给人看棋盘的查看器、不是测试套件，未纳入（也不调模型）。

**反向验证**（新断言确实指向新实现，不是"写了就绿"）：拿改动前的树跑同一套断言，必须红。
用临时 worktree 做——**不要 `git stash`**（工作区里的半成品改动不能被卷走）：

```powershell
git worktree add --detach ..\_gomoku-base 89873a8     # 改动前的提交
$env:DEEPSEEK_GOMOKU_OLD_TREE='..\_gomoku-base'; node tools\verify-quota.mjs
# 本机实测：通过 69 项，失败 57 项（退出码 1）
Remove-Item Env:\DEEPSEEK_GOMOKU_OLD_TREE
git worktree remove ..\_gomoku-base --force
```

失败的 57 项全部集中在本次新增的行为上（`forcedMove`/`moveSourceOf`、响应里的
`moveSource`/`modelCalled`/`saveQuota`、client 的开关与落盘、强制手时模型请求数 = 0），
而 `verify-gomoku` / `verify-race` 的既有 81 项在旧树上照旧通过 —— 这正是"没修过头"的证据。

## 2. 安装

### 2.1 本机（已装好）

本插件以 `link:` 形式挂在 Web profile 下：

```powershell
# 方式 A：用 dsh CLI（推荐）
dsh plugin --profile web add link:E:\deepseekagent\dsh-gomoku-main

# 方式 B：手工建 junction，等价于 link:
New-Item -ItemType Junction `
  -Path "$env:APPDATA\dsh-desktop\harness\profiles\web\node_modules\dsh-gomoku" `
  -Target "E:\deepseekagent\dsh-gomoku-main"
```

### 2.2 换台机器：可迁移性与必须手动的步骤

1. **必须有 DSH Desktop**（本插件是 DSH 插件，不是独立程序）。
2. 把本仓库放到新机器任意目录，然后按 2.1 的方式 B 建 junction（或 `dsh plugin add link:<路径>`）。
3. **必须重启 DSH Desktop**：client 半（`client.js`）在 **DSH 启动时**与其它插件一起 compose，
   **刷新网页不够**，不重启就看不到「小游戏」标签页。
   ⚠️ **这一条对"只改了 client 半"的更新同样成立**：改完 `client.js`（例如加了控制栏里的
   「省额度」勾选框、改了来源文案）必须**重启 DSH Desktop** 才生效，刷新页面看不到新界面 ——
   因为 client 半的 bundle 是启动期 compose 出来的，不是每次刷新重新读文件。
   （host 半 `index.js` 的改动也是随 DSH 启动加载，同样要重启。）
4. **本插件不需要任何浏览器扩展、不需要任何外部服务、不需要额外的 API Key**
   （模型走你 DSH 里已经配好的 provider）。
5. 换机后**棋局不继承**（棋盘只活在页面内存里，不落盘）；模型选择也每次重选。
6. 若新机器的 DSH 目录不在默认位置，把 `$env:APPDATA\dsh-desktop\harness` 换成该机器的
   `$DSH_HOME`（例如桌面版可能落在 `C:\dsh-data\dsh-desktop\harness`）。

---

## 3. 给后续 agent / 维护者：接口与实现要点

### 3.1 HTTP 路由（host 半，客户端 fetch 调用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/gomoku/models` | 模型目录：`{ providers: [{id,name,models:[{id,name}]}], current: {provider,model} \| null }`。**60 秒内复用**；带 `?reload=1` 强制刷新 |
| POST | `/gomoku/move` | 请求 `{provider, model, name, side(1黑/2白), size, cells(长度 size*size), history:[{r,c,side}], timeoutMs?(0=不限时，默认 5000), saveQuota?(true=省额度模式，缺省/false=评测模式)}`；响应 `{r, c, fallback, from:'text'\|'reasoning'\|'fallback'\|'engine'\|'engine-timeout'\|'engine-forced'\|'engine-direct', moveSource, modelCalled, saveQuota, timedOut, timeoutMs, engine:{r,c,reason}, agreedWithEngine, candidates[3], text, reasoning, finishKind, usage, ms, name}`；失败返回 500 `{ok:false,error}`。`provider:'engine'` 时完全不调模型（0ms、不花 token） |
| GET | `/gomoku/selftest` | **模型体检**：`?provider=<id>[&force=1]`，逐个真调该 provider 的所有模型，返回 `{provider, usable, total, results:[{model,name,ok,ms,error}]}`。60 秒内复用最近一次结果（加 `force=1` 强制重测） |

`cells` 是一维数组，`index = r * size + c`，`0` 空 / `1` 黑 / `2` 白。

#### 强制手 / 省额度模式（`saveQuota`）

**强制手判据只有一处**：`rankMoves(...)` 的**第一候选** `urgency ≥ 2`（`FORCED_URGENCY`，
判据函数 `forcedMove()`）。`urgency` 在 `rankMoves` 里按战术价值赋值：

| urgency | 触发条件 | 含义 |
| --- | --- | --- |
| 5 | `atk >= 1000000` | 我下这里直接连成五子 ⇒ **必胜手** |
| 4 | `def >= 1000000` | 对方下这里就连成五子 ⇒ **不挡就输** |
| 3 | `atk >= 120000` | 我下这里成活四（两头能成五） |
| 3 | `def >= 120000` | 挡对方活四 |
| 2 | `def >= 9000` | **挡对方活三**（最高优先级：对方活三不挡＝输） |
| 0-1 | 其余（活二/眠三/贴身扩张） | 没有"必须"，交回模型判断 |

（`>= 12000` 的冲四不在上表里：它由 `def/atk >= 120000` 与 `>= 9000` 之间那条**没被赋值**
的区间落空 —— 冲四既不构成强制手，也只在 `lineValue` 里体现为分数。这是现状，
改动它等于改动既有棋路，别顺手改。）

两种用法共用同一条判据，所以**省额度省掉的调用，恰好就是评测模式里会被引擎否决的那一次**：

- **评测模式（默认，`saveQuota` 缺省/false）**：照旧先问模型，答完之后若 `forced` 非空且模型
  的选择与引擎坐标不同 ⇒ `overridden: true`、`from: 'engine-forced'`，按引擎坐标落子。
- **省额度模式（`saveQuota: true`）**：**在发请求之前**就问 `forcedMove()`；是强制手就直接落
  引擎坐标返回（`from: 'engine-direct'`、`modelCalled: false`、`ms: 0`、`text/reasoning` 为空），
  **一次模型请求都不发**。非强制手完全走上面那条路。

`modelCalled` 是新增的可核查字段（"这次到底花没花 token"），`moveSource` 是给界面用的
来源口径（`engine-direct` / `engine-opponent` / `engine-timeout` / `engine-veto` /
`model-fallback` / `model`）。**评测模式的响应只是多了这三个字段**，其余逐字段与加开关前
一致（`tools/verify-quota.mjs` 的 [6] 段与改动前的树逐字段对拍）。

### 3.2 踩过的坑（改了会退化的地方）

1. **`StreamChunk` 不只有 `text-delta`，还有 `reasoning-delta`。**
   推理模型会先把 `maxTokens` 花在思考块上；只读 `text-delta` 会拿到空串，
   于是把"模型回答得好好的"误判成"模型不听话"。**两者都要收**，正文优先、思考块兜底。
2. **`maxTokens` 不能太小。** 曾经给 64，直接被思考块吃光（`finishKind === 'max-tokens'`）⇒ 空正文。
   现在给 512，一步棋仍然很便宜。
3. **解析要"全文扫描 + 逐个候选试到合法空点"**，只取第一个正则匹配会因模型多说一句话而失败。
4. **client 半取服务用 `inject: ['slots','timer']` + `ctx.slots`。**
   早期动态版本用 `ctx.get('slots')` 并在 `undefined` 时静默 `return`，
   结果两个槽位都没注册、且运行时状态显示正常（零诊断）——**静默返回是诊断黑洞**。
5. **动态 Cordis 插件版的标签排在标签栏最左**：动态条目带负优先级，
   `order` 管不了它的位置；本常驻插件版走正常优先级，按 `order: 25` 排在「审批」右侧。
6. **页面刷新后，动态插件版可能出现"标签暂时不在"**：注册落在标签栏快照 store 建立之后，
   要等一次槽位变更才刷新。常驻插件版在启动期注册，不存在这个问题。
7. `shell.overlay` 整层是 **click-through** 的：浮窗自己必须显式 `pointerEvents: 'auto'`，否则点不动。
8. **绝对不要传 `temperature`。** 这是本插件最坑的一条：Kimi 系列只接受它们各自规定的值
   ——`kimi-k2.5`/`kimi-k2.6` 要 `0.6`，`kimi-k2.7-*`/`kimi-k3` 要 `1`；传 `0.3` 会被直接 400 拒掉。
   **不传则用服务端默认值，三个 provider 全部可用**（实测：DeepSeek v4-flash/v4-pro、Qwen 3.8-flash/max
   不传 temperature 均正常返回）。所以 `llm.stream` 的 options 里没有 `temperature` 这一项。
9. **目录里列出的模型不等于你能用的模型。** moonshotai 目录列了 10 个，实测只有 4 个可用：
   `kimi-k2.6`、`kimi-k2.7-code`、`kimi-k2.7-code-highspeed`、`kimi-k3`；
   而 `kimi-k2-0711-preview`、`kimi-k2-0905-preview`、`kimi-k2-thinking`、`kimi-k2-thinking-turbo`、
   `kimi-k2-turbo-preview` 全是 404 `Not found the model … or Permission denied`。
   最阴的是 `kimi-k2.5`：带着 temperature 报 400、**把真正的 404 盖住了** ——
   所以体检探针一律不传 temperature，才能看到真实的可用性。
10. **棋盘几何只有 `boardGeom()` 一个来源**（网格线位置 = 热区中心 = 棋子圆心），
    且棋子必须 `boxSizing: 'border-box'`：白子那圈 1px 描边若算在尺寸外（content-box），
    白子会比黑子大 2px、圆心还会偏 1px（浏览器实测 190.8 vs 交点 190）。
11. **模型走棋的强弱主要是引擎的功劳，不是模型的。** 别把 `rankMoves` 删了直接让模型裸算坐标
    —— flash 级模型在 225 个点里瞎选的结果基本等于随机。
12. **"模型慢"慢在思考，不在网络。** 同一个中局实测（时间 / usage）：

    | 对手 | 耗时 | usage | 结局 |
    | --- | --- | --- | --- |
    | 内置引擎 | **0.03s** | 不花 token | 直接给第一候选 |
    | deepseek-v4-flash | 2.57s | in=470 out=512 **think=512** | `finishKind=max-tokens`、正文为空，坐标是从**思考块**里扫出来的 |
    | deepseek-v4-pro | 8.93s | in=523 out=512 **think=512** | 同上 |
    | kimi-k3 | 12.08s | in=540 out=86 | `finishKind=stop`，正常回答 |

    两个推论：① 把 `maxTokens` 调大只会更慢，调小则连思考都被截断；② 真正的解法是**给时间预算**
    —— 客户端「⚡快 2.5s / 标准 5s / 耐心 15s / 不限时」，到点未回就让引擎接着下，
    响应带 `timedOut:true` + `from:'engine-timeout'`，界面写「超时未回 → 引擎代打」。
    模型下得慢是模型的事，不该让对局卡住。
13. **棋子用 SVG `<circle>` 画，不要退回 `border-radius: 50%`。** 这套环境
    `devicePixelRatio = 1.25`，19px 的圆形会落在 **23.75 个设备像素**上 —— 分数设备像素下
    Chrome 会把它栅格成**圆角方形**。这不是玄学，是量出来的：同一屏截图的像素统计
    填充率（实心/外接方框）**棋子 0.830、正圆应为 0.785**，而 60px 的对照组刚好 0.781；
    圆角 30% 的对照组是 0.940。改成 SVG 后直径取 **20 / 16**（×1.25 = 25 / 20，整数设备像素）。
    自检里加了 `stoneShape()` 的圆心/描边/直径断言，`tools/png-look.mjs` 可以随时复现像素级验证。
14. **`deepseek-v4.1-flash-*` 那一串内测 id 已全部失效**（实测 5s 后 `request failed`），
    API 现在的正式名字是 **`deepseek-flash`** 与 **`deepseek-v4-pro`**（API 报错原文就写了这两个）。
    模型目录是**用户侧配置**（`$DSH_HOME/settings.yaml` 的 `llm-deepseek.models`），改完当场生效、不用重启；
    图片能力靠条目里的 `inputModalities: [text, image]` 声明 —— 没声明的模型就是纯文本模型。
15. **省额度模式与"引擎否决"必须共用同一条判据，不能各写一遍。**
    判据就一个：`forcedMove(ranked)`（第一候选 `urgency ≥ 2`）。省额度模式**提前**问它（问了就不发请求），
    评测模式**答完**问它（答了也要改回来）；两处一旦漂移，省额度就会省掉"本来该听模型的"那一手
    （省了棋力）或者放过"反正会被否决"的那一手（没省到）。自检 `verify-quota.mjs` 的 [4] 段
    就是钉这条不变量的：同一局面下 ON/OFF 两档落点必须完全相同。
16. **判据只看第一候选，这是"与既有机制一致"，不是"最优强制手识别"。**
    实测反例：白方活三在 (7,4)-(7,6)、黑方自己也有活三时，引擎第一候选是**黑方自己的进攻三**
    （`atk=9042`，urgency 0/3 由 `atk >= 120000` 决定 → 实际 urgency 0），而"挡白方活三"那个点
    （`def=9042 ≥ 9000` ⇒ urgency 2）排在候选第 3 名 —— 此时 `forcedMove` 返回 null。
    但**评测模式本来就不会否决这一手**（它同样只看 `ranked[0]`），所以省额度模式在这类局面里
    和评测模式行为一致：照旧问模型。两者都不算"完美强制手识别"，但**口径一致**是本次改动的硬要求。
17. **设置写盘在前端（`localStorage`，key `dsh-gomoku:save-quota`），host 半不存任何设置。**
    别为了"统一"把开关搬到 host：host 半的单一职责是"不存对局/设置状态"（见 `index.js` 文件头），
    而且 host 落盘会引入"同一台机器多个浏览器/多个 profile 状态打架"的问题。

### 3.3 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | host 半：模型目录 + 走棋 + 模型体检（`inject: ['webServer','llm']`），三条路由；战术引擎 `rankMoves` 也在这里 |
| `client.js` | client 半：`conversation.view` 标签页 + `shell.overlay` 浮窗；棋盘几何 `boardGeom()` / 棋子形状 `stoneShape()`（SVG 圆） |
| `cordis.patch.yml` | 挂载声明（bundle patch），插入 id `gomoku` |
| `tools/verify-gomoku.mjs` | 离线自检 **52 项**：胜负判定、坐标解析、棋盘几何、棋子形状、战术引擎、紧急度与强制手 |
| `tools/verify-race.mjs` | 离线自检 **29 项**：跨局竞态 —— 旧局（gen 已过期）的请求落地，不得动新局的 `busy`/思考文案/棋盘/错误提示。把 client 半的真身跑在假 `react`+假 `fetch` 上，走子请求交回可手动落地的句柄，于是「起请求 → 换局 → 让旧 promise 落地」可确定性复现 |
| `tools/verify-quota.mjs` | 离线自检 **125 项**：省额度模式。假 cordis（假 `webServer` 收路由 + 假 `llm` 计数）跑 host 半的**真身**，于是"模型请求数"是真数出来的：① 强制手时模型请求数 = 0；② 非强制手仍调模型；③ 评测模式与改动前的树**逐字段**一致（`DEEPSEEK_GOMOKU_OLD_TREE` 指向旧树）；④ 开关默认关；⑤ 落盘往返同值（假 localStorage，重启后仍在）；⑥ 20 手棋谱统计强制手占比与省下的调用次数。另含"改前必失败"的反向验证用法 |
| `tools/lib-client-fake.mjs` | **不是套件**，是 `verify-race` / `verify-quota` 共用的假客户端运行时（假 `window.__ModuleLoader__` / 假 `react` / 假 `fetch` / 假 `localStorage`）。假 DOM 的行为只有这一个来源，否则两套结论迟早打架 |
| `tools/board-preview.html` | 棋盘几何预览（含"红点=交点"诊断盘），双击即可看，不用启动 DSH |
| `tools/png-look.mjs` | **截图取证工具**（通用，零依赖）：PNG → 字符画 + 指标。`--find` 自动定位色块（判据含长宽比加权）、`--light` 深底找白子、`--strict` 收紧掩膜、`--json` 只出数字。模型看不到图片时靠它把"看起来不对"变成可核查的数字 —— 本插件的棋子圆度问题就是它量出来的（`_tools\png-look.mjs` 只是转发壳） |

离线自检：

```powershell
cd E:\deepseekagent\dsh-gomoku-main
node tools\verify-gomoku.mjs
node tools\verify-race.mjs
node tools\verify-quota.mjs
```

---

## 4. 卸载

```powershell
Remove-Item "$env:APPDATA\dsh-desktop\harness\profiles\web\node_modules\dsh-gomoku" -Force
# 然后重启 DSH Desktop
```

（`dsh plugin --profile web remove dsh-gomoku` 等价。）

---

## 5. 许可

MIT
