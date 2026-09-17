/**
 * ZSWAP — ZCode 系统提示词替换工具（Web 控制台）
 *
 * 原理：
 *   通过提示词注入（patch-engine.js）把激活的提示词档案写进 ZCode 的
 *   zcode.cjs，原始文件按版本备份（zcode-<版本号>.cjs），可字节级还原。
 *   本服务只提供管理页与 /api/* 管理接口，不做任何流量代理。
 *
 * 安全设计：
 *   - 只监听 127.0.0.1，不对外暴露
 *   - 可选账号密码认证（登录页 + 12 小时会话 Cookie）
 *   - 修改任何文件前强制备份；注入内容经 node --check 语法校验后才写入
 *
 * 零依赖，Node 18+（本机 Node 24）。
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const os = require("node:os");
const crypto = require("node:crypto");

const patchEngine = require("./patch-engine.js");

/* ============================== 基础常量/路径 ============================== */

const ROOT = process.env.ZPS_ROOT || __dirname;
const PROMPTS_DIR = path.join(ROOT, "prompts");
const BACKUPS_DIR = path.join(ROOT, "backups");
const PUBLIC_DIR = path.join(ROOT, "public");
const LOG_DIR = path.join(ROOT, "log");
const LOG_FILE = path.join(LOG_DIR, "zswap.log");
const TOOL_CONFIG_PATH = process.env.ZPS_TOOL_CONFIG || path.join(ROOT, "tool.config.json");
const ACTIVE_PATH = path.join(PROMPTS_DIR, "active.json");
// ZCode 跨会话记忆库（系统提示词 Memory 节的数据源；索引是 MEMORY.md，每会话开始载入）
const MEMORY_ROOT = process.env.ZPS_MEMORY_ROOT || path.join(os.homedir(), ".zcode", "memory");

const ORIGINAL_PROFILE = "__original__"; // 未选择任何档案
const DEFAULT_PORT = 8083;
const AUTH_COOKIE = "zswap_session";
const MAX_LOG_ENTRIES = 100; // 日志最多保留 100 条，超出顶掉最旧的
const MAX_PROFILE_BYTES = 2 * 1024 * 1024; // 2MB

/* ============================== 认证（vshell 式：登录页 + 会话 Cookie） ============================== */

const sessions = new Map(); // token -> { exp }

/** 是否启用了认证（配置文件里同时填了账号和密码才算启用） */
function authEnabled() {
  const cfg = loadToolConfig();
  return !!(cfg.username && cfg.password);
}

function parseCookies(header) {
  const out = {};
  String(header || "")
    .split(";")
    .forEach((p) => {
      const i = p.indexOf("=");
      if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
  return out;
}

/** 校验请求是否已登录（未启用认证时恒为通过） */
function authCheck(req) {
  if (!authEnabled()) return true;
  const token = parseCookies(req.headers.cookie)[AUTH_COOKIE];
  if (!token) return false;
  const s = sessions.get(token);
  if (!s || s.exp < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/* ============================== 工具函数 ============================== */

function now() {
  return new Date().toISOString();
}

/* 操作事件环形缓冲（供管理页展示），并落盘到 log/zswap.log，最多保留 100 条（超出顶掉最旧） */
const recentEvents = [];
function log(msg) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  recentEvents.push({ t: now(), msg });
  while (recentEvents.length > MAX_LOG_ENTRIES) recentEvents.shift();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ t: now(), msg }) + "\n", "utf8");
    // 文件只保留最新 100 行
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length > MAX_LOG_ENTRIES) {
      fs.writeFileSync(LOG_FILE, lines.slice(-MAX_LOG_ENTRIES).join("\n") + "\n", "utf8");
    }
  } catch {
    /* 写日志失败不影响运行 */
  }
}

