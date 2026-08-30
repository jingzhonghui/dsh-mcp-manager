// ============================================================================
// dsh-mcp-manager — Client half
// ----------------------------------------------------------------------------
// Registers the "MCP 服务器" panel into the settings sidebar (settings.section).
// Talks to the host half via package-private JSON RPC (host.call('mcp.*', ...)).
// Load: this file's export is the plugin object. In DSH use cordis_define with
// code.client set to this object literal (without `module.exports =`).
// ============================================================================

module.exports = {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;
    const h = React.createElement;
    const STATUS_TEXT = { connected: '已连接', connecting: '连接中', disconnected: '未连接', error: '错误' };
    const STATUS_COLOR = {
      connected: 'var(--dsw-alias-state-success-primary, #22c55e)',
      connecting: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
      disconnected: 'var(--dsw-alias-label-secondary, #9ca3af)',
      error: 'var(--dsw-alias-state-error-primary, #ef4444)',
    };
    const EMPTY_FORM = { name: '', command: '', args: '', env: '', cwd: '', timeout: '60000' };

    function McpManagerPanel() {
      const [view, setView] = React.useState({ servers: [], loading: true, error: null });
      const [formOpen, setFormOpen] = React.useState(false);
      const [busy, setBusy] = React.useState({});
      const [form, setForm] = React.useState(EMPTY_FORM);

      const refresh = () => host.call('mcp.list').then((res) => {
        setView((v) => ({ ...v, loading: false, servers: (res && res.servers) || [] }));
      }).catch((err) => {
        setView((v) => ({ ...v, loading: false, error: String((err && err.message) || err) }));
      });

      React.useEffect(() => {
        refresh();
        const disposer = ctx.interval(() => refresh(), 2500);
        return disposer;
      }, []);

      const setError = (err) => setView((v) => ({ ...v, loading: false, error: String((err && err.message) || err) }));

      const act = (method, args, id) => {
        setBusy((b) => ({ ...b, [id]: true }));
        host.call(method, args).then(() => {
          setView((v) => ({ ...v, error: null }));
          return refresh();
        }).catch(setError).finally(() => setBusy((b) => ({ ...b, [id]: false })));
      };

      const setField = (key) => (ev) => setForm((f) => ({ ...f, [key]: ev.target.value }));

      const submit = () => {
        const args = form.args.split(/\s+/).filter(Boolean);
        const env = {};
        for (const line of form.env.split('\n')) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
          if (m) env[m[1]] = m[2];
        }
        const t = parseInt(form.timeout, 10);
        host.call('mcp.add', {
          name: form.name.trim(),
          command: form.command.trim(),
          args,
          env,
          cwd: form.cwd.trim(),
          toolCallTimeoutMs: Number.isFinite(t) && t > 0 ? t : 60000,
        }).then((res) => {
          setFormOpen(false);
          setForm(EMPTY_FORM);
          setView({ servers: (res && res.servers) || [], loading: false, error: null });
        }).catch(setError);
      };

      const connected = view.servers.filter((s) => s.status === 'connected').length;

      const rows = view.servers.map((s) =>
        h('div', { className: 'mcp-row', key: s.id },
          h('span', { className: 'mcp-dot', style: { background: STATUS_COLOR[s.status] || STATUS_COLOR.disconnected } }),
          h('div', { className: 'mcp-main' },
            h('div', { className: 'mcp-name' },
              h('span', null, s.name),
              h('span', { className: 'mcp-badge' }, 'stdio'),
              h('span', { className: 'mcp-status' }, STATUS_TEXT[s.status] || s.status),
            ),
            h('div', { className: 'mcp-meta' }, s.commandLine || (s.command || '')),
            h('div', { className: 'mcp-meta' }, '工具: ' + s.toolCount + (s.skippedTools ? '（跳过 ' + s.skippedTools + '）' : '')),
            s.error ? h('div', { className: 'mcp-err' }, String(s.error)) : null,
          ),
          h('div', { className: 'mcp-actions' },
            s.status === 'connected'
              ? h('button', { className: 'mcp-btn', disabled: !!busy[s.id], onClick: () => act('mcp.disconnect', { id: s.id }, s.id) }, '断开')
              : h('button', { className: 'mcp-btn mcp-btn-primary', disabled: !!busy[s.id], onClick: () => act('mcp.connect', { id: s.id }, s.id) }, '连接'),
            h('button', { className: 'mcp-btn', disabled: !!busy[s.id], onClick: () => act('mcp.remove', { id: s.id }, s.id) }, '删除'),
          ),
        )
      );

      return h('div', { className: 'mcp-manager' },
        h('div', { className: 'mcp-header' },
          h('div', { className: 'mcp-title' }, 'MCP 服务器管理'),
          h('div', { className: 'mcp-sub' }, connected + '/' + view.servers.length + ' 已连接'),
          h('div', { className: 'mcp-header-actions' },
            h('button', { className: 'mcp-btn mcp-btn-primary', onClick: () => setFormOpen((v) => !v) }, formOpen ? '收起表单' : '添加服务器'),
            h('button', { className: 'mcp-btn', disabled: view.servers.length === 0, onClick: () => act('mcp.removeAll', {}, 'all') }, '清空'),
          ),
        ),
        view.error ? h('div', { className: 'mcp-banner' }, String(view.error)) : null,
        view.loading ? h('div', { className: 'mcp-empty' }, '加载中…') : rows,
        !formOpen && !view.loading && view.servers.length === 0 ? h('div', { className: 'mcp-empty' }, '尚未配置 MCP 服务器，点击“添加服务器”开始') : null,
        formOpen ? h('div', { className: 'mcp-form' },
          h('div', { className: 'mcp-field' }, h('label', null, '名称 *'), h('input', { value: form.name, onChange: setField('name'), placeholder: 'serverName（字母/数字/-/_，≤32）' })),
          h('div', { className: 'mcp-field' }, h('label', null, '命令 *'), h('input', { value: form.command, onChange: setField('command'), placeholder: '绝对路径或 PATH 命令，如 npx / uvx / node / python' })),
          h('div', { className: 'mcp-field' }, h('label', null, '参数'), h('input', { value: form.args, onChange: setField('args'), placeholder: '空格分隔，如 -y @modelcontextprotocol/server-everything' })),
          h('div', { className: 'mcp-field' }, h('label', null, '环境变量'), h('textarea', { value: form.env, onChange: setField('env'), rows: 2, placeholder: '每行 KEY=VALUE' })),
          h('div', { className: 'mcp-field' }, h('label', null, '工作目录'), h('input', { value: form.cwd, onChange: setField('cwd'), placeholder: '可选，默认继承' })),
          h('div', { className: 'mcp-field' }, h('label', null, '调用超时(ms)'), h('input', { value: form.timeout, onChange: setField('timeout'), placeholder: '60000' })),
          h('div', { className: 'mcp-form-actions' },
            h('button', { className: 'mcp-btn mcp-btn-primary', onClick: submit }, '添加'),
            h('button', { className: 'mcp-btn', onClick: () => setFormOpen(false) }, '取消'),
          ),
        ) : null,
      );
    }

    styles.insert(
      '.mcp-manager{display:flex;flex-direction:column;gap:10px;max-width:760px;font-size:13px;color:var(--dsw-alias-label-primary,#111)}' +
      '.mcp-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
      '.mcp-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}' +
      '.mcp-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#666)}' +
      '.mcp-header-actions{margin-left:auto;display:flex;gap:6px}' +
      '.mcp-btn{background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit}' +
      '.mcp-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2,#d1d5db)}' +
      '.mcp-btn:disabled{opacity:.55;cursor:default}' +
      '.mcp-btn-primary{background:var(--dsw-alias-brand-primary,#4f46e5);border-color:transparent;color:#fff}' +
      '.mcp-banner{background:var(--dsw-alias-state-error-primary,#ef4444);color:#fff;border-radius:6px;padding:6px 10px;font-size:12px;white-space:pre-wrap;word-break:break-all}' +
      '.mcp-empty{color:var(--dsw-alias-label-secondary,#666);font-size:13px;padding:16px 4px}' +
      '.mcp-row{display:flex;align-items:flex-start;gap:8px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;padding:8px 10px}' +
      '.mcp-dot{width:8px;height:8px;border-radius:50%;margin-top:6px;flex:none}' +
      '.mcp-main{flex:1;min-width:0}' +
      '.mcp-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#111);display:flex;align-items:center;gap:6px;flex-wrap:wrap}' +
      '.mcp-badge{font-size:10px;color:var(--dsw-alias-label-secondary,#666);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:4px;padding:0 4px;font-weight:400}' +
      '.mcp-status{font-size:11px;color:var(--dsw-alias-label-secondary,#666);font-weight:400}' +
      '.mcp-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#666);margin-top:2px;word-break:break-all}' +
      '.mcp-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#ef4444);margin-top:4px;white-space:pre-wrap;word-break:break-all}' +
      '.mcp-actions{display:flex;gap:6px;flex:none}' +
      '.mcp-form{background:var(--dsw-alias-bg-layer-1,#fff);border:1px dashed var(--dsw-alias-border-l2,#d1d5db);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px}' +
      '.mcp-field{display:flex;flex-direction:column;gap:3px}' +
      '.mcp-field label{font-size:11px;color:var(--dsw-alias-label-secondary,#666)}' +
      '.mcp-field input,.mcp-field textarea{background:var(--dsw-alias-bg-base,#fafafa);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:6px;padding:5px 8px;font-size:12px;font-family:inherit}' +
      '.mcp-field textarea{resize:vertical}' +
      '.mcp-form-actions{display:flex;gap:6px;justify-content:flex-end}'
    );

    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'mcp-manager', order: 30, label: 'MCP 服务器' },
      () => React.createElement(McpManagerPanel),
    ));
  },
};
