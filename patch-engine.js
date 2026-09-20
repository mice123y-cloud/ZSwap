/**
 * ZCode 提示词注入引擎（直接修改 zcode.cjs 里的系统提示词）
 *
 * 原理：zcode.cjs 是压缩打包的 JS，提示词以字符串字面量形式存在。注入做两件事：
 *   1. 身份句（"You are an interactive ZCode agent ..."）→ 替换为档案内容（合法 JS 字符串字面量）
 *   2. IMPORTANT 安全段 → 置空
 * 其余段（# Harness、环境信息等）原样保留在后。
 *
 * 安全设计：
 *   - 注入前自动备份原始文件（backups/zcode-<版本号>.cjs，每版本一份，永不覆盖）
 *   - 版本感知：ZCode 每次更新都会重置 zcode.cjs。status/check/apply 时检测当前版本，
 *     若该版本还没有原始备份且文件是原始状态，自动备份一份（等于自动跟进新版本）
 *   - 锚点必须恰好出现 1 次才动手（防版本变化/防重复打）
 *   - 改完用 node --check 语法校验，不合法就不写入
 *   - 还原 = 把「当前版本」的原始备份拷回，字节级恢复（绝不跨版本回滚）
 *   - md5 按版本跟踪：能区分「原始 / 已注入 / 被外部改动（如自动更新覆盖）」
 *
 * 目标文件定位（按顺序）：环境变量 ZPS_ZCODE_CJS > 运行中的 ZCode.exe 进程路径推导
 *   > tool.config.json 的 patchTargets 候选列表
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = process.env.ZPS_ROOT || path.dirname(__filename);
const BACKUPS_DIR = path.join(ROOT, "backups");
const TOOL_CONFIG_PATH = process.env.ZPS_TOOL_CONFIG || path.join(ROOT, "tool.config.json");
const PROMPTS_DIR = path.join(ROOT, "prompts");
const ACTIVE_PATH = path.join(PROMPTS_DIR, "active.json");

const ORIGINAL_PROFILE = "__original__";
const LEGACY_ORIGINAL_BACKUP = path.join(BACKUPS_DIR, "zcode.cjs.original"); // 旧版单份备份，仅作历史遗留，引擎不再使用

// 三个注入槽位的锚点（含引号的完整字符串字面量，保证唯一匹配）
const IDENTITY_ANCHOR = `"You are an interactive ZCode agent that helps users with software engineering tasks."`;
const CLI_PREFIX_ANCHOR = `"You are ZCode, an interactive coding agent"`; // ZCode 3.14 起为单空格（3.12 及更早为两空格）
const IMPORTANT_ANCHOR = `"IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases."`;

/* ---------------- 档案分片解析 ---------------- */

// 档案可用 <!-- fragment: identity|cli_prefix|important --> 标记分成多片，各片独立注入到对应槽位。
// 没有任何标记的档案视为整份进 identity 片（向后兼容旧档案，且 IMPORTANT 段清空）。
const FRAGMENT_SLOTS = ["identity", "cli_prefix", "important"];
const FRAGMENT_SPLIT_RE = /(?:^|\n)<!--\s*fragment:\s*(identity|cli_prefix|important)\s*-->[ \t]*\n?/;

/** MD 兼容解析：fragment 标记分片；无标记 = 整份 identity 片 */
function parseFragments(content) {
  const src = String(content || "").replace(/\r\n/g, "\n").trim();
  if (!src.includes("<!--") || !/fragment:\s*(identity|cli_prefix|important)/.test(src)) {
    return { legacy: true, identity: src };
  }
  const parts = src.split(FRAGMENT_SPLIT_RE);
  const frags = { legacy: false };
  const pre = parts[0].trim();
  if (pre) frags.identity = pre; // 第一个标记之前的内容默认归 identity 片
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const slot = parts[i];
    const body = parts[i + 1].trim();
    if (slot === "identity") {
      if (body) frags.identity = body;
    } else if (slot === "cli_prefix") {
      if (body) frags.cliPrefix = body;
    } else if (slot === "important") {
      frags.important = body; // 允许为空：空体 = 清空安全段
    }
  }
  return frags;
}

