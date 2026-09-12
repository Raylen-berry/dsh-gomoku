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
- **体检模型**：点「体检模型」会**真调**该 provider 下的每一个模型，显示 `✓ 耗时 / ✗ 错误`。
  （实测价值：你的 moonshotai 账号 10 个模型里只有 4 个真能用，不体检根本看不出来。）
- **兜底**：模型没给出合法坐标时，直接采用引擎首选（比"就近随便下"强得多），并在状态行说明原因。
- 胜负判定：四方向连成五子即胜；棋盘落满为和棋。

---

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
| POST | `/gomoku/move` | 请求 `{provider, model, name, side(1黑/2白), size, cells(长度 size*size), history:[{r,c,side}]}`；响应 `{r, c, fallback, from:'text'\|'reasoning'\|'fallback', engine:{r,c,reason}, agreedWithEngine, candidates[3], text, reasoning, finishKind, usage, ms, name}`；失败返回 500 `{ok:false,error}` |
| GET | `/gomoku/selftest` | **模型体检**：`?provider=<id>[&force=1]`，逐个真调该 provider 的所有模型，返回 `{provider, usable, total, results:[{model,name,ok,ms,error}]}`。60 秒内复用最近一次结果（加 `force=1` 强制重测） |

`cells` 是一维数组，`index = r * size + c`，`0` 空 / `1` 黑 / `2` 白。

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

### 3.3 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | host 半：模型目录 + 走棋 + 模型体检（`inject: ['webServer','llm']`），三条路由；战术引擎 `rankMoves` 也在这里 |
| `client.js` | client 半：`conversation.view` 标签页 + `shell.overlay` 浮窗；棋盘几何 `boardGeom()` / 棋子样式 `stoneStyle()` |
| `cordis.patch.yml` | 挂载声明（bundle patch），插入 id `gomoku` |
| `tools/verify-gomoku.mjs` | 离线自检 42 项：胜负判定、坐标解析、棋盘几何、棋子样式、战术引擎（不开浏览器） |
| `tools/board-preview.html` | 棋盘几何预览（含"红点=交点"诊断盘），双击即可看，不用启动 DSH |

离线自检：

```powershell
cd E:\deepseekagent\dsh-gomoku-main
node tools\verify-gomoku.mjs
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
