/**
 * DSH 回答语音朗读 —— 浏览器（Client）半侧插件
 * ============================================================================
 * 在「设置 → 通用」里加一张「语音朗读」卡片：总开关、朗读哪些内容、
 * 引擎/音色/语速/音量/字数上限，改完立即写回 Host 配置（无需重启）。
 *
 * 与官方设置页同构：注册进 ui-settings-general 的 `settings.general.item` slot，
 * 配置读写走 `ctx.configForms.get("<条目 id>")`（命名空间 = profile 条目 id）。
 */
__ModuleLoader__.load({
  id: 'dsh-plugin-speak',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const jsxRuntime = require('react/jsx-runtime');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;

    const NS = 'settings.speak';
    const ENTRY_ID = 'speak';

    const zh = {
      title: '语音朗读',
      description: '回答完成时用语音念出来。可分别控制朗读哪些内容、音色与语速。',
      master: '总开关',
      masterHint: '关闭后仍会记录轮次但不发出声音',
      stopOnWindowChange: '切换窗口立即停止',
      stopOnWindowChangeHint: '离开 DSH 窗口时马上停止朗读；切走期间结束的回复不再念，回到窗口后恢复',
      stopOnSessionSwitch: '切换会话立即停止',
      stopOnSessionSwitchHint: '从一个会话切到另一个会话时，正在念的回复马上停止；新会话的回复照常朗读',
      content: '朗读哪些内容',
      readFinal: '最终回复',
      readFinalHint: '每轮结束时朗读模型的答复（推荐）',
      readSteps: '过程说明',
      readStepsHint: '长任务中每一步的说明文字，会念很多',
      readReasoning: '思考过程',
      readReasoningHint: '模型内部的推理文字（reasoning）',
      readToolCalls: '工具调用摘要',
      readToolCallsHint: '每次调用工具时念出工具名与关键参数',
      code: '代码处理',
      skipCode: '跳过代码块',
      skipCodeHint: '代码朗读没有意义，默认跳过',
      maxChars: '单次最多字数',
      maxCharsHint: '超出后按句号截断，并提示"后面还有"',
      engine: '语音引擎',
      engineHint: 'auto 优先在线自然音，失败退回本机语音',
      voice: 'Edge 音色',
      voiceHint: '如 zh-CN-XiaoxiaoNeural（女）/ zh-CN-YunxiNeural（男）',
      rate: '语速',
      rateHint: '-50 很慢，0 正常，+50 很快',
      volume: '音量',
      volumeHint: '0–100',
      unavailable: 'Host 未提供这项设置，可能是插件未加载。',
      readOnly: '本次部署的设置是只读的。',
      failed: '写入失败，请重试。',
      saved: '已生效',
    };

    const en = {
      title: 'Read replies aloud',
      description: 'Speak each reply when a turn finishes. Pick what gets read, the voice and the speed.',
      master: 'Enabled',
      masterHint: 'Recording continues silently when off',
      stopOnWindowChange: 'Stop when switching windows',
      stopOnWindowChangeHint: 'Silence the moment you leave the DSH window; replies finished while away stay unread',
      stopOnSessionSwitch: 'Stop when switching sessions',
      stopOnSessionSwitchHint: 'Silence the reply when you switch to another session; new replies are still read',
      content: 'What to read',
      readFinal: 'Final reply',
      readFinalHint: 'Read the reply at the end of each turn (recommended)',
      readSteps: 'Step notes',
      readStepsHint: 'Narration during long tasks — can be verbose',
      readReasoning: 'Reasoning',
      readReasoningHint: 'The model internal reasoning blocks',
      readToolCalls: 'Tool calls',
      readToolCallsHint: 'Announce each tool name and its key arguments',
      code: 'Code',
      skipCode: 'Skip code blocks',
      skipCodeHint: 'Code is not worth reading out loud',
      maxChars: 'Max characters',
      maxCharsHint: 'Longer replies are cut at a sentence boundary',
      engine: 'Engine',
      engineHint: 'auto prefers the natural online voice, then falls back to SAPI',
      voice: 'Edge voice',
      voiceHint: 'e.g. zh-CN-XiaoxiaoNeural / zh-CN-YunxiNeural',
      rate: 'Rate',
      rateHint: '-50 slow, 0 normal, +50 fast',
      volume: 'Volume',
      volumeHint: '0–100',
      unavailable: 'The host does not expose these settings; the plugin may be unloaded.',
      readOnly: 'Settings are read-only in this deployment.',
      failed: 'Could not save; try again.',
      saved: 'Applied',
    };

    const CSS = [
      '.dsh-speak{display:flex;flex-direction:column;gap:14px}',
      '.dsh-speak-head{display:flex;align-items:flex-start;gap:12px}',
      '.dsh-speak-head>div:first-child{flex:1;min-width:0}',
      '.dsh-speak-title{font-size:14px;font-weight:600;line-height:20px}',
      '.dsh-speak-desc{font-size:12px;line-height:18px;opacity:.66;margin-top:2px}',
      '.dsh-speak-row{display:flex;align-items:center;gap:12px;justify-content:space-between}',
      '.dsh-speak-label{font-size:13px;line-height:18px}',
      '.dsh-speak-hint{font-size:11px;line-height:16px;opacity:.55;margin-top:1px}',
      '.dsh-speak-controls{display:flex;flex-direction:column;gap:10px}',
      '.dsh-speak-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}',
      '.dsh-speak input,.dsh-speak select{box-sizing:border-box;width:100%;height:28px;padding:0 8px;font:inherit;font-size:12px;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-neutral, rgba(127,127,127,.35));border-radius:6px;outline:none}',
      '.dsh-speak input:focus,.dsh-speak select:focus{border-color:var(--dsw-alias-brand-primary, #4d6bfe)}',
      '.dsh-speak input[type=number]{width:88px}',
      '.dsh-speak-error{font-size:12px;color:var(--dsw-alias-state-error-primary, #d92d20)}',
      '.dsh-speak-divider{height:1px;background:var(--dsw-alias-border-neutral, rgba(127,127,127,.2))}',
    ].join('');

    function injectCss() {
      if (typeof document === 'undefined') return;
      const id = 'dsh-plugin-speak/card.css';
      if (document.querySelector('style[data-plugin-css="' + id + '"]')) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-plugin-speak';
      tag.dataset.pluginCss = id;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function useSnapshot(controller) {
      const subscribe = react.useCallback((listener) => controller.subscribe(listener), [controller]);
      const snapshot = react.useCallback(() => controller.getSnapshot(), [controller]);
      return react.useSyncExternalStore(subscribe, snapshot, snapshot);
    }

    /** 一行：左侧标题+说明，右侧开关。 */
    function ToggleRow(props) {
      return jsxs('div', {
        className: 'dsh-speak-row',
        children: [
          jsxs('div', {
            children: [
              jsx('div', { className: 'dsh-speak-label', children: props.label }),
              props.hint ? jsx('div', { className: 'dsh-speak-hint', children: props.hint }) : null,
            ],
          }),
          jsx(primitives.Switch, {
            checked: Boolean(props.checked),
            disabled: Boolean(props.disabled),
            label: props.label,
            onChange: props.onChange,
          }),
        ],
      });
    }

    /** 带本地暂存的文本框：失焦或回车才提交，避免边打字边写配置。 */
    function TextField(props) {
      const [draft, setDraft] = react.useState(String(props.value ?? ''));
      react.useEffect(() => { setDraft(String(props.value ?? '')); }, [props.value]);
      const commit = () => {
        const next = draft.trim();
        if (next === String(props.value ?? '')) return;
        if (props.numeric) {
          const parsed = Number(next);
          if (!Number.isFinite(parsed)) { setDraft(String(props.value ?? '')); return; }
          props.onCommit(parsed);
        } else props.onCommit(next);
      };
      return jsxs('div', {
        children: [
          jsx('div', { className: 'dsh-speak-label', children: props.label }),
          props.hint ? jsx('div', { className: 'dsh-speak-hint', children: props.hint }) : null,
          jsx('input', {
            type: props.numeric ? 'number' : 'text',
            value: draft,
            min: props.min,
            max: props.max,
            step: props.step,
            disabled: Boolean(props.disabled),
            onChange: (event) => setDraft(event.target.value),
            onBlur: commit,
            onKeyDown: (event) => { if (event.key === 'Enter') commit(); },
            style: { marginTop: 6 },
          }),
        ],
      });
    }

    function SelectField(props) {
      return jsxs('div', {
        children: [
          jsx('div', { className: 'dsh-speak-label', children: props.label }),
          props.hint ? jsx('div', { className: 'dsh-speak-hint', children: props.hint }) : null,
          jsx('select', {
            value: String(props.value ?? ''),
            disabled: Boolean(props.disabled),
            onChange: (event) => props.onCommit(event.target.value),
            style: { marginTop: 6 },
            children: (props.options || []).map((option) => jsx('option', { value: option.value, children: option.label }, option.value)),
          }),
        ],
      });
    }

    function SpeakCard(props) {
      const t = props.t;
      const controller = props.controller;
      if (!controller) return jsx('div', { className: 'dsh-speak-error', children: t('unavailable') });

      const snapshot = useSnapshot(controller);
      const values = (snapshot && snapshot.value) || {};
      const writable = snapshot && snapshot.writable !== false && snapshot.status !== 'loading';
      const [failed, setFailed] = react.useState(false);

      const set = (field, next) => {
        setFailed(false);
        Promise.resolve(controller.set(field, next)).then((ok) => { if (ok === false) setFailed(true); })
          .catch(() => setFailed(true));
      };

      const toggle = (field) => (next) => set(field, Boolean(next));

      return jsxs('div', {
        className: 'dsh-speak',
        children: [
          jsxs('div', {
            className: 'dsh-speak-head',
            children: [
              jsxs('div', {
                children: [
                  jsx('div', { className: 'dsh-speak-title', children: t('title') }),
                  jsx('div', { className: 'dsh-speak-desc', children: t('description') }),
                  snapshot && snapshot.writable === false
                    ? jsx('div', { className: 'dsh-speak-hint', children: t('readOnly') })
                    : null,
                  failed ? jsx('div', { className: 'dsh-speak-error', children: t('failed') }) : null,
                ],
              }),
              jsx(primitives.Switch, {
                checked: values.enabled !== false,
                disabled: !writable,
                label: t('master'),
                onChange: toggle('enabled'),
              }),
            ],
          }),
          jsx('div', { className: 'dsh-speak-divider' }),
          jsx('div', { className: 'dsh-speak-label', children: t('content') }),
          jsxs('div', {
            className: 'dsh-speak-controls',
            children: [
              jsx(ToggleRow, {
                label: t('readFinal'), hint: t('readFinalHint'),
                checked: values.readFinal !== false, disabled: !writable, onChange: toggle('readFinal'),
              }),
              jsx(ToggleRow, {
                label: t('readSteps'), hint: t('readStepsHint'),
                checked: Boolean(values.readSteps), disabled: !writable, onChange: toggle('readSteps'),
              }),
              jsx(ToggleRow, {
                label: t('readReasoning'), hint: t('readReasoningHint'),
                checked: Boolean(values.readReasoning), disabled: !writable, onChange: toggle('readReasoning'),
              }),
              jsx(ToggleRow, {
                label: t('readToolCalls'), hint: t('readToolCallsHint'),
                checked: Boolean(values.readToolCalls), disabled: !writable, onChange: toggle('readToolCalls'),
              }),
              jsx(ToggleRow, {
                label: t('skipCode'), hint: t('skipCodeHint'),
                checked: values.skipCode !== false, disabled: !writable, onChange: toggle('skipCode'),
              }),
              jsx(ToggleRow, {
                label: t('stopOnWindowChange'), hint: t('stopOnWindowChangeHint'),
                checked: values.stopOnWindowChange !== false, disabled: !writable, onChange: toggle('stopOnWindowChange'),
              }),
              jsx(ToggleRow, {
                label: t('stopOnSessionSwitch'), hint: t('stopOnSessionSwitchHint'),
                checked: values.stopOnSessionSwitch !== false, disabled: !writable, onChange: toggle('stopOnSessionSwitch'),
              }),
            ],
          }),
          jsx('div', { className: 'dsh-speak-divider' }),
          jsxs('div', {
            className: 'dsh-speak-grid',
            children: [
              jsx(SelectField, {
                label: t('engine'), hint: t('engineHint'),
                value: values.engine || 'auto',
                disabled: !writable,
                options: [
                  { value: 'auto', label: 'auto（自动）' },
                  { value: 'edge', label: 'edge（Edge 自然音）' },
                  { value: 'sapi', label: 'sapi（Windows 本机音）' },
                ],
                onCommit: (next) => set('engine', next),
              }),
              jsx(TextField, {
                label: t('voice'), hint: t('voiceHint'),
                value: values.voice ?? 'zh-CN-XiaoxiaoNeural',
                disabled: !writable,
                onCommit: (next) => set('voice', next),
              }),
              jsx(TextField, {
                label: t('rate'), hint: t('rateHint'), numeric: true,
                min: -50, max: 50, step: 5,
                value: values.rate ?? 0,
                disabled: !writable,
                onCommit: (next) => set('rate', next),
              }),
              jsx(TextField, {
                label: t('volume'), hint: t('volumeHint'), numeric: true,
                min: 0, max: 100, step: 5,
                value: values.volume ?? 100,
                disabled: !writable,
                onCommit: (next) => set('volume', next),
              }),
              jsx(TextField, {
                label: t('maxChars'), hint: t('maxCharsHint'), numeric: true,
                min: 100, max: 8000, step: 100,
                value: values.maxChars ?? 800,
                disabled: !writable,
                onCommit: (next) => set('maxChars', next),
              }),
            ],
          }),
        ],
      });
    }

    const inject = ['slots', 'locale', 'configForms'];

    /** 浏览器半侧上报窗口焦点变化用的本地控制端（与 lib/index.js 的 CONTROL_PORTS 一致）。 */
    const CONTROL_PORTS = [47653, 47654, 47655, 47656, 47657];

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-speak: dictionaries');
      injectCss();

      const controller = ctx.configForms.get(ENTRY_ID);

      /** 窗口切走/回来、切换会话时通知宿主：/stop 立即停止朗读，/focus 解除静音，/session 只停当前这段。 */
      const notifyHost = (path) => {
        if (typeof window === 'undefined') return;
        let enabled = true;
        try {
          const snapshot = controller && controller.getSnapshot && controller.getSnapshot();
          const value = (snapshot && snapshot.value) || {};
          enabled = path === '/session'
            ? value.stopOnSessionSwitch !== false
            : value.stopOnWindowChange !== false;
        } catch { /* 配置读不到时按开启处理 */ }
        if (!enabled) return;
        for (const port of CONTROL_PORTS) {
          try {
            fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', mode: 'no-cors', keepalive: true }).catch(() => {});
          } catch { /* 宿主未起控制端时静默忽略 */ }
        }
      };

      ctx.effect(() => {
        if (typeof window === 'undefined') return;
        const onBlur = () => notifyHost('/stop');
        const onFocus = () => notifyHost('/focus');
        const onVisibility = () => notifyHost(document.hidden ? '/stop' : '/focus');
        window.addEventListener('blur', onBlur);
        window.addEventListener('focus', onFocus);
        window.addEventListener('pagehide', onBlur);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          window.removeEventListener('blur', onBlur);
          window.removeEventListener('focus', onFocus);
          window.removeEventListener('pagehide', onBlur);
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }, 'dsh-plugin-speak: window focus watcher');

      // 切换会话：uiSession.current（当前主视图会话 binding）变化时通知宿主停止朗读。
      // 用 ctx.inject 等 uiSession 就绪，不把它写进 inject 数组（避免服务缺失时整插件不加载）。
      ctx.inject(['uiSession'], (scope) => {
        scope.effect(() => {
          const source = scope.uiSession && scope.uiSession.current;
          if (!source || typeof source.getSnapshot !== 'function' || typeof source.subscribe !== 'function') return;
          const keyOf = () => {
            const binding = source.getSnapshot();
            return binding === null || binding === undefined ? undefined : binding.key;
          };
          let last = keyOf();
          const unsubscribe = source.subscribe(() => {
            const next = keyOf();
            if (next === last) return;
            last = next;
            notifyHost('/session');
          });
          return () => { try { unsubscribe(); } catch { /* 忽略 */ } };
        }, 'dsh-plugin-speak: session switch watcher');
      });

      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'speak',
        order: 90,
        locale: NS,
        inject: () => ({ controller }),
      }, SpeakCard));
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