/** 启动时回读历史日志（最近 100 条），服务重启不丢记录 */
function loadHistoryLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
    for (const line of lines.slice(-MAX_LOG_ENTRIES)) {
      try {
        const e = JSON.parse(line);
        if (e && typeof e.t === "string" && typeof e.msg === "string") recentEvents.push(e);
      } catch {
        /* 跳过坏行 */
      }
    }
  } catch {
    /* 忽略 */
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, obj) {
  const tmp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/* ============================== 工具自身配置 ============================== */

function loadToolConfig() {
  const cfg = readJsonSafe(TOOL_CONFIG_PATH) || {};
  cfg.port = Number(process.env.ZPS_PORT) || Number(cfg.port) || DEFAULT_PORT;
  cfg.patchTargets = Array.isArray(cfg.patchTargets) ? cfg.patchTargets : [];
  cfg.patchedMd5 = typeof cfg.patchedMd5 === "string" ? cfg.patchedMd5 : null;
  cfg.patchedMd5ByVersion =
    cfg.patchedMd5ByVersion && typeof cfg.patchedMd5ByVersion === "object" ? cfg.patchedMd5ByVersion : {};
  return cfg;
}

function saveToolConfig(cfg) {
  writeJsonAtomic(TOOL_CONFIG_PATH, cfg);
}

function listBackups() {
  try {
    return fs
      .readdirSync(BACKUPS_DIR)
      .filter((f) => f !== ".syntax-check.cjs" && (f.startsWith("zcode.cjs") || f.startsWith("zcode-") || f.startsWith("config.json")))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUPS_DIR, f));
        return { name: f, mtime: st.mtimeMs, size: st.size };
      });
  } catch {
    return [];
  }
}

/* ============================== 提示词档案 ============================== */

/** 档案文件名 → 合法名称校验（防路径穿越） */
function isSafeProfileName(name) {
  return typeof name === "string" && /^[\w\u4e00-\u9fff ._-]{1,64}$/.test(name) && !name.includes("..");
}

function loadActive() {
  const a = readJsonSafe(ACTIVE_PATH) || {};
  const profile = a.profile === ORIGINAL_PROFILE || isSafeProfileName(a.profile) ? a.profile : ORIGINAL_PROFILE;
  return { profile };
}

function listProfiles() {
  const files = fs.readdirSync(PROMPTS_DIR).filter((f) => (f.endsWith(".md") || f.endsWith(".json")) && f !== "active.json"); // active.json 是内部状态文件，不是档案
  return files
    .map((f) => {
      const name = f.slice(0, -Path_extlen(f));
      const st = fs.statSync(path.join(PROMPTS_DIR, f));
      return { name, size: st.size, mtime: st.mtimeMs, format: f.endsWith(".json") ? "json" : "md" };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}
function Path_extlen(f) {
  return f.endsWith(".json") ? 5 : 3;
}

/** 按名找档案文件：优先 .json（分层档案），回退 .md（旧格式）；都不存在时返回 .json 路径（新建默认） */
function findProfileFile(name) {
  const pj = path.join(PROMPTS_DIR, name + ".json");
  if (fs.existsSync(pj)) return pj;
  const pm = path.join(PROMPTS_DIR, name + ".md");
  if (fs.existsSync(pm)) return pm;
  return pj;
}

/* ============================== 记忆库（~/.zcode/memory） ============================== */

/** 记忆文件名合法性（含 .md 后缀的完整文件名；防路径穿越） */
function isSafeMemoryFileName(fname) {
  return (
    typeof fname === "string" &&
    /^[\w\u4e00-\u9fff ._-]{1,64}\.md$/i.test(fname) &&
    !fname.includes("/") &&
    !fname.includes("\\") &&
    !fname.includes("..")
  );
}

/** 列出记忆文件；withContent 时附带全文。MEMORY.md（索引）排最前 */
function listMemoryFiles(withContent) {
  try {
    if (!fs.existsSync(MEMORY_ROOT)) return [];
    return fs
      .readdirSync(MEMORY_ROOT)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .map((f) => {
        const st = fs.statSync(path.join(MEMORY_ROOT, f));
        const item = { name: f, size: st.size, mtime: st.mtimeMs, isIndex: f.toUpperCase() === "MEMORY.MD" };
        if (withContent) item.content = fs.readFileSync(path.join(MEMORY_ROOT, f), "utf8");
        return item;
      })
      .sort((a, b) => (a.isIndex === b.isIndex ? a.name.localeCompare(b.name) : a.isIndex ? -1 : 1));
  } catch {
    return [];
  }
}

/** 新建记忆的默认模板（与 ZCode 的记忆格式一致：frontmatter + 单条事实） */
function memoryTemplate(slug) {
  return [
    "---",
    `name: ${slug}`,
    "description: 一句话摘要（召回时据此判断相关性）",
    "metadata:",
    "  type: project",
    "---",
    "",
    "（记忆内容：一个文件只放一条事实）",
    "",
  ].join("\n");
}

/** 激活档案是否有效（档案存在且非空） */
function activeProfileEffective() {
  const { profile } = loadActive();
  if (profile === ORIGINAL_PROFILE) return false;
  const p = findProfileFile(profile);
  if (!fs.existsSync(p)) return false;
  try {
    return fs.readFileSync(p, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

/* ============================== 管理 API ============================== */

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj, null, 2), "utf8");
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": buf.length });
  res.end(buf);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_PROFILE_BYTES) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(new Error("JSON 解析失败: " + e.message));
      }
    });
    req.on("error", reject);
  });
}

