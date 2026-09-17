ZSWAP — ZCode System Prompt Swap

> ZCode 桌面端系统提示词替换工具 · 多档案一键切换 · 提示词注入 · Web 控制台，为解决系统提示词限制而生

![定位](https://img.shields.io/badge/ZCode-System_Prompt_Swap-c9a227)![运行环境](https://img.shields.io/badge/Node-%E2%89%A518-3c873a)![By](https://img.shields.io/badge/By-X1A0Y-8b5cf6)![模型破限](https://img.shields.io/badge/模型-破限破甲-e5484d)![系统提示词](https://img.shields.io/badge/系统提示词-修改-6e56cf)

## 简介

ZSWAP 是 ZCode 桌面客户端的系统提示词切换工具。它把「系统提示词」做成可插拔档案：多套系统提示词一键切换，通过**提示词注入**写入 ZCode 的后端打包文件，一键增删改查记忆层文件，并提供一个带登录认证的 Web 控制台统一管理。

![image-20260918011232922](README.assets/image-20260918011232922.png)

![image-20260917232947158](README.assets/image-20260917232947158.png)

这是Zcode v3.12的系统提示词开头，明确要求模型拒绝APT攻击、供应链安全，对于免杀研究也有一定的授权限制
如图：(测试模型为2026-9-18 1:14时的GLM 5.3)
![image-20260917233658435](README.assets/image-20260917233658435.png)

修改系统提示词(安全段)后：

![image-20260918004528969](README.assets/image-20260918004528969.png)

### 修改前:

##### (测试模型为2026-7-17 1:14时的DeepSeek V4.0)

![image-20260813154100834](README.assets/image-20260813154100834.png)

![image-20260813154131152](README.assets/image-20260813154131152.png)

### 修改后:

##### (测试模型为2026-7-17 1:14时的DeepSeek V4.0)

![image-20260813154202413](README.assets/image-20260813154202413.png)

![image-20260813154301517](README.assets/image-20260813154301517.png)


## 快速开始

1. 双击 `start.bat`（"Zswap"）——启动后自动打开浏览器管理页
2. 在「提示词档案」里新建提示词（自动预填原始提示词，在原文基础上改）
3. 点档案的「激活」，再到「提示词注入」点「注入提示词」
4. 点「结束进程」→「启动 ZCode」——新提示词生效

### 安全设计

- 注入前自动按版本备份原始文件（`zcode-<版本号>.cjs`，同版本只存一份、永不覆盖）

- 锚点必须**恰好出现一次**才动手（防版本变化 / 防重复打）

- md5 状态跟踪：能区分「原始 / 已注入 / 外部改动」

- 一键字节级还原；手动快照自动保留最近 20 份

- 失败即透传 / 拒绝操作，绝不让工具把文件写坏

  

## 配置文件(~/tool.config.json

```
{
  "port": 8083,             //不填默认8083
  "username": "",           //不填默认空密码
  "password": "",           //不填默认空密码
  "zcodePath": "",          //ZCode位置。自动探测
  "patchTargets": [],       //探测失败时的人工候选路径
  "patchedMd5ByVersion": {},//各版本上次注入的 MD5（引擎自动维护）
  "zcodeExePath": ""        //ZCode.exe路径，Kill用
}
```

## 特性

- **分层档案**：JSON 三层（第一句 cli_prefix / 人设 identity / 安全段 important），每层独立注入；新建预填原始提示词，三层表单直接改
- **提示词注入**：备份 → 校验 → 写入 → 状态跟踪，全流程可回滚
- **Web 控制台**：档案表、注入面板、备份表、记忆库面板、操作日志、系统信息
- **登录认证**：可选账号密码， + 12 小时会话 Cookie
-  **一键重启**：一键结束 ZCode 进程 / 启动 ZCode
- **备份管理**：手动快照、逐份删除、锚点防误删
- **实际生效提示词**：一键提取 zcode.cjs 当前身份段，与激活档案比对，确认注入是否生效
- **CLI 工具**：`patch-cli.js` 支持全部核心操作（含 `effective` 查看实际生效内容）
- **自动适配**：ZCode 位置自动寻找并回填配置；端口冲突自动顺延；启动预热缓存（首屏秒开）

## 环境要求

- [Node.js](https://nodejs.org/) ≥ 18（零依赖，无需 `npm install`）
- ZCode 桌面客户端

## 目录结构

```
zswap/
├── server.js              # Web 服务：控制台 + 管理 API（认证）
├── patch-engine.js        # 注入引擎：定位/备份/注入/还原/进程管理/配置
├── patch-cli.js           # 命令行工具
├── public/
│   ├── index.html         # Web 控制台
│   └── login.html         # 登录页
├── prompts/               # 提示词档案（一档一个分层 .json）
│   └── active.json        # 当前激活档案（内部状态，不显示在档案列表）
├── backups/               # 备份目录（zcode-<版本号>.cjs 等，勿提交）
├── tool.config.json       # 配置文件（端口/账号/密码/ZCode 位置）
├── test/selftest.js       # 隔离环境自测（70 项断言，不触碰真实文件）
└── start.bat              # 一键启动
```

### 恢复原样

- 网页「还原原始文件」→ 重启 ZCode → 字节级回到出厂状态（从**当前版本**的基线还原，不会回滚程序版本）；
- 或命令行 `node patch-cli.js restore`；
- 兜底：把 `backups\zcode-<当前版本号>.cjs` 手动拷回原位置。

> ⚠️ `patchedMd5ByVersion` 由引擎自动维护；若某版本处于注入状态时其值被清空，状态会显示「被改动」且再次注入会被拒绝。如需清空，先「还原原始文件」再操作。

## 记忆库管理

控制台左侧「记忆库」面板直接管理 ZCode 的跨会话记忆（`~\.zcode\memory\`）：

- **MEMORY.md 是索引**：每会话开始载入系统提示词，一行一条（`- [标题](文件.md) — 钩子`）；索引行写得好坏直接影响召回命中率，可编辑、禁止删除
- **其余 `*.md` 每文件一条记忆**：含 frontmatter（name / description / metadata.type），可新建、编辑、删除
- 改动**对新会话生效**——已在运行的会话在开头就载入了索引快照，感知不到后续修改
- ZCode 的召回机制：平时只载入索引，聊到相关话题时由内部选择器把具体记忆条目以 `<system-reminder>` 注入；写入由后台异步完成

## 登录认证(默认不认证

- 配置文件同时填写账号和密码后，管理页与所有 `/api/*` 接口需要登录；
- 登录成功签发 12 小时会话 Cookie（`HttpOnly` + `SameSite=Strict`，随机 24 字节 token，内存存储）；
- 未登录：页面 302 → `/login`，API 返回 401；右上角「退出」注销会话；
- 豁免路径：`/healthz`、`/login`、`/api/login`、`/api/logout`；
- 服务只监听 `127.0.0.1`，认证用于防本机其他用户/进程误操作；服务重启后需重新登录。

## 备份管理

- 备份位置：`backups\` 目录；
- **版本感知基线**：每个 ZCode 版本保存一份 `zcode-<版本号>.cjs`（如 `zcode-3.12.3.7463.cjs`）。版本号取自安装目录 `ZCode.exe` 的 ProductVersion；`status` / `check` / `apply` 时若发现当前版本还没有基线且文件是原始状态，会**自动备份**（ZCode 每次更新都会重置 `zcode.cjs`，这保证每个新版本都自动留下可还原副本）；
- **手动检查新版本**：`node patch-cli.js check`，输出当前版本、基线状态，新版本自动备份；
- **还原按版本**：`restore` 只用「当前版本」的基线还原，绝不拿旧版本备份回滚新版程序；
- **手动快照**：「立即备份」或 `node patch-cli.js backup`，对当前 `zcode.cjs` 存一份时间戳快照；
- **清理规则**：时间戳快照自动保留最近 20 份；版本提示词基线（`zcode-<版本号>.cjs`）自动保留最近 20 份（按时间淘汰最旧的，当前版本的基线永不淘汰）；
- **锚点保护**：当前版本的 `zcode-<版本号>.cjs`、遗留的 `zcode.cjs.original` 与 `config.json.latest.bak` 是还原锚点，接口层禁止删除（403）。

档案是 `prompts\` 下的分层 JSON 文件。激活（一键，无弹窗）只是**选定注入的目标档案**；生效需注入并重启 ZCode。

### 分层档案（JSON，推荐格式）

档案是 `prompts\` 下的 **JSON** 文件，按层独立注入到系统提示词的不同槽位：

```json
{
  "cli_prefix": "You are DevMate, 我的技术搭档……",
  "identity": "你是专注于……的代理。",
  "important": ""
}
```

- `cli_prefix`：系统提示词第一句（原文 "You are ZCode, an interactive coding agent"）
- `identity`：身份句（Agent Identity 段的主体）
- `important`：安全段 —— `""` = 清空；填内容则替换；**字段缺省或 null = 该层保持原文**（cli_prefix / identity 同理）
- 三个槽位对应系统提示词的固定结构；`# Harness` 规则和运行时注入节（环境/技能/Memory 等）不占档案，由 ZCode 自己生成
- **编辑器**：控制台用三层表单（① 第一句 / ② 人设 / ③ 安全段）编辑，留空 = 该层保持原文；**新建档案自动预填三层原始提示词**，在原文基础上修改即可
- 兼容：旧 `.md` 档案仍可注入（整份进 identity 层并清空安全段）；在控制台编辑保存后自动转为分层 JSON

**ZCode 自动更新后注入失效？** 更新会覆盖 `zcode.cjs`，控制台状态会显示「被改动」。此时 `check` 会自动把新版本的原始文件备份为 `zcode-<新版本号>.cjs`，重新点一次「注入提示词」即可（新版本基线自动建立，旧版本基线保留）。

**找不到 zcode.cjs？** 检查 `tool.config.json` 的 `zcodePath`；或设环境变量 `ZPS_ZCODE_CJS` 直接指定路径。

**端口被占用？** 工具自动向后顺延（最多 20 个）并把新端口写回配置；也可设 `ZPS_PORT` 指定。

**切换后没生效？** 十有八九是 ZCode 进程没真正退出（托盘常驻）。用「结束进程」再「启动 ZCode」。

**页面打不开？** 服务只绑定 127.0.0.1；确认 `start.bat` 窗口未关闭、端口正确；未启用认证时应可直接访问。

**忘了账号密码？** 打开 `tool.config.json`，把 `username` / `password` 清空（免登录），再重新设置。

**误操作想全盘恢复？** `node patch-cli.js restore`，或直接把 `backups\zcode-<当前版本号>.cjs` 拷回原位置。

## 免责声明

本工具用于**个人对已安装软件的本地自定义**，通过修改 ZCode 客户端的打包文件实现提示词替换。请勿用于规避任何服务条款；使用前请自行备份；本项目与 ZCode 官方无关。作者不对使用本工具造成的任何后果负责。
