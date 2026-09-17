/**
 * 命令行注入工具（不依赖切换器服务，直接操作）
 *
 * 用法：
 *   node patch-cli.js detect           探测 ZCode 的 zcode.cjs 位置
 *   node patch-cli.js status           显示注入状态（原始/已注入/被改动）
 *   node patch-cli.js check            检测当前 ZCode 版本；新版本自动备份原始 cjs（zcode-<版本号>.cjs）
 *   node patch-cli.js apply <档案名>    备份原始文件 + 把档案注入 zcode.cjs（需重启 ZCode 生效）
 *   node patch-cli.js restore          从当前版本的原始备份还原 zcode.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const E = require("./patch-engine.js");

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function main() {
  const cmd = process.argv[2];
  try {
    switch (cmd) {
      case "detect": {
        const target = E.detectZcodeBundlePath();
        if (!target) {
          console.error("未找到 zcode.cjs。可设置环境变量 ZPS_ZCODE_CJS 或在 tool.config.json 的 patchTargets 里指定路径。");
          process.exit(1);
        }
        console.log(target);
        break;
      }
      case "status": {
        const st = E.patchState();
        const labels = {
          no_target: "未找到目标文件",
          no_backup: "当前版本还没有原始备份（文件非原始状态，无法自动基线）",
          original: "原始（未注入）",
          patched: "已注入",
          modified: "文件被外部改动（可能被自动更新覆盖，需重新注入或还原）",
        };
        printJson({ ...st, stateLabel: labels[st.state] || st.state });
        break;
      }
      case "check": {
        const target = E.detectZcodeBundlePath();
        if (!target) {
          console.error("未找到 zcode.cjs。可设置环境变量 ZPS_ZCODE_CJS 或在 tool.config.json 的 patchTargets 里指定路径。");
          process.exit(1);
        }
        const ensure = E.ensureVersionBackup(target);
        const st = E.patchState();
        printJson({
          target,
          version: ensure.version,
          backup: path.basename(ensure.backup),
          newVersionBackedUp: ensure.created,
          reason: ensure.reason,
          patchState: st.state,
        });
        if (ensure.created) {
          console.log(`🆕 检测到新版本 ${ensure.version}，已自动备份原始 zcode.cjs → backups/${path.basename(ensure.backup)}`);
        } else {
          console.log(`当前版本 ${ensure.version}（基线 ${ensure.reason === "exists" ? "已存在" : "未建立：" + ensure.reason}）`);
        }
        break;
      }
      case "apply": {
        const profile = process.argv[3];
        if (!profile) {
          console.error("用法: node patch-cli.js apply <档案名>");
          process.exit(1);
        }
        const content = E.resolveProfileContent(profile);
        console.log(`档案「${profile}」内容 ${content.length} 字符`);
        const r = E.patchBundle(content);
        console.log("注入完成：");
        printJson(r);
        console.log("⚠️  请重启 ZCode 让注入的提示词生效。");
        break;
      }
      case "restore": {
        const r = E.restoreBundle();
        console.log("已还原：");
        printJson(r);
        console.log("⚠️  请重启 ZCode 让还原生效。");
        break;
      }
      case "effective": {
        const target = E.detectZcodeBundlePath();
        if (!target) throw new Error("未找到 zcode.cjs");
        const eff = E.extractEffectivePrompt(target);
        const active = E.loadActiveProfile();
        let impState = "保留";
        try {
          if (eff.importantEmpty) impState = "已清空";
          else if (eff.important !== JSON.parse(E.IMPORTANT_ANCHOR)) impState = "已替换为自定义";
        } catch {}
        console.log(`实际生效的身份段（版本 ${E.getZcodeVersion(target)}，安全段${impState}，激活档案 ${active}）：`);
        console.log(`开头句 (cli_prefix): ${eff.cliPrefix == null ? "（无法解析）" : eff.cliPrefix}`);
        console.log("─".repeat(60));
        console.log(eff.identity);
        console.log("─".repeat(60));
        break;
      }
      case "killzcode": {
        console.log("正在强制结束所有 ZCode.exe 进程…");
        const r = E.killZcode();
        console.log(r.output);
        console.log(`ZCode 已结束。重新启动：node patch-cli.js startzcode（或直接打开 ${r.exePath || "ZCode"}）`);
        break;
      }
      case "startzcode": {
        const r = E.startZcode();
        console.log(`已启动 ZCode：${r.exePath}（pid ${r.pid}）`);
        break;
      }
      case "backup": {
        const target = E.detectZcodeBundlePath();
        if (!target) throw new Error("未找到 zcode.cjs，无法备份");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const name = `zcode.cjs.${stamp}.bak`;
        fs.copyFileSync(target, path.join(E.BACKUPS_DIR, name));
        console.log(`已创建备份点：${name}`);
        break;
      }
      default: {
        console.log("用法: node patch-cli.js <detect|status|check|apply <档案名>|restore|effective|killzcode|startzcode|backup>");
        process.exit(1);
      }
    }
  } catch (e) {
    console.error("错误: " + e.message);
    process.exit(1);
  }
}

main();