/** 三层原文（新建档案时预填，便于在原文基础上修改） */
function buildOriginalPrompt() {
  try {
    return {
      cli_prefix: JSON.parse(patchEngine.CLI_PREFIX_ANCHOR),
      identity: JSON.parse(patchEngine.IDENTITY_ANCHOR),
      important: JSON.parse(patchEngine.IMPORTANT_ANCHOR),
    };
  } catch {
    return null;
  }
}

function buildStatus() {
  const cfg = loadToolConfig();
  const active = loadActive();
  return {
    ok: true,
    now: now(),
    active: { profile: active.profile, effective: activeProfileEffective() },
    profiles: listProfiles(),
    backups: listBackups(),
    memory: { root: MEMORY_ROOT, files: listMemoryFiles(false) },
    originalPrompt: buildOriginalPrompt(),
    patch: patchEngine.patchState(),
    zcode: {
      running: patchEngine.isZcodeRunning(),
      exePath: patchEngine.resolveZcodeExePath(),
    },
    sys: {
      node: process.version,
      platform: process.platform,
      port: cfg.port,
      version: "2.0.0",
    },
    events: recentEvents.slice(-100).reverse(),
  };
}

async function handleApi(req, res, pathname) {
  const seg = pathname.split("/").filter(Boolean); // e.g. ["api","profiles","渗透测试"]
  const collection = seg[1];

  // GET /api/status
  if (req.method === "GET" && collection === "status") {
    return sendJson(res, 200, buildStatus());
  }

  // GET /api/profiles
  if (req.method === "GET" && collection === "profiles" && seg.length === 2) {
    const profiles = listProfiles().map((p) => ({
      ...p,
      content: fs.readFileSync(findProfileFile(p.name), "utf8"),
    }));
    const active = loadActive();
    return sendJson(res, 200, { profiles, active });
  }

  // POST /api/profiles  {name, content}
  if (req.method === "POST" && collection === "profiles" && seg.length === 2) {
    const body = await readJsonBody(req);
    if (!isSafeProfileName(body.name)) return sendJson(res, 400, { error: "档案名不合法（1-64 个字符，仅限中英文/数字/空格/._-）" });
    if (body.name.toLowerCase() === "active") return sendJson(res, 400, { error: "active 是内部状态文件名，请换一个档案名" });
    if (typeof body.content !== "string") return sendJson(res, 400, { error: "content 必须是字符串" });
    const p = findProfileFile(body.name);
    if (fs.existsSync(p)) return sendJson(res, 409, { error: "档案已存在，请用修改接口" });
    fs.writeFileSync(p, body.content, "utf8");
    log(`新建档案「${body.name}」`);
    return sendJson(res, 200, { ok: true, name: body.name });
  }

  // PUT /api/profiles/:name  {content?}  DELETE /api/profiles/:name
  if (collection === "profiles" && seg.length === 3) {
    const name = decodeURIComponent(seg[2]);
    if (!isSafeProfileName(name)) return sendJson(res, 400, { error: "档案名不合法" });
    const p = findProfileFile(name);
    if (req.method === "PUT") {
      if (!fs.existsSync(p)) return sendJson(res, 404, { error: "档案不存在" });
      const body = await readJsonBody(req);
      if (typeof body.content !== "string") return sendJson(res, 400, { error: "content 必须是字符串" });
      fs.writeFileSync(p, body.content, "utf8");
      // 旧 MD 档案保存为分层 JSON 内容时自动转为 .json（避免同名两份）
      if (p.endsWith(".md") && body.content.trim().startsWith("{")) {
        fs.writeFileSync(path.join(PROMPTS_DIR, name + ".json"), body.content, "utf8");
        fs.unlinkSync(p);
        log(`档案「${name}」已从 MD 转为分层 JSON`);
      }
      log(`修改档案「${name}」`);
      return sendJson(res, 200, { ok: true, name });
    }
    if (req.method === "DELETE") {
      if (!fs.existsSync(p)) return sendJson(res, 404, { error: "档案不存在" });
      fs.unlinkSync(p);
      log(`删除档案「${name}」`);
      // 若删的是当前激活档案，回退到未选择状态
      const active = loadActive();
      if (active.profile === name) writeJsonAtomic(ACTIVE_PATH, { profile: ORIGINAL_PROFILE });
      return sendJson(res, 200, { ok: true, name });
    }
  }

  // POST /api/activate  {profile}
  if (req.method === "POST" && collection === "activate") {
    const body = await readJsonBody(req);
    const profile = body.profile;
    if (profile !== ORIGINAL_PROFILE && !isSafeProfileName(profile)) return sendJson(res, 400, { error: "档案名不合法" });
    if (profile !== ORIGINAL_PROFILE && !fs.existsSync(findProfileFile(profile))) return sendJson(res, 404, { error: "档案不存在" });
    writeJsonAtomic(ACTIVE_PATH, { profile });
    log(`切换档案 → ${profile === ORIGINAL_PROFILE ? "（未选择）" : profile}`);
    return sendJson(res, 200, { ok: true, active: { profile } });
  }

  // GET /api/effective-prompt —— 提取 zcode.cjs 里实际生效的身份段，与激活档案按片比对
  if (req.method === "GET" && collection === "effective-prompt") {
    try {
      const target = patchEngine.detectZcodeBundlePath();
      if (!target) return sendJson(res, 404, { error: "未找到 zcode.cjs" });
      const eff = patchEngine.extractEffectivePrompt(target);
      const active = loadActive();
      let activeContent = null;
      if (active.profile !== ORIGINAL_PROFILE) {
        const p = findProfileFile(active.profile);
        if (fs.existsSync(p)) activeContent = fs.readFileSync(p, "utf8").trim();
      }
      let originalIdentity = null;
      try {
        originalIdentity = JSON.parse(patchEngine.IDENTITY_ANCHOR);
      } catch {}
      const originalPrefix = "You are  ZCode, an interactive coding agent";
      let originalImportant = null;
      try {
        originalImportant = JSON.parse(patchEngine.IMPORTANT_ANCHOR);
      } catch {}

      // 按激活档案的分层逐槽比对（json 分层档案 / md 兼容档案统一形状；null 层须等于原文）
      let matchesActive = false;
      let profileError = null;
      if (activeContent != null) {
        try {
          const parsed = patchEngine.parseProfileLayers(activeContent);
          matchesActive = true;
          matchesActive = matchesActive && (parsed.identity != null ? eff.identity === parsed.identity : eff.identity === originalIdentity);
          matchesActive = matchesActive && (parsed.cliPrefix != null ? eff.cliPrefix === parsed.cliPrefix : eff.cliPrefix === originalPrefix);
          matchesActive = matchesActive && (parsed.important != null ? eff.important === parsed.important : eff.important === originalImportant);
        } catch (e) {
          profileError = e.message;
        }
      }
      const importantState = eff.importantEmpty ? "cleared" : eff.important === originalImportant ? "original" : "custom";
      return sendJson(res, 200, {
        ok: true,
        target,
        version: patchEngine.getZcodeVersion(target),
        identity: eff.identity,
        cliPrefix: eff.cliPrefix,
        importantState,
        importantEmpty: eff.importantEmpty,
        isOriginal:
          (originalIdentity != null && eff.identity === originalIdentity) &&
          eff.cliPrefix === originalPrefix &&
          importantState === "original",
        activeProfile: active.profile,
        profileError,
        matchesActive,
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // POST /api/patch —— 提示词注入：把当前档案写进 zcode.cjs（先按版本备份原始文件）
  if (req.method === "POST" && collection === "patch") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    let profile = body.profile;
    if (!profile) profile = loadActive().profile;
    if (profile === ORIGINAL_PROFILE) {
      return sendJson(res, 400, { error: "还没有激活档案；如需恢复文件请用 /api/unpatch" });
    }
    if (!isSafeProfileName(profile)) return sendJson(res, 400, { error: "档案名不合法" });
    const p = findProfileFile(profile);
    if (!fs.existsSync(p)) return sendJson(res, 404, { error: "档案不存在: " + profile });
    const content = fs.readFileSync(p, "utf8").trim();
    if (!content) return sendJson(res, 400, { error: "档案内容为空，拒绝注入" });
    try {
      const r = patchEngine.patchBundle(content);
      log(`注入提示词 → 档案「${profile}」（${r.size} 字节，md5 ${r.md5.slice(0, 8)}…）`);
      return sendJson(res, 200, { ok: true, profile, ...r });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // POST /api/unpatch —— 从当前版本的原始基线还原 zcode.cjs
  if (req.method === "POST" && collection === "unpatch") {
    try {
      const r = patchEngine.restoreBundle();
      log(`还原原始文件（md5 ${r.md5.slice(0, 8)}…）`);
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // POST /api/killzcode —— 强制结束所有 ZCode 进程（结束前记录 exe 路径以便一键重启）
  if (req.method === "POST" && collection === "killzcode") {
    try {
      const r = patchEngine.killZcode();
      log(`结束所有 ZCode 进程${r.exePath ? "（" + r.exePath + "）" : ""}`);
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) {
      return sendJson(res, 500, { error: e.message + (e.stdout ? " | " + e.stdout : "") });
    }
  }

  // POST /api/startzcode —— 启动 ZCode（注入提示词后一键重启）
  if (req.method === "POST" && collection === "startzcode") {
    try {
      const r = patchEngine.startZcode();
      log(`启动 ZCode: ${r.exePath}（pid ${r.pid}）`);
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // POST /api/backup —— 手动创建备份点（zcode.cjs 时间戳快照，最多保留 20 份）
  if (req.method === "POST" && collection === "backup") {
    try {
      const created = [];
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const target = patchEngine.detectZcodeBundlePath();
      if (target && fs.existsSync(target)) {
        const name = `zcode.cjs.${stamp}.bak`;
        fs.copyFileSync(target, path.join(BACKUPS_DIR, name));
        created.push(name);
      }
      // 清理：时间戳快照只保留最近 20 份；还原锚点永不删除
      const isKept = (f) => f === "zcode.cjs.original" || f === "config.json.latest.bak";
      const snapshots = fs
        .readdirSync(BACKUPS_DIR)
        .filter((f) => !isKept(f) && (f.startsWith("zcode.cjs.") || f.startsWith("config.json.")) && f.endsWith(".bak"))
        .sort();
      while (snapshots.length > 20) {
        fs.unlinkSync(path.join(BACKUPS_DIR, snapshots.shift()));
      }
      log(`手动备份：${created.join("、")}`);
      return sendJson(res, 200, { ok: true, created });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // POST /api/login —— 登录（账号密码匹配后签发会话 Cookie，12 小时有效）
  if (req.method === "POST" && collection === "login") {
    const body = await readJsonBody(req);
    const cfg = loadToolConfig();
    if (!(cfg.username && cfg.password)) {
      return sendJson(res, 200, { ok: true, note: "未启用认证" });
    }
    if (body.username === cfg.username && body.password === cfg.password) {
      const token = crypto.randomBytes(24).toString("hex");
      sessions.set(token, { exp: Date.now() + 12 * 3600 * 1000 });
      res.setHeader("Set-Cookie", `${AUTH_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
      log(`登录成功（${body.username}）`);
      return sendJson(res, 200, { ok: true });
    }
    log(`登录失败（${body.username}）`);
    return sendJson(res, 401, { error: "账号或密码错误" });
  }

  // POST /api/logout —— 退出登录
  if (req.method === "POST" && collection === "logout") {
    const token = parseCookies(req.headers.cookie)[AUTH_COOKIE];
    if (token) sessions.delete(token);
    res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    log("退出登录");
    return sendJson(res, 200, { ok: true });
  }

  // DELETE /api/backups/:name —— 删除单个备份（还原锚点：当前版本的 zcode-<版本号>.cjs、遗留 zcode.cjs.original、config.json.latest.bak 禁止删除）
  if (req.method === "DELETE" && collection === "backups" && seg.length === 3) {
    const name = decodeURIComponent(seg[2]);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return sendJson(res, 400, { error: "文件名不合法" });
    const protectedNames = new Set(["zcode.cjs.original", "config.json.latest.bak"]);
    try {
      const t = patchEngine.detectZcodeBundlePath();
      if (t) protectedNames.add(path.basename(patchEngine.versionedBackupPath(patchEngine.getZcodeVersion(t))));
    } catch {}
    if (protectedNames.has(name)) {
      return sendJson(res, 403, { error: "该备份是还原锚点，禁止删除" });
    }
    const p = path.join(BACKUPS_DIR, name);
    if (!fs.existsSync(p)) return sendJson(res, 404, { error: "备份不存在" });
    fs.unlinkSync(p);
    log(`删除备份：${name}`);
    return sendJson(res, 200, { ok: true, name });
  }

  // ===== 记忆库（~/.zcode/memory）=====

  // GET /api/memory —— 列出记忆文件（含全文）
  if (req.method === "GET" && collection === "memory" && seg.length === 2) {
    return sendJson(res, 200, { ok: true, root: MEMORY_ROOT, files: listMemoryFiles(true) });
  }

  // POST /api/memory  {name, content?} —— 新建记忆（content 缺省时用模板）
  if (req.method === "POST" && collection === "memory" && seg.length === 2) {
    const body = await readJsonBody(req);
    const slug = String(body.name || "").trim().replace(/\.md$/i, "");
    if (!isSafeProfileName(slug)) return sendJson(res, 400, { error: "记忆名不合法（1-64 个字符，仅限中英文/数字/空格/._-）" });
    if (/^memory$/i.test(slug)) return sendJson(res, 400, { error: "memory 是索引文件 MEMORY.md 的名字，不能新建同名记忆" });
    const p = path.join(MEMORY_ROOT, slug + ".md");
    if (fs.existsSync(p)) return sendJson(res, 409, { error: "记忆已存在" });
    const content = typeof body.content === "string" && body.content.trim() ? body.content : memoryTemplate(slug);
    fs.mkdirSync(MEMORY_ROOT, { recursive: true });
    fs.writeFileSync(p, content, "utf8");
    log(`新建记忆「${slug}.md」`);
    return sendJson(res, 200, { ok: true, name: slug + ".md" });
  }

  // PUT /api/memory/:name  {content}  DELETE /api/memory/:name（MEMORY.md 索引可编辑、禁止删除）
  if (collection === "memory" && seg.length === 3) {
    const fname = decodeURIComponent(seg[2]);
    if (!isSafeMemoryFileName(fname)) return sendJson(res, 400, { error: "记忆文件名不合法" });
    const p = path.join(MEMORY_ROOT, fname);
    if (req.method === "PUT") {
      if (!fs.existsSync(p)) return sendJson(res, 404, { error: "记忆不存在" });
      const body = await readJsonBody(req);
      if (typeof body.content !== "string" || !body.content.trim()) return sendJson(res, 400, { error: "content 必须是非空字符串" });
      fs.writeFileSync(p, body.content, "utf8");
      log(`修改记忆「${fname}」`);
      return sendJson(res, 200, { ok: true, name: fname });
    }
    if (req.method === "DELETE") {
      if (fname.toUpperCase() === "MEMORY.MD") return sendJson(res, 403, { error: "MEMORY.md 是索引锚点，禁止删除（可编辑）" });
      if (!fs.existsSync(p)) return sendJson(res, 404, { error: "记忆不存在" });
      fs.unlinkSync(p);
      log(`删除记忆「${fname}」`);
      return sendJson(res, 200, { ok: true, name: fname });
    }
  }

  return sendJson(res, 404, { error: "未知接口" });
}

/* ============================== 静态页面 ============================== */

function serveIndex(res) {
  const file = path.join(PUBLIC_DIR, "index.html");
  const html = fs.readFileSync(file, "utf8");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

function serveLogin(res) {
  if (!authEnabled()) {
    res.writeHead(302, { location: "/" });
    return res.end();
  }
  const file = path.join(PUBLIC_DIR, "login.html");
  const html = fs.readFileSync(file, "utf8");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

/* ============================== 入口 ============================== */

function portFree(p) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(p, "127.0.0.1");
  });
}

/** 端口被占用时自动向后顺延（最多试 20 个），选中的端口回写 tool.config.json */
async function pickPort(cfg) {
  for (let p = cfg.port; p <= cfg.port + 20; p++) {
    if (await portFree(p)) {
      if (p !== cfg.port) {
        cfg.port = p;
        saveToolConfig(cfg);
        log(`默认端口被占用，已改用 ${p}（已写入 tool.config.json）`);
      }
      return p;
    }
  }
  throw new Error(`端口 ${cfg.port}~${cfg.port + 20} 全部被占用，请修改 tool.config.json 的 port 或设置 ZPS_PORT 环境变量`);
}

/** 启动后自动打开默认浏览器访问管理页（设置 ZPS_NO_BROWSER=1 可关闭） */
function openBrowser(url) {
  if (process.env.ZPS_NO_BROWSER) return;
  try {
    const { spawn } = require("node:child_process");
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* 打开失败不影响服务 */
  }
}

/* ===== 像素噪点 Banner：█=毛玻璃感彩色噪点(ANSI 真彩色)，▒=挤出阴影(黑底可见) ===== */

/** 干净的程序化 ZSWAP：█=字面，▒=字面像素右下 (c+1, r+1) 处的挤出阴影 */
function buildBannerText() {
  const LETTERS = {
    Z: ["1111", "0001", "0010", "0100", "1111"],
    S: ["1111", "1000", "1111", "0001", "1111"],
    W: ["10001", "10001", "10101", "10101", "11011"],
    A: ["0110", "1001", "1111", "1001", "1001"],
    P: ["1111", "1001", "1111", "1000", "1000"],
  };
  const gap = 2;
  let x = 0;
  const placed = [];
  for (const ch of "ZSWAP") {
    placed.push({ x, bmp: LETTERS[ch] });
    x += LETTERS[ch][0].length + gap;
  }
  const width = x - gap;
  const height = 6;
  const grid = Array.from({ length: height }, () => Array(width).fill(" "));
  const isLetter = Array.from({ length: height }, () => Array(width).fill(false));
  for (const { x: ox, bmp } of placed) {
    for (let r = 0; r < bmp.length; r++) {
      for (let c = 0; c < bmp[r].length; c++) {
        if (bmp[r][c] === "1") {
          grid[r][ox + c] = "█";
          isLetter[r][ox + c] = true;
        }
      }
    }
  }
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < width; c++) {
      if (isLetter[r][c] && r + 1 < height && c + 1 < width && !isLetter[r + 1][c + 1]) {
        grid[r + 1][c + 1] = "▒";
      }
    }
  }
  return grid.map((row) => row.join("")).join("\n");
}

const BANNER_ART = buildBannerText();

/** HSL → RGB（0-255） */
function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

/** 生成毛玻璃感噪点 banner：每个 █ 低饱和高亮度随机色（约 3 成灰白），▒ 用提亮的蓝灰 (100,108,140) */
function buildColorBanner() {
  const SHADOW = "\x1b[38;2;100;108;140m";
  const RESET = "\x1b[0m";
  let out = "";
  for (const ch of BANNER_ART) {
    if (ch === "█") {
      let r, g, b;
      if (Math.random() < 0.3) {
        const v = 165 + Math.floor(Math.random() * 80);
        r = g = b = v;
      } else {
        [r, g, b] = hslToRgb(Math.floor(Math.random() * 360), 18 + Math.floor(Math.random() * 22), 62 + Math.floor(Math.random() * 18));
      }
      out += `\x1b[38;2;${r};${g};${b}m█`;
    } else if (ch === "▒") {
      out += SHADOW + "▒";
    } else {
      out += ch; // 空格与换行原样
    }
  }
  return out + RESET;
}

async function main() {
  loadHistoryLog();
  const cfg = loadToolConfig();
  for (const d of [PROMPTS_DIR, BACKUPS_DIR, PUBLIC_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const port = await pickPort(cfg);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    // 健康检查（免认证）
    if (pathname === "/healthz") {
      return sendJson(res, 200, { ok: true, now: now() });
    }

    // 登录页与登录/登出接口（免认证）
    if (pathname === "/login" || pathname === "/login.html") {
      return serveLogin(res);
    }
    if (pathname === "/api/login" || pathname === "/api/logout") {
      try {
        return await handleApi(req, res, pathname);
      } catch (e) {
        log(`API 异常: ${e.stack || e.message}`);
        if (!res.headersSent) return sendJson(res, 500, { error: e.message });
      }
    }

    // 其余页面与接口：启用认证时校验会话
    if (!authCheck(req)) {
      if (pathname.startsWith("/api/")) {
        return sendJson(res, 401, { error: "未登录或会话已过期" });
      }
      res.writeHead(302, { location: "/login" });
      return res.end();
    }

    // 管理 API
    if (pathname.startsWith("/api/")) {
      try {
        await handleApi(req, res, pathname);
      } catch (e) {
        log(`API 异常: ${e.stack || e.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: e.message });
      }
      return;
    }

    // 管理页
    if (pathname === "/" || pathname === "/index.html") {
      return serveIndex(res);
    }
    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }

    sendJson(res, 404, { error: "未知路径（管理页在 /）" });
  });

  server.on("clientError", (err, socket) => {
    log(`客户端连接错误: ${err.message}`);
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  server.listen(port, "127.0.0.1", () => {
    console.log("");
    console.log(buildColorBanner());
    console.log("ZSWAP 系统提示词替换工具 已启动");
    console.log(`  管理页: http://127.0.0.1:${port}/`);
    console.log(`  注入目标: ${patchEngine.detectZcodeBundlePath() || "(未找到)"}`);
    console.log(`  当前激活档案: ${JSON.stringify(loadActive().profile)}`);
    console.log("");
    openBrowser(`http://127.0.0.1:${port}/`);
    // 预热探测缓存（进程状态/exe 路径/MD5），避免用户第一次打开管理页时卡 2~3 秒
    setTimeout(() => {
      try {
        const c = loadToolConfig();
        let changed = false;
        // 自动填写 zcode 位置：配置里没有就探测并回填；已有则跳过
        if (!c.zcodePath) {
          const t = patchEngine.detectZcodeBundlePath();
          if (t) {
            c.zcodePath = t;
            changed = true;
            console.log(`已自动填写 zcodePath: ${t}`);
          }
        }
        // 自动填写 ZCode.exe 路径（启动/结束进程要用）
        if (!c.zcodeExePath) {
          const exe = patchEngine.resolveZcodeExePath();
          if (exe) {
            c.zcodeExePath = exe;
            changed = true;
            console.log(`已自动填写 zcodeExePath: ${exe}`);
          }
        }
        if (changed) saveToolConfig(c);
        patchEngine.isZcodeRunning();
      } catch {
        /* 预热失败不影响使用 */
      }
    }, 300);
  });
}

main().catch((e) => {
  log(`启动失败: ${e.message}`);
  process.exit(1);
});
