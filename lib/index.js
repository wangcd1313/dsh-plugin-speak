/**
 * DSH 回答语音朗读 —— 宿主（Host）半侧插件
 * ============================================================================
 * 功能：每一轮回答结束（或每一步、每段思考、每次工具调用，取决于设置）时，
 *      把要念的内容用语音朗读出来。配置项通过 volatile() 暴露，出现在
 *      DSH「设置」里，可随时调整，改完即时生效（无需重启）。
 *
 * 为什么用轮询而不是内部事件：会话状态投影
 * (`~/.dsh/storages/session_projcache/sessions/*.json`) 是 DSH 自己维护的稳定产物，
 * `turnBoundary.openTurnStartSeq` 由非 null 变 null 即一轮结束；转写文件
 * (`~/.dsh/sessions/<工作区>/session-<id>/session.v4.jsonl.zstd`) 是权威内容来源。
 * 这条链路在 2026-10-20 已端到端验证过（见 ~/.dsh/tools/turn-speak.js）。
 *
 * 语音引擎：
 *   edge  微软 Edge 在线语音（默认 zh-CN-XiaoxiaoNeural，自然）；需要 `py -m edge_tts`
 *   sapi  Windows 本机语音（Microsoft Huihui Desktop，离线，机械）
 *   auto  优先 edge，失败自动退回 sapi
 */
import z from '@deepseek-ai/schemastery';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

export const name = 'speak';

/** 不依赖其它服务；Config 变化由 volatile 通知，无需重启插件。 */
export const inject = [];

/**
 * 标记字段为「可热改」（等同于官方 `.volatile()`）。
 *
 * 为什么不直接 `.volatile()`：DSH 自带的 schemastery（asar 内）才扩展了这个方法，
 * 而 profile 里给第三方插件解析到的是 npm 版（3.18.2，没有 `.volatile`）。
 * Loader 识别 volatile 用的是鸭子类型 —— `schema.meta.volatile` 与
 * `schema['~standard'].vendor === 'schemastery'`（见 @deepseek-ai/cordis-plugin-loader），
 * 所以复制一份 schema 手工打上 meta 标记即可，效果与官方方法一致。
 */
function live(schema) {
  const copy = z(schema);
  copy.meta = { ...(copy.meta || {}), volatile: true };
  return copy;
}

/**
 * volatile 字段在「解析后的配置」里必须是一个引用（`{ get(), [write](next) }`），
 * 这样设置页改写时能原地换快照、不重载插件。
 *
 * npm 版 schemastery 不生成引用（那是 DSH 补丁版的行为），所以这里自己补一层：
 * `Symbol.for("cosmokit.volatile.write")` 是全局注册的符号，loader 的
 * `isVolatile()` / `updateVolatile()` 用的正是它，跨模块实例依然相等。
 */
const WRITE = Symbol.for('cosmokit.volatile.write');

function freezeValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezeValue));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeValue(item)])));
}

function volatileRef(initial) {
  let current = freezeValue(initial);
  return Object.freeze({
    get: () => current,
    [WRITE]: (next) => { current = freezeValue(next); },
  });
}

