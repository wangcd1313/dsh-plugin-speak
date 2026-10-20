# dsh-plugin-speak —— DSH 回答语音朗读插件

> 仓库：<https://github.com/wangcd1313/dsh-plugin-speak> · 许可：MIT

把 DSH 的回复用语音念出来，**在「设置 → 通用」里可调**，随 DSH 启动自动生效，对所有会话有效。

- 宿主半侧 `lib/index.js`：监听回合结束 → 读该轮转写 → 清洗 Markdown → 合成语音并播放。
- 浏览器半侧 `lib/client.js`：在设置页「通用」里加一张「语音朗读」卡片。

## 装在哪儿

| 位置 | 作用 |
| --- | --- |
| `~/.dsh/tools/dsh-plugin-speak/` | **源目录**（改这里，然后同步到 profile） |
| `~/.dsh/profiles/desktop/node_modules/dsh-plugin-speak/` | DSH 实际加载的副本 |
| `~/.dsh/profiles/desktop/package.json` → `dependencies` | 声明为 profile 依赖（`file:../../tools/dsh-plugin-speak`） |
| `~/.dsh/profiles/desktop/cordis.patch.yml` → `- id: speak` | 启用条目与默认配置 |

改完源码同步：

```powershell
Copy-Item "$env:USERPROFILE\.dsh\tools\dsh-plugin-speak\lib\*" `
          "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-plugin-speak\lib\" -Force
```

## 设置项（都即时生效，不用重启）

| 键 | 含义 | 默认 |
| --- | --- | --- |
| `enabled` | 总开关 | 开 |
| `stopOnWindowChange` | 切换窗口立即停止朗读（离开 DSH 窗口就静音；切走期间结束的回复不念，回窗口后恢复） | 开 |
| `stopOnSessionSwitch` | 切换会话立即停止朗读（从会话 A 切到会话 B 时，正在念的回复马上停止；新会话照常朗读） | 开 |
| `readFinal` | 朗读每轮最终回复 | 开 |
| `readSteps` | 朗读每一步的过程说明 | 关 |
| `readReasoning` | 朗读思考过程（reasoning） | 关 |
| `readToolCalls` | 朗读工具调用摘要 | 关 |
| `skipCode` | 跳过代码块 | 开 |
| `maxChars` | 单次最多字数（超出按句号截断） | 800 |
| `engine` | `auto` / `edge` / `sapi` | auto |
| `voice` | Edge 音色 | `zh-CN-XiaoxiaoNeural` |
| `rate` | 语速 −50…+50 | 0 |
| `volume` | 音量 0–100 | 100 |

设置页写入会落回 `cordis.patch.yml` 的 `- id: speak` 段。

## 切换窗口 / 切换会话立即停止朗读（`stopOnWindowChange` / `stopOnSessionSwitch`）

目标：用户切到别的窗口/应用，或从会话 A 切到会话 B 时，正在念的回复马上闭嘴；
切窗口期间结束的回复也不再念，回到 DSH 窗口后恢复。两个开关互相独立。

链路（两端都在本插件里）：

1. **浏览器半侧** `lib/client.js` 监听 `window` 的 `blur` / `focus` / `pagehide` 与
   `document.visibilitychange`，失焦时向 `http://127.0.0.1:47653..47657` 逐个
   `POST /stop`，回焦时 `POST /focus`（`mode:'no-cors'`，宿主的控制端只认这几个端口）。
2. **切换会话**：客户端订阅 `uiSession.current`（当前主视图会话 binding），`key`（sessionId）
   变化即 `POST /session`。宿主只停下当前这一段并压 3 秒，**不做长时间静音**——用户还在
   看 DSH，新会话的回复该念还得念。
3. **宿主半侧** `lib/index.js` 在 `127.0.0.1` 上起一个只处理 `/stop`、`/session`、`/focus`
   的极简 HTTP 控制端（端口 47653–47657 里第一个可用的）。收到 `/stop` 立刻
   `taskkill /T /F` 掉正在播放的 PowerShell，并把「静音窗口」设成 60 秒；`/session`
   同样杀播放但只压 3 秒；`/focus` 立即解除。
4. **合成期间切走也算**：Edge 合成要几秒，`speak()` 在合成后、播放前会再判一次，
   已切走就直接丢弃音频，不会「切走了过几秒突然响」。
5. 防呆：页面万一没上报回焦（旧前端、渲染进程挂起），静音最多持续 60 秒后自动恢复。

