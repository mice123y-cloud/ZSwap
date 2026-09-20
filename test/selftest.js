/**
 * 自测脚本：用一个临时隔离环境（临时 ZPS_ROOT / 伪造 zcode.cjs）完整验证：
 *   1. 档案管理（新建 / 非法接口 404）
 *   2. 文件补丁全流程（打补丁 / 重打 / 外部改动拒绝 / 字节级还原）
 *   3. 版本感知基线（新版本自动备份 / 按版本还原 / 不回滚旧版本）
 *   4. 版本基线保留策略（合计 20 份，淘汰最旧的）
 *   5. 备份管理（手动快照 / 锚点禁删 / 旧版本基线可删）
 *   6. 登录认证（401 / 登录 / 会话 Cookie）
 *
 * 不触碰真实的 zcode.cjs 与本项目的 prompts/ 目录。
 * 使用非默认端口并做「实例身份校验」：若目标端口上跑的是别的实例，立即中止。
 * 运行：node test/selftest.js
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");

let CONSOLE_PORT = 18200;
let AUTH_PORT = 18201;
const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zps-test-"));

/** 动态找两个空闲端口，避免与用户正在运行的切换器冲突 */
async function pickFreePorts() {
  const netmod = require("node:net");
  const free = (p) =>
    new Promise((resolve) => {
      const s = netmod.createServer();
      s.once("error", () => resolve(false));
      s.once("listening", () => s.close(() => resolve(true)));
      s.listen(p, "127.0.0.1");
    });
  for (let base = 18200; base < 18400; base += 2) {
    if ((await free(base)) && (await free(base + 1))) {
      CONSOLE_PORT = base;
      AUTH_PORT = base + 1;
      return;
    }
  }
  throw new Error("找不到空闲端口");
}

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${extra ? " —— " + extra : ""}`);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitHealthy(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

async function api(pathname, opts) {
  const r = await fetch(`http://127.0.0.1:${CONSOLE_PORT}${pathname}`, opts);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j, headers: r.headers };
}