const baseConfig = z.object({
  enabled: live(z.boolean().default(true)
    .description('总开关：关闭后不再朗读任何内容（打开设置即生效，无需重启 DSH）')),
  stopOnWindowChange: live(z.boolean().default(true)
    .description('切换窗口立即停止朗读：离开 DSH 窗口时马上静音，切走期间结束的回复不再念（默认开启）')),
  stopOnSessionSwitch: live(z.boolean().default(true)
    .description('切换会话立即停止朗读：从会话 A 切到会话 B 时，正在念的回复马上停止（默认开启）')),
  readFinal: live(z.boolean().default(true)
    .description('朗读每一轮的最终回复（推荐保持开启）')),
  readSteps: live(z.boolean().default(false)
    .description('朗读过程中每一步的说明文字（长任务会念很多，默认关）')),
  readReasoning: live(z.boolean().default(false)
    .description('朗读模型的思考过程（reasoning 块；默认关）')),
  readToolCalls: live(z.boolean().default(false)
    .description('朗读工具调用摘要（工具名与关键参数；默认关）')),
  skipCode: live(z.boolean().default(true)
    .description('跳过 Markdown 代码块（代码念出来没意义；默认跳过）')),
  maxChars: live(z.number().step(100).min(100).max(8000).default(800)
    .description('单次最多朗读的字数，超出按句号截断（默认 800）')),
  engine: live(z.string().default('auto')
    .description('语音引擎：auto（自动）/ edge（Edge 在线自然音）/ sapi（Windows 本机音）')),
  voice: live(z.string().default('zh-CN-XiaoxiaoNeural')
    .description('Edge 音色，例如 zh-CN-XiaoxiaoNeural（女）/ zh-CN-YunxiNeural（男）/ zh-CN-XiaoyiNeural（活泼）')),
  rate: live(z.number().step(5).min(-50).max(50).default(0)
    .description('语速偏移百分比：-50 很慢，0 正常，+50 很快')),
  volume: live(z.number().step(5).min(0).max(100).default(100)
    .description('音量 0–100')),
});

const baseStandard = baseConfig['~standard'];

/** 与 schemastery 同签名，但把 volatile 字段换成引用。 */
Object.defineProperty(baseConfig, '~standard', {
  configurable: true,
  value: {
    version: baseStandard.version,
    vendor: baseStandard.vendor,
    validate(input) {
      const result = baseStandard.validate(input);
      if (result.issues) return result;
      const value = result.value || {};
      const resolved = {};
      for (const [key, field] of Object.entries(baseConfig.dict || {})) {
        resolved[key] = field && field.meta && field.meta.volatile ? volatileRef(value[key]) : value[key];
      }
      return { value: resolved };
    },
  },
});

export const Config = baseConfig;

// ---------------------------------------------------------------- 基础

const DSH = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CACHE_DIR = path.join(DSH, 'storages', 'session_projcache', 'sessions');
const SESSIONS_DIR = path.join(DSH, 'sessions');
const AUDIO_DIR = path.join(DSH, 'cache', 'speak-plugin');
const LOG_FILE = path.join(DSH, 'logs', 'speak-plugin.log');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const POLL_MS = 1000;

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let sink = () => {};
function log(line) {
  const text = `[${timestamp()}] ${line}`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 512 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    fs.appendFileSync(LOG_FILE, text + '\r\n', 'utf8');
  } catch { /* 日志失败不影响朗读 */ }
  try { sink(text); } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------- 配置读取

/** volatile 字段是引用对象；`.get()` 拿当前值，普通字段直接就是值。 */
function value(field) {
  if (field && typeof field.get === 'function') return field.get();
  return field;
}

function settings(config) {
  const read = (key, fallback) => {
    const raw = value(config[key]);
    return raw === undefined || raw === null ? fallback : raw;
  };
  return {
    enabled: Boolean(read('enabled', true)),
    stopOnWindowChange: Boolean(read('stopOnWindowChange', true)),
    stopOnSessionSwitch: Boolean(read('stopOnSessionSwitch', true)),
    readFinal: Boolean(read('readFinal', true)),
    readSteps: Boolean(read('readSteps', false)),
    readReasoning: Boolean(read('readReasoning', false)),
    readToolCalls: Boolean(read('readToolCalls', false)),
    skipCode: Boolean(read('skipCode', true)),
    maxChars: Math.max(100, Number(read('maxChars', 800)) || 800),
    engine: String(read('engine', 'auto')),
    voice: String(read('voice', 'zh-CN-XiaoxiaoNeural')),
    rate: Number(read('rate', 0)) || 0,
    volume: Math.max(0, Math.min(100, Number(read('volume', 100)) ?? 100)),
  };
}

// ---------------------------------------------------------------- 转写解码