> 改这两段代码后 DSH 必须重启才生效（客户端半侧刷新页面即可，宿主半侧要重启进程）。
> 重启后日志里会有 `控制端已监听 127.0.0.1:47653（切换窗口/会话立即停止朗读）`。

### 兜底哨兵（仅在新版插件生效前临时用）

`~/.dsh/tools/focus-speak-guard.ps1` 是给「代码已改、DSH 还没重启」这段空窗期兜底的：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\tools\focus-speak-guard.ps1" -Watch
```

它每 300ms 读一次 DSH 主窗口标题（「会话名 — DeepSeek Harness」），标题变化即视为切换
会话，立刻杀掉正在朗读的 PowerShell，并在随后 10 秒内继续拦截（防止旧会话的回复合成完
才出声）。**只看标题、不看前台窗口**——本机常用向日葵（AweSun）远程，前台窗口可能一直是
AweSun，看前台会误判。当 `speak-plugin.log` 里出现重启后新版插件的「切换窗口/会话立即
停止朗读」时**自动退出**，不需要装开机自启；日志在 `~/.dsh/logs/focus-speak-guard.log`。
`-Test` 只打印状态，`-DryRun` 只记录不杀进程。

## 实现要点（踩过的坑，改之前先看）

1. **第三方插件的 schemastery 是 npm 版（3.18.2），没有 `.volatile()`**。DSH 自己的
   `@deepseek-ai/schemastery`（asar 内）才扩展了这个方法。所以这里：
   - 用 `live()` 复制 schema 并手工打 `meta.volatile = true`（等价于官方 `.volatile()`，
     因为 `extra()` 的实现就是写 `meta[key]`）；
   - **再包一层 `Config['~standard'].validate`**，把 volatile 字段换成
     `{ get(), [Symbol.for("cosmokit.volatile.write")](next) }` 引用。
     引用符号必须是 `Symbol.for(...)`（全局注册），loader 的 `isVolatile` 才能跨模块认出来；
     npm 版 schemastery 不会自己生成这个引用。
   - 不能写成 `Object.create(Config)`：那样 `Config` 不可调用、`toJSON()` 也会坏。
     必须 `Object.defineProperty(baseConfig, '~standard', ...)` 原地替换。
2. **配置读取一律用 `value(field)`**：volatile 字段是引用，要 `.get()`；普通字段直接用。
3. **`sawOpen` 只信内存，不落盘**：否则插件重启瞬间会把早就结束的旧回复当成刚结束念一遍。
4. 转写是**多帧 zstd 追加写**，必须按 magic `28 B5 2F FD` 切帧逐帧解压（只解第一帧会丢内容）。
5. `readSteps` 与 `readFinal` 互斥取一份（否则同一段文字念两遍）。
6. 首次见到某个会话只建基线，不朗读历史。
7. 播放用 `powershell + WPF MediaPlayer`（`windowsHide`），退出时 `taskkill /T /F`；
   edge 用 `py -m edge_tts` 合成，失败自动退回 SAPI（Microsoft Huihui Desktop）。

## 验证

```powershell
# 1) 模块与配置解析（不依赖 DSH）
cd "$env:USERPROFILE\.dsh\profiles\desktop"
node --input-type=module -e "const m = await import('./node_modules/dsh-plugin-speak/lib/index.js'); const c = m.Config['~standard'].validate({}).value; console.log(c.enabled.get(), c.voice.get())"

# 2) 端到端（造一个假会话，触发一次朗读）
node D:\deepseek-work\_diag\speak-plugin-test.js

# 3) 插件在 DSH 里的日志
Get-Content "$env:USERPROFILE\.dsh\logs\speak-plugin.log" -Tail 20
```

日志里应有 `插件已加载`（DSH 启动/热加载时）与 `朗读（…，engine=edge，…）`。

## 回退到旧的独立监听器

旧方案（`~/.dsh/tools/turn-speak.js`，不依赖 DSH 插件、可在 DSH 未重启时工作）仍然保留：

```powershell
node "$env:USERPROFILE\.dsh\tools\turn-speak.js" --start      # 起监听
Move-Item "$env:USERPROFILE\.dsh\tools\DSH-TurnSpeak-Watch.vbs.disabled" `
          "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\DSH-TurnSpeak-Watch.vbs"   # 恢复自启
```

**两者不要同时开**，否则同一段回复会念两遍。