/**
 * 解析档案内容为分层（统一出口）。返回 { legacy, cliPrefix, identity, important }：
 *   - JSON 档案（推荐，必须分层）：顶层只允许 cli_prefix / identity / important 三个字段；
 *     字段缺省或 null = 不动该层；字符串 = 替换该层（important 的 "" = 清空）
 *   - MD 档案（兼容旧格式）：支持 fragment 标记分片；无标记则整份进 identity 层并清空安全段
 */
function parseProfileLayers(content) {
  const src = String(content || "").replace(/\r\n/g, "\n").trim();
  if (src.startsWith("{")) {
    let obj;
    try {
      obj = JSON.parse(src);
    } catch (e) {
      throw new Error("JSON 档案解析失败: " + e.message);
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("JSON 档案必须是对象");
    const out = { legacy: false, cliPrefix: null, identity: null, important: null };
    for (const k of Object.keys(obj)) {
      if (!FRAGMENT_SLOTS.includes(k)) {
        throw new Error(`JSON 档案含未知字段: ${k}（只允许 cli_prefix / identity / important）`);
      }
      const v = obj[k];
      if (v !== null && typeof v !== "string") throw new Error(`字段 ${k} 必须是字符串或 null`);
      if (k === "cli_prefix") out.cliPrefix = v && v.trim() ? v : null; // 空串视为不动该层
      else if (k === "identity") out.identity = v && v.trim() ? v : null;
      else out.important = typeof v === "string" ? v : null; // important 的 "" = 清空
    }
    if (out.cliPrefix == null && out.identity == null && out.important == null) {
      throw new Error("JSON 档案没有任何有效层（cli_prefix / identity / important 均为空）");
    }
    return out;
  }
  const frags = parseFragments(src); // MD 兼容路径
  if (frags.legacy) return { legacy: true, cliPrefix: null, identity: frags.identity, important: "" };
  return {
    legacy: false,
    cliPrefix: frags.cliPrefix || null,
    identity: frags.identity || null,
    important: frags.important != null ? frags.important : null,
  };
}

/* ---------------- 工具配置（与 server.js 共用同一文件，字段互不冲突） ---------------- */

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function loadToolConfig() {
  const cfg = readJsonSafe(TOOL_CONFIG_PATH) || {};
  cfg.patchTargets = Array.isArray(cfg.patchTargets) ? cfg.patchTargets : [];
  cfg.patchedMd5 = typeof cfg.patchedMd5 === "string" ? cfg.patchedMd5 : null;
  cfg.patchedMd5ByVersion =
    cfg.patchedMd5ByVersion && typeof cfg.patchedMd5ByVersion === "object" ? cfg.patchedMd5ByVersion : {};
  cfg.zcodeExePath = typeof cfg.zcodeExePath === "string" ? cfg.zcodeExePath : null;
  cfg.zcodePath = typeof cfg.zcodePath === "string" ? cfg.zcodePath : "";
  cfg.username = typeof cfg.username === "string" ? cfg.username : "";
  cfg.password = typeof cfg.password === "string" ? cfg.password : "";
  return cfg;
}

function saveToolConfig(cfg) {
  fs.mkdirSync(path.dirname(TOOL_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(TOOL_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

/* ---------------- 工具函数 ---------------- */

function md5buf(buf) {
  return crypto.createHash("md5").update(buf).digest("hex");
}

// MD5 按 mtime+size 缓存：文件没变就不重算（13MB 的文件每 5 秒重算一次太浪费）
const md5Cache = new Map();
function md5file(p) {
  const st = fs.statSync(p);
  const c = md5Cache.get(p);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.md5;
  const md5 = md5buf(fs.readFileSync(p));
  md5Cache.set(p, { mtimeMs: st.mtimeMs, size: st.size, md5 });
  return md5;
}

// 进程路径探测结果缓存 10 秒，避免每次请求都拉起 powershell
let detectCache = { at: 0, result: null };

/* ---------------- 版本检测与按版本基线备份 ---------------- */

// 版本探测缓存：目标文件内容没变（mtime+size）就不重查 exe 版本
const versionCache = new Map(); // target -> {mtimeMs, size, version}

function sanitizeVersionTag(v) {
  return String(v).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "unknown";
}

function readExeProductVersion(exePath) {
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${exePath.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
      { encoding: "utf8", timeout: 10000, windowsHide: true }
    );
    const v = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return v || null;
  } catch {
    return null;
  }
}

/** 文件头指纹：注入只改动文件中部，头部字节不受影响，同一版本内标签稳定 */
function md5head(p, bytes = 4096) {
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return crypto.createHash("md5").update(buf.subarray(0, n)).digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

/** 取目标 cjs 对应的 ZCode 版本号：环境变量覆盖 > 旁路 ZCode.exe 的 ProductVersion > 运行进程 exe > 文件头指纹兜底 */
function getZcodeVersion(target) {
  const forced = process.env.ZPS_ZCODE_VERSION;
  if (forced && /^[A-Za-z0-9._-]{1,40}$/.test(forced)) return forced;
  const st = fs.statSync(target);
  const c = versionCache.get(target);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.version;
  let version = null;
  // 标准 安装根\resources\glm\zcode.cjs 布局：cjs 旁上两级就是 ZCode.exe
  const exeBeside = path.resolve(path.join(path.dirname(target), "..", "..", "ZCode.exe"));
  if (fs.existsSync(exeBeside)) version = readExeProductVersion(exeBeside);
  if (!version) {
    try {
      const exe = resolveZcodeExePath();
      if (exe && fs.existsSync(exe)) version = readExeProductVersion(exe);
    } catch {
      /* 继续 */
    }
  }
  if (!version) version = "md5-" + md5head(target);
  versionCache.set(target, { mtimeMs: st.mtimeMs, size: st.size, version });
  return version;
}

/** 某版本的原始备份路径：backups/zcode-<版本号>.cjs */
function versionedBackupPath(version) {
  return path.join(BACKUPS_DIR, `zcode-${sanitizeVersionTag(version)}.cjs`);
}

/** 锚点齐全 = 文件处于原始状态，可作为基线 */
function isPristineBundle(text) {
  return text.includes(IDENTITY_ANCHOR) && text.includes(CLI_PREFIX_ANCHOR) && text.includes(IMPORTANT_ANCHOR);
}

/* ---------------- 实际生效提示词提取 ---------------- */

// 身份段结构锚点（与真实 zcode.cjs 的压缩形态一致，按版本有两种形态）：
//   3.14+ ：[["",e?"<Output Style 模式句>":"<身份句>","",<IMPORTANT变量>].join(`换行`),"",<Harness函数>()].join(`换行`)
//   ≤3.12：[["",e?"<Output Style 模式句>":"<身份句>","","<IMPORTANT字面量>"].join(`换行`),"","# Harness"
// 提取的是三元 false 分支 = 默认（未启用 Output Style）时实际生效的身份句
const EFFECTIVE_RE = /\[\["",(?:[A-Za-z_$][\w$]*\?"(?:[^"\\]|\\.)*":)?("(?:[^"\\]|\\.)*"),"",("(?:[^"\\]|\\.)*")\]\.join\(`\n`\),"","# Harness"/;
const EFFECTIVE_RE_V2 = /\[\["",[A-Za-z_$][\w$]*\?("(?:[^"\\]|\\.)*"):("(?:[^"\\]|\\.)*"),"",([A-Za-z_$][\w$]*)\]\.join\(`\n`\),"",[A-Za-z_$][\w$]*\(\)\]/;

/** 取模块级字符串变量的值（3.14 起 IMPORTANT 段被抽成变量）：`varName="..."` → 解码后的字符串 */
function resolveAssignedString(text, varName) {
  const re = new RegExp("(?<![\\w$])" + varName.replace(/[$]/g, "\\$") + '="((?:[^"\\\\]|\\\\.)*)"');
  const m = text.match(re);
  if (!m) return null;
  try {
    return JSON.parse('"' + m[1] + '"');
  } catch {
    return null;
  }
}

/** 从 zcode.cjs 里提取当前实际生效的身份段。返回 { identity, importantEmpty }；结构不认识时抛错（版本变化安全降级） */
function extractEffectivePrompt(target) {
  if (!fs.existsSync(target)) throw new Error("目标文件不存在: " + target);
  const text = fs.readFileSync(target, "utf8");
  // 3.14+ 结构：IMPORTANT 段是变量引用，Harness 段是函数调用
  const m2 = text.match(EFFECTIVE_RE_V2);
  if (m2) {
    let identity;
    try {
      identity = JSON.parse(m2[2]);
    } catch {
      throw new Error("身份段字符串解码失败");
    }
    const important = resolveAssignedString(text, m2[3]);
    if (important == null) throw new Error("无法解析 IMPORTANT 段变量（ZCode 版本结构可能已变化）");
    return { identity, important, importantEmpty: important.length === 0, cliPrefix: extractCliPrefix(text) };
  }
  // ≤3.12 结构：IMPORTANT 段为内联字面量，尾部紧跟 "","# Harness"
  const tail = text.indexOf(',"","# Harness"');
  if (tail < 0) throw new Error("无法在 zcode.cjs 中定位身份段（ZCode 版本结构可能已变化）");
  const head = text.lastIndexOf('[["",', tail);
  if (head < 0 || tail - head > 4 * 1024 * 1024) throw new Error("身份段结构异常，拒绝解析");
  const m = text.slice(head, tail + 20).match(EFFECTIVE_RE);
  if (!m) throw new Error("身份段结构解析失败（ZCode 版本结构可能已变化）");
  let identity, important;
  try {
    identity = JSON.parse(m[1]);
    important = JSON.parse(m[2]);
  } catch {
    throw new Error("身份段字符串解码失败");
  }
  return { identity, important, importantEmpty: important.length === 0, cliPrefix: extractCliPrefix(text) };
}

/** 提取开头第一句（CLI Prefix 槽位）：原始形态按原文匹配；注入后按 CLI Prefix 节元数据回溯变量赋值 */
function extractCliPrefix(text) {
  const ORIGINAL = "You are ZCode, an interactive coding agent";
  if (text.includes(CLI_PREFIX_ANCHOR)) return ORIGINAL;
  const idx = text.indexOf(';return{name:"CLI Prefix"');
  if (idx < 0) return null;
  const head = text.slice(Math.max(0, idx - 200), idx);
  const vm = head.match(/([A-Za-z_$][\w$]*)$/); // ...function Sle(){let e=NOi ← 取变量名
  if (!vm) return null;
  return resolveAssignedString(text, vm[1]);
}

/**
 * 版本基线保障：当前 cjs 版本还没有原始备份时，若文件是原始状态则自动备份为
 * backups/zcode-<版本号>.cjs。ZCode 更新会重置 zcode.cjs，本函数保证每个
 * 新版本都能自动留下可还原的原始副本（status/check/apply 都会触发）。
 * 版本基线最多保留最近 VERSION_BASELINE_KEEP 份（按修改时间），当前版本那份永不淘汰。
 */
const VERSION_BASELINE_KEEP = 20;

function ensureVersionBackup(target) {
  const version = getZcodeVersion(target);
  const backup = versionedBackupPath(version);
  const info = { version, backup, created: false, reason: "exists" };
  if (fs.existsSync(backup)) return info;
  if (!isPristineBundle(fs.readFileSync(target, "utf8"))) {
    info.reason = "not_pristine"; // 注入过/被改过，不能当原始基线
    return info;
  }
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  fs.copyFileSync(target, backup);
  info.created = true;
  info.reason = "created";
  pruneVersionBaselines(backup);
  return info;
}

/** 版本基线保留策略：按 mtime 只留最近 VERSION_BASELINE_KEEP 份（keepBackup 那份永不删），多余的删最旧的 */
function pruneVersionBaselines(keepBackup) {
  try {
    const keep = path.basename(keepBackup);
    const files = fs
      .readdirSync(BACKUPS_DIR)
      .filter((f) => /^zcode-[A-Za-z0-9._-]+\.cjs$/.test(f) && f !== keep)
      .map((f) => ({ f, mtime: fs.statSync(path.join(BACKUPS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime); // 新 → 旧
    for (const { f } of files.slice(VERSION_BASELINE_KEEP - 1)) {
      fs.unlinkSync(path.join(BACKUPS_DIR, f));
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/**
 * 规范化用户填写的 zcode 位置：
 *   指向 zcode.cjs 文件 → 原样
 *   指向 ZCode.exe      → 推导同目录 resources\glm\zcode.cjs
 *   指向安装目录        → 推导 目录\resources\glm\zcode.cjs
 *   填错/不存在         → null（回退自动探测）
 */
function normalizeZcodePath(p) {
  if (!p || typeof p !== "string") return null;
  if (!fs.existsSync(p)) return null;
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    const cand = path.join(p, "resources", "glm", "zcode.cjs");
    return fs.existsSync(cand) ? cand : null;
  }
  const base = path.basename(p).toLowerCase();
  if (base === "zcode.cjs") return p;
  if (base === "zcode.exe") {
    const cand = path.join(path.dirname(p), "resources", "glm", "zcode.cjs");
    return fs.existsSync(cand) ? cand : null;
  }
  return null;
}

/** 定位要注入的 zcode.cjs：ZPS_ZCODE_CJS > 配置 zcodePath > 运行进程推导 > patchTargets 候选 */
function detectZcodeBundlePath() {
  if (detectCache.at && Date.now() - detectCache.at < 10000) return detectCache.result;
  let result = null;
  if (process.env.ZPS_ZCODE_CJS && fs.existsSync(process.env.ZPS_ZCODE_CJS)) {
    result = process.env.ZPS_ZCODE_CJS;
  }
  if (!result) {
    result = normalizeZcodePath(loadToolConfig().zcodePath);
  }
  if (!result) {
    try {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", "(Get-Process ZCode -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)"],
        { encoding: "utf8", timeout: 10000, windowsHide: true }
      );
      const exe = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (exe && fs.existsSync(exe)) {
        const cand = path.join(path.dirname(exe), "resources", "glm", "zcode.cjs");
        if (fs.existsSync(cand)) result = cand;
      }
    } catch {
      /* 无 powershell / 进程不存在，继续下一步 */
    }
  }
  if (!result) {
    const cfg = loadToolConfig();
    for (const p of cfg.patchTargets) {
      if (typeof p === "string" && fs.existsSync(p)) {
        result = p;
        break;
      }
    }
  }
  detectCache = { at: Date.now(), result };
  return result;
}

function clearDetectCache() {
  detectCache = { at: 0, result: null };
}

/** node --check 语法校验（写临时文件，不碰目标） */
function verifyJsSyntax(text) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const tmp = path.join(BACKUPS_DIR, ".syntax-check.cjs");
  fs.writeFileSync(tmp, text, "utf8");
  try {
    const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8", timeout: 30000 });
    if (r.status !== 0) {
      throw new Error("语法校验失败: " + (r.stderr || r.stdout || "未知错误").slice(0, 500));
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

/** 对目标文件执行注入：按分层替换各槽位（identity / cli_prefix / important），null = 不动该层 */
function applyBundlePatch(target, layers) {
  if (!fs.existsSync(target)) throw new Error("目标文件不存在: " + target);
  const text = fs.readFileSync(target, "utf8");
  const countOf = (anchor) => text.split(anchor).length - 1;

  const ops = []; // [锚点, 替换字面量]
  if (layers.identity != null) ops.push([IDENTITY_ANCHOR, JSON.stringify(layers.identity)]);
  if (layers.cliPrefix != null) ops.push([CLI_PREFIX_ANCHOR, JSON.stringify(layers.cliPrefix)]);
  if (layers.important != null) ops.push([IMPORTANT_ANCHOR, JSON.stringify(layers.important)]);
  if (ops.length === 0) throw new Error("档案没有任何可注入的层（cli_prefix / identity / important 均为空）");
  for (const [anchor] of ops) {
    const n = countOf(anchor);
    if (n !== 1) throw new Error(`槽位锚点出现 ${n} 次（应为 1）。版本可能已变化或已注入过，拒绝操作。`);
  }

  let patched = text;
  for (const [anchor, literal] of ops) patched = patched.replace(anchor, literal);

  verifyJsSyntax(patched);
  fs.writeFileSync(target, patched, "utf8");
  md5Cache.delete(target);
  versionCache.delete(target);
  clearDetectCache();
  return { target, size: Buffer.byteLength(patched), md5: md5file(target), slots: ops.map(([a]) => slotNameOf(a)) };
}

/** 锚点 → 槽位名（用于结果展示） */
function slotNameOf(anchor) {
  if (anchor === IDENTITY_ANCHOR) return "identity";
  if (anchor === CLI_PREFIX_ANCHOR) return "cli_prefix";
  return "important";
}

/** 注入状态：no_target / no_backup / original / patched / modified（按当前版本判定，顺带自动基线新版本） */
function patchState() {
  const target = detectZcodeBundlePath();
  if (!target) return { state: "no_target", target: null };
  const ensure = ensureVersionBackup(target);
  const { version, backup } = ensure;
  if (!fs.existsSync(backup)) return { state: "no_backup", target, version, backup };
  const cur = md5file(target);
  const orig = md5file(backup);
  const cfg = loadToolConfig();
  if (cur === orig) return { state: "original", target, version, backup, md5: cur };
  const knownPatched = (cfg.patchedMd5ByVersion || {})[version];
  if (knownPatched && cur === knownPatched) return { state: "patched", target, version, backup, md5: cur };
  return { state: "modified", target, version, backup, md5: cur };
}

/** 注入入口：先确保当前版本有原始基线（新版本自动备份）；若是本版本上次注入的内容，先还原再注入新档案 */
function patchBundle(content) {
  const target = detectZcodeBundlePath();
  if (!target) {
    throw new Error(
      "无法定位 ZCode 的 zcode.cjs（未发现运行中的 ZCode 进程，tool.config.json 也没有 patchTargets）。可设置环境变量 ZPS_ZCODE_CJS 指定路径。"
    );
  }
  const cfg = loadToolConfig();
  const ensure = ensureVersionBackup(target);
  const { version, backup } = ensure;
  if (!fs.existsSync(backup)) {
    throw new Error(
      `当前文件不是原始状态（锚点缺失）且没有版本 ${version} 的原始备份，拒绝注入以免丢失还原能力。` +
        `请先恢复原始文件，或设置 ZPS_ZCODE_VERSION 指定正确版本。`
    );
  }

  // 非原始状态分两种情况：
  // - 是本版本上次自己注入的内容（md5 匹配）→ 先从基线还原，再注入新档案
  // - 与本版本上次注入不一致（可能被外部改动）→ 拒绝，避免误操作
  const text = fs.readFileSync(target, "utf8");
  if (!isPristineBundle(text)) {
    const cur = md5file(target);
    const known = (cfg.patchedMd5ByVersion || {})[version];
    if (known && cur === known) {
      fs.copyFileSync(backup, target);
      md5Cache.delete(target);
      versionCache.delete(target);
      console.log(`[patch-engine] 检测到本版本(${version})上次注入，已先还原原始文件，再注入新档案`);
    } else {
      throw new Error(
        "锚点缺失且文件与上次注入不一致（可能被外部修改）。请先执行 restore 还原原始版本，或人工确认后重试。"
      );
    }
  }

  const r = applyBundlePatch(target, parseProfileLayers(content));
  cfg.patchedMd5ByVersion = Object.assign({}, cfg.patchedMd5ByVersion, { [version]: r.md5 });
  delete cfg.patchedMd5; // 旧版单值字段废弃，改为按版本记录
  saveToolConfig(cfg);
  return { ...r, version, backup, note: `原始文件已按版本 ${version} 备份为 ${path.basename(backup)}` };
}

/** 还原：把「当前版本」的原始基线拷回目标（绝不拿旧版本备份回滚新版程序） */
function restoreBundle() {
  const target = detectZcodeBundlePath();
  if (!target) throw new Error("无法定位 zcode.cjs");
  const version = getZcodeVersion(target);
  const backup = versionedBackupPath(version);
  if (!fs.existsSync(backup)) {
    throw new Error(
      `没有版本 ${version} 的原始备份（${path.basename(backup)}），无法还原。` +
        `若 ZCode 刚更新且文件已被改动，请先重装/修复 ZCode 恢复原始 cjs，再运行一次注入生成该版本基线。`
    );
  }
  const orig = fs.readFileSync(backup);
  fs.writeFileSync(target, orig);
  md5Cache.delete(target);
  versionCache.delete(target);
  clearDetectCache();
  return { target, version, backup, md5: md5buf(orig) };
}

/** 读取档案内容（原始模式返回 null）；优先 .json（分层档案），回退 .md（兼容旧格式） */
function resolveProfileContent(profile) {
  if (profile === ORIGINAL_PROFILE) return null;
  if (!/^[\w\u4e00-\u9fff ._-]{1,64}$/.test(profile) || profile.includes("..")) throw new Error("档案名不合法: " + profile);
  let p = path.join(PROMPTS_DIR, profile + ".json");
  if (!fs.existsSync(p)) p = path.join(PROMPTS_DIR, profile + ".md");
  if (!fs.existsSync(p)) throw new Error("档案不存在: " + profile);
  const content = fs.readFileSync(p, "utf8").trim();
  if (!content) throw new Error("档案内容为空: " + profile);
  return content;
}

function loadActiveProfile() {
  const a = readJsonSafe(ACTIVE_PATH) || {};
  return a.profile === ORIGINAL_PROFILE || /^[\w\u4e00-\u9fff ._-]{1,64}$/.test(a.profile) ? a.profile : ORIGINAL_PROFILE;
}

/* ---------------- ZCode 进程管理（启动/结束/状态） ---------------- */

let runCache = { at: 0, result: null };

/** ZCode.exe 是否在运行（结果缓存 10 秒，避免每次请求都拉起 PowerShell） */
function isZcodeRunning() {
  if (runCache.at && Date.now() - runCache.at < 10000) return runCache.result;
  let result = false;
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", "(Get-Process ZCode -ErrorAction SilentlyContinue | Measure-Object).Count"],
      { encoding: "utf8", timeout: 10000, windowsHide: true }
    );
    result = parseInt(out.trim(), 10) > 0;
  } catch {
    /* 查询失败按未运行处理 */
  }
  runCache = { at: Date.now(), result };
  return result;
}

/** 解析 ZCode.exe 路径（缓存 15 秒，避免反复拉起 PowerShell）：环境变量 > 运行进程 > 从 zcode.cjs 路径推导 > 工具配置记录 */
let exeCache = { at: 0, result: null };

function resolveZcodeExePath() {
  if (exeCache.at && Date.now() - exeCache.at < 15000) return exeCache.result;
  let result = null;
  if (process.env.ZPS_ZCODE_EXE && fs.existsSync(process.env.ZPS_ZCODE_EXE)) result = process.env.ZPS_ZCODE_EXE;
  if (!result) {
    try {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", "(Get-Process ZCode -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)"],
        { encoding: "utf8", timeout: 10000, windowsHide: true }
      );
      const exe = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (exe && fs.existsSync(exe)) result = exe;
    } catch {
      /* 继续 */
    }
  }
  if (!result) {
    const bundle = detectZcodeBundlePath();
    if (bundle) {
      const cand = path.resolve(path.join(path.dirname(bundle), "..", "..", "ZCode.exe"));
      if (fs.existsSync(cand)) result = cand;
    }
  }
  if (!result) {
    const cfg = loadToolConfig();
    if (cfg.zcodeExePath && fs.existsSync(cfg.zcodeExePath)) result = cfg.zcodeExePath;
  }
  exeCache = { at: Date.now(), result };
  return result;
}

/** 启动 ZCode（detached，不随切换器退出） */
function startZcode() {
  const exe = resolveZcodeExePath();
  if (!exe) throw new Error("找不到 ZCode.exe（可设置环境变量 ZPS_ZCODE_EXE，或在 tool.config.json 填 zcodeExePath）");
  const { spawn } = require("node:child_process");
  const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  runCache = { at: Date.now(), result: true };
  exeCache = { at: 0, result: null };
  return { exePath: exe, pid: child.pid };
}

/** 强制结束所有 ZCode 进程；结束前把 exe 路径记进配置，保证之后能一键重启 */
function killZcode() {
  const exe = resolveZcodeExePath();
  if (exe) {
    const cfg = loadToolConfig();
    cfg.zcodeExePath = exe;
    saveToolConfig(cfg);
  }
  const out = execFileSync("taskkill", ["/F", "/IM", "ZCode.exe"], { encoding: "utf8", windowsHide: true });
  runCache = { at: Date.now(), result: false };
  exeCache = { at: 0, result: null };
  clearDetectCache();
  return { output: out.trim(), exePath: exe };
}

module.exports = {
  ROOT,
  BACKUPS_DIR,
  TOOL_CONFIG_PATH,
  LEGACY_ORIGINAL_BACKUP,
  IDENTITY_ANCHOR,
  CLI_PREFIX_ANCHOR,
  IMPORTANT_ANCHOR,
  parseFragments,
  parseProfileLayers,
  normalizeZcodePath,
  detectZcodeBundlePath,
  getZcodeVersion,
  versionedBackupPath,
  ensureVersionBackup,
  pruneVersionBaselines,
  extractEffectivePrompt,
  VERSION_BASELINE_KEEP,
  patchState,
  patchBundle,
  restoreBundle,
  resolveProfileContent,
  loadActiveProfile,
  isZcodeRunning,
  resolveZcodeExePath,
  startZcode,
  killZcode,
};