/* ---------------- 主流程 ---------------- */
async function main() {
  // 0. 先选空闲端口，避免与运行中的切换器冲突
  await pickFreePorts();

  // 1. 搭建隔离环境
  const tmpRoot = path.join(TMP, "root");
  fs.mkdirSync(path.join(tmpRoot, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "backups"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "public"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "public", "index.html"), path.join(tmpRoot, "public", "index.html"));
  fs.copyFileSync(path.join(ROOT, "public", "login.html"), path.join(tmpRoot, "public", "login.html"));

  const toolCfgPath = path.join(tmpRoot, "tool.config.json");
  fs.writeFileSync(toolCfgPath, JSON.stringify({ port: CONSOLE_PORT }, null, 2));

  // 伪造一份带锚点的 zcode.cjs，用于注入测试（与真实文件 3.14 的压缩结构一致：
  // cli_prefix 单空格、IMPORTANT 段抽成模块级变量、三元身份句、Harness 段为 Xfn() 函数调用）
  const fakeBundlePath = path.join(tmpRoot, "fake-zcode.cjs");
  const BQ = "`"; // 反引号
  const RN = "\n"; // 真实 bundle 里 join 的模板字面量内是真实换行
  fs.writeFileSync(
    fakeBundlePath,
    'var NOi="You are ZCode, an interactive coding agent";function Sle(){let e=NOi;return{name:"CLI Prefix",source:"cli_prefix",injectionTarget:"system"}}' + RN +
      'var weo="IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases."' + RN +
      'function Xfn(){return["# Harness","- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal."].join(' + BQ + RN + BQ + ")}" + RN +
      'function $Oi(e){return[["",e?"You respond to the user according to the active Output Style below while using ZCode\'s tools and instructions.":' +
      '"You are an interactive ZCode agent that helps users with software engineering tasks.",' +
      '"",weo' +
      "].join(" + BQ + RN + BQ + '),"",Xfn()].join(' + BQ + RN + BQ + ")}" + RN,
    "utf8"
  );

  // 预放一个哨兵档案：实例身份校验用（确认连上的是测试子进程，不是别的实例）
  fs.writeFileSync(path.join(tmpRoot, "prompts", "隔离校验档案.md"), "sentinel", "utf8");

  // 隔离的记忆库根目录 + 索引文件
  const memRoot = path.join(tmpRoot, "memory-root");
  fs.mkdirSync(memRoot, { recursive: true });
  fs.writeFileSync(path.join(memRoot, "MEMORY.md"), "# Memory Index\n", "utf8");

  // 2. 启动控制台（隔离环境；固定版本号 testver1，保证备份文件名断言确定）
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      ...process.env,
      ZPS_PORT: String(CONSOLE_PORT),
      ZPS_ROOT: tmpRoot,
      ZPS_TOOL_CONFIG: toolCfgPath,
      ZPS_ZCODE_CJS: fakeBundlePath,
      ZPS_ZCODE_VERSION: "testver1",
      ZPS_MEMORY_ROOT: memRoot,
      ZPS_NO_BROWSER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});

  console.log("等待控制台启动...");
  const healthy = await waitHealthy(`http://127.0.0.1:${CONSOLE_PORT}/healthz`);
  check("控制台 /healthz 正常", healthy);
  if (!healthy) { child.kill(); process.exit(1); }

  // 实例身份校验：确认连上的是测试子进程（读到的是临时目录里的哨兵档案）
  {
    const st = await api("/api/status");
    const isIsolated = st.body && Array.isArray(st.body.profiles) && st.body.profiles.some((p) => p.name === "隔离校验档案");
    check("隔离校验: 读到的是临时环境的哨兵档案", isIsolated, JSON.stringify(st.body.profiles));
    if (!isIsolated) {
      console.error("安全中止：目标端口上运行的不是测试子进程（可能命中正在使用的切换器），已停止测试。");
      child.kill();
      process.exit(1);
    }
  }

  const PROMPT = '【自测】渗透测试系统提示词 v1\n含 "双引号" 与 \\ 反斜杠 🚀';

  /* 3. 档案管理（分层 JSON 档案） */
  let r = await api("/api/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "自测档案", content: JSON.stringify({ identity: PROMPT, important: "" }) }) });
  check("创建档案(分层JSON)", r.status === 200, JSON.stringify(r.body));

  r = await api("/api/profiles/自测档案", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x", content: "y" }) });
  check("非法接口 404", r.status === 404);

  /* 4. 激活（选定打补丁目标） */
  r = await api("/api/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: "自测档案" }) });
  check("激活档案", r.status === 200 && r.body.active && r.body.active.profile === "自测档案", JSON.stringify(r.body));

  /* 5. 文件注入（对伪造的 zcode.cjs 操作，隔离环境） */
  const beforePatch = fs.readFileSync(fakeBundlePath);

  // 注入前：实际生效 = 原始提示词
  r = await api("/api/effective-prompt");
  check("effective: 注入前为原始提示词", r.status === 200 && r.body.ok && r.body.isOriginal === true && r.body.identity.includes("interactive ZCode agent") && r.body.importantEmpty === false, JSON.stringify(r.body).slice(0, 200));

  r = await api("/api/patch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  check("patch: 返回 200", r.status === 200, JSON.stringify(r.body));
  const patchedText = fs.readFileSync(fakeBundlePath, "utf8");
  check("patch: 已生成当前版本的原始备份(zcode-testver1.cjs)", fs.existsSync(path.join(tmpRoot, "backups", "zcode-testver1.cjs")));
  check("patch: 身份句替换为档案内容(含转义)", patchedText.includes(JSON.stringify(PROMPT)));
  check("patch: IMPORTANT 段已清空", !patchedText.includes("IMPORTANT: Assist with"));
  check("patch: 补丁结果语法合法", spawnSync(process.execPath, ["--check", fakeBundlePath]).status === 0);
  r = await api("/api/status");
  check("patch: 状态为已打补丁", r.body.patch && r.body.patch.state === "patched", JSON.stringify(r.body.patch));

  // 注入后：实际生效 = 档案内容，与激活档案一致
  r = await api("/api/effective-prompt");
  check("effective: 注入后为档案内容且与激活档案一致", r.status === 200 && r.body.ok && r.body.isOriginal === false && r.body.matchesActive === true && r.body.identity === PROMPT && r.body.importantEmpty === true, JSON.stringify(r.body).slice(0, 200));
  // 再次打补丁：自动还原原始后再打（支持反复切换档案）
  r = await api("/api/patch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  check("patch: 再次打补丁成功(200，自动还原后重打)", r.status === 200, JSON.stringify(r.body));
  const patchedText2 = fs.readFileSync(fakeBundlePath, "utf8");
  check("patch: 重打后内容正确", patchedText2.includes(JSON.stringify(PROMPT)) && !patchedText2.includes("IMPORTANT: Assist with"));
  // 外部改动（模拟更新覆盖）：拒绝，防止误操作
  fs.appendFileSync(fakeBundlePath, "\n// external change\n");
  r = await api("/api/patch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  check("patch: 外部改动后被拒绝(500)", r.status === 500, JSON.stringify(r.body));
  r = await api("/api/unpatch", { method: "POST" });
  check("unpatch: 返回 200", r.status === 200, JSON.stringify(r.body));
  check("unpatch: 字节级还原", fs.readFileSync(fakeBundlePath).equals(beforePatch));

  // 还原后：实际生效回到原始提示词
  r = await api("/api/effective-prompt");
  check("effective: 还原后回到原始提示词", r.status === 200 && r.body.ok && r.body.isOriginal === true && r.body.importantEmpty === false, JSON.stringify(r.body).slice(0, 200));

  /* 5.5 分层注入：JSON 档案各层独立注入对应槽位 */
  {
    const FRAG_PREFIX = "You are DevMate, 我的技术搭档";
    const FRAG_IDENTITY = "你是【自测】分片身份：专注渗透测试与开发。";
    const FRAG_IMPORTANT = "MY CUSTOM SECURITY POLICY: authorized engagements only.";
    const FRAG_PROMPT = JSON.stringify({ cli_prefix: FRAG_PREFIX, identity: FRAG_IDENTITY, important: FRAG_IMPORTANT }, null, 2);
    r = await api("/api/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "分片自测档案", content: FRAG_PROMPT }) });
    check("分层: 创建档案", r.status === 200, JSON.stringify(r.body));
    r = await api("/api/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: "分片自测档案" }) });
    check("分层: 激活档案", r.status === 200);
    r = await api("/api/patch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    check("分层: 注入返回 200", r.status === 200, JSON.stringify(r.body).slice(0, 300));
    const fragText = fs.readFileSync(fakeBundlePath, "utf8");
    check("分层: cli_prefix 层已替换", fragText.includes(JSON.stringify(FRAG_PREFIX)) && !fragText.includes('"You are ZCode, an interactive coding agent"'));
    check("分层: identity 层已替换", fragText.includes(JSON.stringify(FRAG_IDENTITY)));
    check("分层: important 层替换为自定义(非清空)", fragText.includes(JSON.stringify(FRAG_IMPORTANT)) && !fragText.includes("IMPORTANT: Assist with"));
    check("分层: 注入结果语法合法", spawnSync(process.execPath, ["--check", fakeBundlePath]).status === 0);
    r = await api("/api/effective-prompt");
    check("分层: effective 三槽位读取正确",
      r.status === 200 && r.body.ok &&
      r.body.cliPrefix === FRAG_PREFIX &&
      r.body.identity === FRAG_IDENTITY &&
      r.body.importantState === "custom" &&
      r.body.matchesActive === true && r.body.isOriginal === false,
      JSON.stringify(r.body).slice(0, 300));
    r = await api("/api/unpatch", { method: "POST" });
    check("分层: 还原成功且字节级一致", r.status === 200 && fs.readFileSync(fakeBundlePath).equals(beforePatch));
  }

  /* 5.6 MD 兼容：旧格式整份进 identity 层并清空安全段 */
  {
    fs.writeFileSync(path.join(tmpRoot, "prompts", "旧版MD档案.md"), "旧版MD档案的整份内容，含 \"引号\"。", "utf8");
    r = await api("/api/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: "旧版MD档案" }) });
    check("MD兼容: 激活", r.status === 200);
    r = await api("/api/patch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    check("MD兼容: 注入返回 200", r.status === 200, JSON.stringify(r.body).slice(0, 200));
    const mdText = fs.readFileSync(fakeBundlePath, "utf8");
    check("MD兼容: 整份进 identity 层", mdText.includes(JSON.stringify("旧版MD档案的整份内容，含 \"引号\"。")));
    check("MD兼容: 安全段清空", !mdText.includes("IMPORTANT: Assist with"));
    r = await api("/api/unpatch", { method: "POST" });
    check("MD兼容: 还原", r.status === 200 && fs.readFileSync(fakeBundlePath).equals(beforePatch));
    // 收尾：切回主测试档案，保持后续断言环境一致
    await api("/api/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: "自测档案" }) });
  }

  /* 5.7 记忆库管理（可看可改） */
  {
    r = await api("/api/memory");
    check("记忆: 列表读取(含索引与全文)",
      r.status === 200 && r.body.ok &&
      r.body.files.some((f) => f.name === "MEMORY.md" && f.isIndex === true && f.content.includes("# Memory Index")),
      JSON.stringify(r.body).slice(0, 200));
    r = await api("/api/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "test-memory", content: "---\nname: test-memory\ndescription: t\n---\nv1" }) });
    check("记忆: 新建", r.status === 200 && fs.existsSync(path.join(memRoot, "test-memory.md")), JSON.stringify(r.body));
    r = await api("/api/memory/test-memory.md", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "---\nname: test-memory\n---\nv2" }) });
    check("记忆: 编辑(磁盘生效)", r.status === 200 && fs.readFileSync(path.join(memRoot, "test-memory.md"), "utf8").includes("v2"), JSON.stringify(r.body));
    r = await api("/api/memory/MEMORY.md", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "# Memory Index\n\n- [t](test-memory.md) — hook\n" }) });
    check("记忆: 索引可编辑", r.status === 200 && fs.readFileSync(path.join(memRoot, "MEMORY.md"), "utf8").includes("hook"), JSON.stringify(r.body));
    r = await api("/api/memory/MEMORY.md", { method: "DELETE" });
    check("记忆: 索引禁止删除(403)", r.status === 403, "status=" + r.status);
    r = await api("/api/memory/test-memory.md", { method: "DELETE" });
    check("记忆: 删除", r.status === 200 && !fs.existsSync(path.join(memRoot, "test-memory.md")));
    r = await api("/api/status");
    check("记忆: status 含 memory 节", r.body.memory && r.body.memory.root === memRoot && Array.isArray(r.body.memory.files), JSON.stringify(r.body.memory));
    check("original: status 返回三层原文(新建预填用)",
      r.body.originalPrompt &&
      r.body.originalPrompt.cli_prefix.includes("interactive coding agent") &&
      r.body.originalPrompt.identity.includes("interactive ZCode agent") &&
      r.body.originalPrompt.important.includes("authorized security testing"),
      JSON.stringify(r.body.originalPrompt).slice(0, 150));
  }

  /* 6. 版本感知：模拟 ZCode 更新重置 cjs → 新版本自动备份，旧版本基线保留 */
  {
    const backupsDir = path.join(tmpRoot, "backups");
    const cliEnv = (ver) => ({
      ...process.env,
      ZPS_ROOT: tmpRoot,
      ZPS_TOOL_CONFIG: toolCfgPath,
      ZPS_ZCODE_CJS: fakeBundlePath,
      ZPS_ZCODE_VERSION: ver,
    });
    check("版本基线: v1 基线存在(zcode-testver1.cjs)", fs.existsSync(path.join(backupsDir, "zcode-testver1.cjs")));

    // 模拟 ZCode 更新：cjs 被重置为「新版本的原始内容」（锚点完好、内容有变）
    const v2Pristine = fs.readFileSync(fakeBundlePath, "utf8") + "\n// zcode v2 original\n";
    fs.writeFileSync(fakeBundlePath, v2Pristine, "utf8");

    const c = spawnSync(process.execPath, [path.join(ROOT, "patch-cli.js"), "check"], { env: cliEnv("testver2"), encoding: "utf8", timeout: 60000 });
    check("版本升级: check 退出码 0", c.status === 0, (c.stderr || "").slice(0, 300));
    let cj = null;
    try {
      const s = c.stdout || "";
      cj = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
    } catch {}
    check("版本升级: 识别为新版本并自动备份", cj && cj.newVersionBackedUp === true && cj.version === "testver2", c.stdout);
    check("版本升级: 新基线 zcode-testver2.cjs 已生成", fs.existsSync(path.join(backupsDir, "zcode-testver2.cjs")));
    check("版本升级: 旧版本 v1 基线仍保留", fs.existsSync(path.join(backupsDir, "zcode-testver1.cjs")));

    // 在新版本上打补丁 → 还原，必须字节级等于新版本原始内容（不得回滚到旧版本）
    const a = spawnSync(process.execPath, [path.join(ROOT, "patch-cli.js"), "apply", "自测档案"], { env: cliEnv("testver2"), encoding: "utf8", timeout: 60000 });
    check("版本升级: v2 上 apply 成功", a.status === 0, (a.stderr || "").slice(0, 300));
    const rr = spawnSync(process.execPath, [path.join(ROOT, "patch-cli.js"), "restore"], { env: cliEnv("testver2"), encoding: "utf8", timeout: 60000 });
    check("版本升级: v2 restore 成功", rr.status === 0, (rr.stderr || "").slice(0, 300));
    check("版本升级: v2 restore 字节级还原(不回滚旧版本)", fs.readFileSync(fakeBundlePath, "utf8") === v2Pristine);
  }

  /* 7. 手动备份 */
  r = await api("/api/backup", { method: "POST" });
  check("backup: 手动备份成功", r.status === 200, JSON.stringify(r.body));
  const bk = r.body.created || [];
  check("backup: 快照文件已生成", bk.some((n) => n.startsWith("zcode.cjs.")) && bk.every((n) => fs.existsSync(path.join(tmpRoot, "backups", n))));
  r = await api("/api/status");
  check("backup: 列表包含版本基线备份", (r.body.backups || []).some((b) => b.name === "zcode-testver1.cjs"));
  check("backup: 列表包含时间戳快照", (r.body.backups || []).some((b) => b.name.startsWith("zcode.cjs.") && b.name.endsWith(".bak")));
  // 删除保护与删除
  const snapName = (r.body.backups || []).find((b) => b.name.startsWith("zcode.cjs.") && b.name.endsWith(".bak")).name;
  r = await api("/api/backups/zcode.cjs.original", { method: "DELETE" });
  check("backup: 遗留锚点备份禁止删除(403)", r.status === 403, "status=" + r.status);
  r = await api("/api/backups/zcode-testver1.cjs", { method: "DELETE" });
  check("backup: 当前版本基线禁止删除(403)", r.status === 403, "status=" + r.status);
  r = await api("/api/backups/zcode-testver2.cjs", { method: "DELETE" });
  check("backup: 旧版本基线可删除(200)", r.status === 200, JSON.stringify(r.body));
  check("backup: 旧版本基线文件已删除", !fs.existsSync(path.join(tmpRoot, "backups", "zcode-testver2.cjs")));
  r = await api("/api/backups/" + encodeURIComponent(snapName), { method: "DELETE" });
  check("backup: 删除快照成功", r.status === 200, JSON.stringify(r.body));
  check("backup: 快照文件已删除", !fs.existsSync(path.join(tmpRoot, "backups", snapName)));

  /* 8. 保留策略：版本基线超过 20 份时自动淘汰最旧的（当前版本那份永不淘汰） */
  {
    const backupsDir = path.join(tmpRoot, "backups");
    const cliEnv = (ver) => ({
      ...process.env,
      ZPS_ROOT: tmpRoot,
      ZPS_TOOL_CONFIG: toolCfgPath,
      ZPS_ZCODE_CJS: fakeBundlePath,
      ZPS_ZCODE_VERSION: ver,
    });
    // 伪造 22 份旧版本基线（mtime 拉开间隔，保证淘汰顺序确定）
    const base = Date.now() / 1000 - 3600;
    for (let i = 0; i < 22; i++) {
      const p = path.join(backupsDir, `zcode-dummy${String(i).padStart(2, "0")}.cjs`);
      fs.writeFileSync(p, "dummy");
      fs.utimesSync(p, base + i, base + i);
    }
    // 触发一个新版本基线（testver3），应同时触发保留策略清理
    const c3 = spawnSync(process.execPath, [path.join(ROOT, "patch-cli.js"), "check"], { env: cliEnv("testver3"), encoding: "utf8", timeout: 60000 });
    check("保留策略: check 退出码 0", c3.status === 0, (c3.stderr || "").slice(0, 300));
    check("保留策略: 新基线 zcode-testver3.cjs 已生成", fs.existsSync(path.join(backupsDir, "zcode-testver3.cjs")));
    const kept = fs.readdirSync(backupsDir).filter((f) => /^zcode-[A-Za-z0-9._-]+\.cjs$/.test(f));
    check("保留策略: 版本基线合计只保留 20 份", kept.length === 20, "剩余 " + kept.length + " 份: " + kept.join(","));
    check("保留策略: 最旧的被淘汰(dummy00-02)", !fs.existsSync(path.join(backupsDir, "zcode-dummy00.cjs")) && !fs.existsSync(path.join(backupsDir, "zcode-dummy01.cjs")) && !fs.existsSync(path.join(backupsDir, "zcode-dummy02.cjs")));
    check("保留策略: 较新的 dummy21 保留", fs.existsSync(path.join(backupsDir, "zcode-dummy21.cjs")));
  }

  /* 9. 认证（第二个隔离实例，启用账号密码，vshell 式登录流） */
  const tmpRoot2 = path.join(TMP, "root2");
  fs.mkdirSync(path.join(tmpRoot2, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot2, "backups"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot2, "public"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "public", "index.html"), path.join(tmpRoot2, "public", "index.html"));
  fs.copyFileSync(path.join(ROOT, "public", "login.html"), path.join(tmpRoot2, "public", "login.html"));
  const toolCfg2 = path.join(tmpRoot2, "tool.config.json");
  fs.writeFileSync(toolCfg2, JSON.stringify({ port: AUTH_PORT, username: "admin", password: "pass123" }, null, 2));
  const child2 = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      ...process.env,
      ZPS_PORT: String(AUTH_PORT),
      ZPS_ROOT: tmpRoot2,
      ZPS_TOOL_CONFIG: toolCfg2,
      ZPS_NO_BROWSER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child2.stdout.on("data", () => {});
  child2.stderr.on("data", () => {});
  const authBase = `http://127.0.0.1:${AUTH_PORT}`;
  check("auth: 实例启动", await waitHealthy(`${authBase}/healthz`));
  let ar = await fetch(`${authBase}/api/status`);
  check("auth: 未登录访问 API 返回 401", ar.status === 401, "status=" + ar.status);
  ar = await fetch(`${authBase}/`, { redirect: "manual" });
  check("auth: 未登录访问页面 302 → /login", ar.status === 302 && (ar.headers.get("location") || "").includes("/login"));
  ar = await fetch(`${authBase}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "wrong" }),
  });
  check("auth: 错误密码 401", ar.status === 401, "status=" + ar.status);
  ar = await fetch(`${authBase}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pass123" }),
  });
  const setCookie = ar.headers.get("set-cookie") || "";
  check("auth: 正确密码 200 + 会话 Cookie", ar.status === 200 && setCookie.includes("zswap_session="));
  ar = await fetch(`${authBase}/api/status`, { headers: { cookie: setCookie.split(";")[0] } });
  check("auth: 携带会话访问 API 成功 200", ar.status === 200, "status=" + ar.status);
  child2.kill();

  /* 10. 收尾 */
  child.kill();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("自测异常:", e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