/** 解多帧 zstd：DSH 是每追加一批事件写一个帧，标准解压只出第一帧。 */
function decodeTranscript(file, tailBytes) {
  let raw = fs.readFileSync(file);
  if (tailBytes && raw.length > tailBytes) {
    const slice = raw.subarray(raw.length - tailBytes);
    const first = slice.indexOf(MAGIC, 0);
    raw = first > 0 ? slice.subarray(first) : slice;
  }
  const starts = [];
  let index = raw.indexOf(MAGIC, 0);
  while (index !== -1) { starts.push(index); index = raw.indexOf(MAGIC, index + 1); }
  const parts = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : raw.length;
    try { parts.push(zlib.zstdDecompressSync(raw.subarray(start, end)).toString('utf8')); } catch { /* torn 帧 */ }
  }
  const events = [];
  for (const line of parts.join('').split(/\r?\n/)) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { /* 半行 */ }
  }
  return events;
}

const transcriptCache = new Map();
function transcriptPath(sessionId) {
  if (transcriptCache.has(sessionId)) return transcriptCache.get(sessionId);
  let found = null;
  try {
    for (const workspace of fs.readdirSync(SESSIONS_DIR)) {
      const dir = path.join(SESSIONS_DIR, workspace, sessionId);
      if (!fs.existsSync(dir)) continue;
      const file = fs.readdirSync(dir).find((entry) => entry.startsWith('session.') && entry.endsWith('.jsonl.zstd'));
      if (file) { found = path.join(dir, file); break; }
    }
  } catch { /* 目录不可读 */ }
  if (found) transcriptCache.set(sessionId, found);
  return found;
}

/** 取某回合里各步骤的助手消息（按 step 升序）。 */
function turnMessages(sessionId, turn) {
  const file = transcriptPath(sessionId);
  if (!file) return [];
  let events;
  try { events = decodeTranscript(file, 4 * 1024 * 1024); } catch (e) {
    log(`转写解压失败：${e && e.message}`);
    return [];
  }
  const messages = [];
  for (const event of events) {
    if (!event || event.type !== 'assistant/message') continue;
    const data = event.data || {};
    if (data.turn !== turn || !data.message || !Array.isArray(data.message.content)) continue;
    messages.push({ step: Number(data.step) || 0, blocks: data.message.content });
  }
  messages.sort((a, b) => a.step - b.step);
  return messages;
}

// ---------------------------------------------------------------- 文本组装

function markdownToSpeech(markdown, skipCode) {
  let text = String(markdown);
  if (skipCode) {
    text = text.replace(/```[\s\S]*?```/g, '');
    text = text.replace(/~~~[\s\S]*?~~~/g, '');
    text = text.replace(/`([^`\n]{1,120})`/g, (whole, inner) => (inner.length <= 24 ? inner : '代码'));
  } else {
    text = text.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, '$1');
    text = text.replace(/`/g, '');
  }
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/<[^>]{1,200}>/g, '');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}([-*+]|\d{1,3}[.)])\s+/gm, '');
  text = text.replace(/\|/g, ' ');
  text = text.replace(/^\s*[-:=\s]{4,}\s*$/gm, '');
  text = text.replace(/(\*\*|__|\*|_|~~)/g, '');
  text = text.replace(/https?:\/\/\S+/g, '链接');
  text = text.replace(/[\u200b-\u200f\u202a-\u202e]/g, '');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{2,}/g, '\n');
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '');
  text = text.replace(/[（(]\s*[)）]/g, '');
  return text.replace(/[ \t]*\n[ \t]*/g, '\n').trim();
}

function brief(value, limit = 80) {
  let text = '';
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = String(value); }
  text = String(text || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

/** 按设置挑出这一回合要念的文本。 */
function composeSpeech(messages, cfg) {
  const sections = [];
  const texts = [];
  const reasonings = [];
  const tools = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) texts.push(block.text.trim());
      else if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim()) reasonings.push(block.text.trim());
      else if (block.type === 'tool-call' && block.name) tools.push(`${block.name}${block.arguments ? `：${brief(block.arguments, 60)}` : ''}`);
    }
  }

  if (cfg.readFinal && texts.length) sections.push(texts[texts.length - 1]);
  else if (cfg.readSteps && texts.length) sections.push(texts.join('\n'));
  if (cfg.readReasoning && reasonings.length) sections.push(reasonings.join('\n'));
  if (cfg.readToolCalls && tools.length) sections.push(`工具调用：${tools.join('；')}`);

  return sections.join('\n\n');
}

function truncateSpeech(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, maxChars);
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('\n'));
  const usable = stop > maxChars * 0.55 ? cut.slice(0, stop + 1) : cut;
  return { text: usable, truncated: true };
}

// ---------------------------------------------------------------- 播放

let current = null;          // 正在播放的子进程
let chain = Promise.resolve();
let edgeUsable = null;

// 窗口焦点状态：浏览器半侧通过本地控制端上报失焦/回焦。
let pageFocused = true;
let quietUntil = 0;          // 防呆：页面来不及上报回焦时，最多静音 60 秒
const QUIET_MS = 60 * 1000;

function shouldSkipSpeech(cfg, label) {
  if (!cfg.stopOnWindowChange) return false;
  if (pageFocused && Date.now() >= quietUntil) return false;
  log(`跳过朗读（${label}）：已切到其他窗口`);
  return true;
}

function killChild(child) {
  if (!child || child.killed) return;
  try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 已退出 */ }
}

function stopCurrent(reason) {
  if (!current) return;
  killChild(current.child);
  log(`停止上一段朗读（${reason}）`);
  current = null;
}

function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

function runPowerShell(script) {
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

function playMp3(file, cfg) {
  const script = [
    'Add-Type -AssemblyName PresentationCore;',
    '$p = New-Object System.Windows.Media.MediaPlayer;',
    `$p.Open([Uri]${psQuote(file)});`,
    `$p.Volume = ${Math.max(0, Math.min(1, cfg.volume / 100))};`,
    '$p.Play();',
    'Start-Sleep -Milliseconds 350;',
    '$deadline = [DateTime]::UtcNow.AddSeconds(40);',
    'while (-not $p.NaturalDuration.HasTimeSpan -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 150 };',
    'if ($p.NaturalDuration.HasTimeSpan) { $total = $p.NaturalDuration.TimeSpan.TotalMilliseconds;',
    '  while ($p.Position.TotalMilliseconds -lt $total - 120) { Start-Sleep -Milliseconds 150 } }',
    'else { Start-Sleep -Seconds 5 };',
    '$p.Stop(); $p.Close();',
  ].join(' ');
  return runPowerShell(script);
}

function speakSapi(file, cfg) {
  const sapiRate = Math.max(-10, Math.min(10, Math.round(cfg.rate / 5)));
  const script = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    `try { $s.SelectVoice('Microsoft Huihui Desktop') } catch { };`,
    `$s.Rate = ${sapiRate};`,
    `$s.Volume = ${Math.round(cfg.volume)};`,
    `$s.Speak([System.IO.File]::ReadAllText(${psQuote(file)}, [Text.Encoding]::UTF8));`,
  ].join(' ');
  return runPowerShell(script);
}

function synthesizeEdge(textFile, mp3, cfg) {
  return new Promise((resolve) => {
    const args = ['-m', 'edge_tts', '--voice', cfg.voice, '--rate', `${cfg.rate >= 0 ? '+' : ''}${cfg.rate}%`,
      '--volume', `+${Math.round((cfg.volume / 100) * 100)}%`, '--file', textFile, '--write-media', mp3];
    const child = spawn('py', args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { killChild(child); resolve(false); }, 90000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && fs.existsSync(mp3) && fs.statSync(mp3).size > 1024);
    });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

function cleanup(files) {
  for (const file of files) {
    try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch { /* 忽略 */ }
  }
  try {
    fs.readdirSync(AUDIO_DIR)
      .map((entry) => ({ entry, mtime: fs.statSync(path.join(AUDIO_DIR, entry)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(24)
      .forEach(({ entry }) => { try { fs.unlinkSync(path.join(AUDIO_DIR, entry)); } catch { /* 忽略 */ } });
  } catch { /* 忽略 */ }
}

async function speak(text, label, cfg) {
  const clean = String(text || '').trim();
  if (!clean) return;
  if (shouldSkipSpeech(cfg, label)) return;
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const stamp = Date.now();
  const textFile = path.join(AUDIO_DIR, `speak-${stamp}.txt`);
  fs.writeFileSync(textFile, clean, 'utf8');
  const mp3 = path.join(AUDIO_DIR, `speak-${stamp}.mp3`);

  const useEdge = cfg.engine === 'edge' || (cfg.engine === 'auto' && edgeUsable !== false);
  if (useEdge) {
    const ok = await synthesizeEdge(textFile, mp3, cfg);
    if (ok) {
      // 合成要几秒，期间用户可能已经切走：这时直接丢弃，不要突然出声。
      if (shouldSkipSpeech(cfg, label)) { cleanup([mp3, textFile]); return; }
      stopCurrent('新回复优先');
      const child = playMp3(mp3, cfg);
      current = { child };
      child.on('exit', () => { if (current && current.child === child) current = null; cleanup([mp3, textFile]); });
      log(`朗读（${label}，${clean.length} 字，engine=edge，voice=${cfg.voice}）`);
      return;
    }
    edgeUsable = false;
    log('Edge 合成失败，本次改用它本机语音（SAPI）');
    cleanup([mp3]);
  }

  if (shouldSkipSpeech(cfg, label)) { cleanup([textFile]); return; }
  stopCurrent('新回复优先');
  const child = speakSapi(textFile, cfg);
  current = { child };
  child.on('exit', () => { if (current && current.child === child) current = null; cleanup([textFile]); });
  log(`朗读（${label}，${clean.length} 字，engine=sapi）`);
}

// ---------------------------------------------------------------- 回合扫描

const state = new Map();

function noteKey(boundary) {
  const endSeq = boundary && boundary.lastStepBoundary && boundary.lastStepBoundary.kind === 'end'
    ? boundary.lastStepBoundary.seq
    : null;
  return endSeq !== null && endSeq !== undefined ? `end:${endSeq}` : null;
}

function scan(config) {
  const cfg = settings(config);
  const finished = [];
  let files;
  try { files = fs.readdirSync(CACHE_DIR); } catch { return finished; }
  const freshMs = 30 * 60 * 1000;
  const now = Date.now();

  for (const entry of files) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(CACHE_DIR, entry);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (now - stat.mtimeMs > freshMs) continue;

    let rows;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      rows = parsed && parsed.record && parsed.record.rows;
    } catch { continue; }
    if (!rows || !rows.turnBoundary || !rows.turnBoundary.val) continue;

    const boundary = rows.turnBoundary.val;
    const open = boundary.openTurnStartSeq !== null && boundary.openTurnStartSeq !== undefined;
    const lastTurn = Number(boundary.lastTurn) || 0;
    const key = open ? null : (noteKey(boundary) || `turn:${lastTurn}`);
    const previous = state.get(entry);

    if (!previous) {
      // 第一次见到这个会话：只记基线，不朗读历史
      state.set(entry, { sawOpen: open, lastTurn, firedKey: key });
      continue;
    }
    if (open) {
      previous.sawOpen = true;
      previous.lastTurn = Math.max(previous.lastTurn, lastTurn);
      continue;
    }

    const missedOpen = lastTurn > previous.lastTurn;
    if (key !== previous.firedKey && (previous.sawOpen || missedOpen) && lastTurn > 0) {
      previous.firedKey = key;
      finished.push({ sessionId: entry.replace(/\.json$/, ''), turn: lastTurn, label: `${entry.slice(8, 16)} 第 ${lastTurn} 轮` });
    }
    previous.sawOpen = false;
    previous.lastTurn = Math.max(previous.lastTurn, lastTurn);
  }
  return finished;
}

function handleTurn(event, config) {
  const cfg = settings(config);
  const messages = turnMessages(event.sessionId, event.turn);
  if (!messages.length) {
    log(`跳过 ${event.label}：没读到该轮内容`);
    return;
  }
  const raw = composeSpeech(messages, cfg);
  if (!raw.trim()) {
    log(`跳过 ${event.label}：这一轮没有可朗读的文字`);
    return;
  }
  const { text, truncated } = truncateSpeech(markdownToSpeech(raw, cfg.skipCode), cfg.maxChars);
  if (!text) {
    log(`跳过 ${event.label}：清洗后为空`);
    return;
  }
  const final = truncated ? `${text}\n（内容较长，后面还有，请看屏幕）` : text;
  speak(final, event.label, cfg).catch((e) => log(`朗读失败：${e && e.message}`));
}

// ---------------------------------------------------------------- 窗口切换控制端

/**
 * 浏览器半侧（lib/client.js）监听 window 的 blur / focus / visibilitychange，
 * 一旦离开 DSH 窗口就 POST 到这里的固定端口之一；宿主收到 /stop 立即杀掉播放进程。
 * 只监听 127.0.0.1，只处理「停止朗读」这一件事，不暴露任何别的能力。
 */
const CONTROL_PORTS = [47653, 47654, 47655, 47656, 47657];

let controlServer = null;
let controlPort = 0;

function markBlur(config) {
  const wasFocused = pageFocused;
  pageFocused = false;
  quietUntil = Date.now() + QUIET_MS;
  if (!settings(config).stopOnWindowChange) return;
  if (current) stopCurrent('切换窗口');
  if (wasFocused) log('窗口切走 → 立即停止朗读（回到 DSH 后恢复）');
}

function markFocus() {
  if (!pageFocused) log('窗口回到前台 → 恢复朗读');
  pageFocused = true;
  quietUntil = 0;
}

/** 切换会话：只停下当前这段，不做长时间静音（用户还在看 DSH，新会话该念还得念）。 */
const SESSION_QUIET_MS = 3000;

function markSessionSwitch(config) {
  if (!settings(config).stopOnSessionSwitch) return;
  if (current) stopCurrent('切换会话');
  quietUntil = Math.max(quietUntil, Date.now() + SESSION_QUIET_MS);
  log('切换会话 → 立即停止朗读');
}

function startControl(config) {
  return new Promise((resolve) => {
    let index = 0;
    const attempt = () => {
      if (index >= CONTROL_PORTS.length) {
        log('控制端口全部被占用：切换窗口立即停止朗读暂不可用');
        resolve(null);
        return;
      }
      const port = CONTROL_PORTS[index];
      index += 1;
      const server = http.createServer((req, res) => {
        const cors = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '600',
        };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
        const route = String(req.url || '/').split('?')[0];
        try {
          if (route === '/stop') markBlur(config);
          else if (route === '/session') markSessionSwitch(config);
          else if (route === '/focus') markFocus();
        } catch (e) {
          log(`控制端处理异常：${e && e.message}`);
        }
        res.writeHead(204, cors);
        res.end();
      });
      server.once('error', () => {
        try { server.close(); } catch { /* 忽略 */ }
        attempt();
      });
      server.listen(port, '127.0.0.1', () => {
        controlServer = server;
        controlPort = port;
        log(`控制端已监听 127.0.0.1:${port}（切换窗口/会话立即停止朗读）`);
        resolve(server);
      });
    };
    attempt();
  });
}

// ---------------------------------------------------------------- 插件入口

export function apply(ctx, config) {
  const cfg = settings(config);
  sink = (text) => {
    try {
      if (typeof ctx.logger === 'object' && ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(text);
    } catch { /* 忽略 */ }
  };

  log(`插件已加载（enabled=${cfg.enabled}，引擎=${cfg.engine}，音色=${cfg.voice}，单次上限=${cfg.maxChars} 字，切换窗口停止=${cfg.stopOnWindowChange}，切换会话停止=${cfg.stopOnSessionSwitch}）`);

  let timer = null;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    try {
      if (settings(config).enabled) {
        for (const event of scan(config)) handleTurn(event, config);
      }
    } catch (e) {
      log(`扫描异常（已忽略，继续跑）：${e && e.message}`);
    }
    timer = setTimeout(tick, POLL_MS);
  };

  ctx.effect(() => {
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stopCurrent('插件卸载');
      if (controlServer) {
        try { controlServer.close(); } catch { /* 忽略 */ }
        controlServer = null;
      }
    };
  }, 'speak-plugin: turn watcher');

  startControl(config).catch(() => { /* 端口不可用时静默降级 */ });
}

/** Cordis 也接受 `{ apply, Config, inject }` 形式的默认导出。 */
export default { name, inject, Config, apply };
