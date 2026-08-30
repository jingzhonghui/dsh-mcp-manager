// ============================================================================
// mcp-manager — client half (hand-written browser bundle)
// ----------------------------------------------------------------------------
// Format: window.__ModuleLoader__.load({ id, factory }) — the same contract
// tsdown emits for every DSH client plugin. Dependencies arrive via require()
// from the module table (react is a seed word), so no build step is needed.
// This half registers the "MCP 服务器" section in the settings sidebar and
// talks to the host half over the /mcp-manager RPC channel via
// ctx.connection.rpc.call (the connection service provided by
// @deepseek-ai/dsh-client-connection).
// ============================================================================

window.__ModuleLoader__.load({
  id: "mcp-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");

    // Inject panel styles once (module-load time; document.head exists by then).
    var STYLE_ID = "mcp-manager-style";
    function injectStyles() {
      try {
        if (!document.getElementById(STYLE_ID)) {
          var style = document.createElement("style");
          style.id = STYLE_ID;
          style.textContent = [
            ".mcp-manager{display:flex;flex-direction:column;gap:12px;padding:4px 0}",
            ".mcp-header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}",
            ".mcp-title{font-size:15px;font-weight:600}",
            ".mcp-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af)}",
            ".mcp-header-actions{margin-left:auto;display:flex;gap:8px}",
            ".mcp-banner{padding:8px 10px;border-radius:6px;background:var(--dsw-alias-state-error-surface,#fef2f2);color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;white-space:pre-wrap}",
            ".mcp-empty{padding:16px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,#9ca3af)}",
            ".mcp-row{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-divider,#e5e7eb);border-radius:8px;background:var(--dsw-alias-surface-secondary,#fafafa)}",
            ".mcp-dot{width:8px;height:8px;border-radius:50%;margin-top:6px;flex-shrink:0}",
            ".mcp-main{flex:1;min-width:0}",
            ".mcp-name{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
            ".mcp-name>span:first-child{font-weight:600;font-size:14px}",
            ".mcp-badge{padding:1px 6px;border-radius:4px;font-size:11px;background:var(--dsw-alias-surface-primary,#eef2ff);color:var(--dsw-alias-accent-primary,#4f46e5)}",
            ".mcp-status{font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af)}",
            ".mcp-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
            ".mcp-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#ef4444);margin-top:4px;white-space:pre-wrap}",
            ".mcp-actions{display:flex;gap:6px;flex-shrink:0}",
            ".mcp-btn{padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-divider,#e5e7eb);background:var(--dsw-alias-surface-primary,#fff);color:var(--dsw-alias-label-primary,#111827);font-size:12px;cursor:pointer}",
            ".mcp-btn:disabled{opacity:.5;cursor:not-allowed}",
            ".mcp-btn-primary{background:var(--dsw-alias-accent-primary,#4f46e5);border-color:var(--dsw-alias-accent-primary,#4f46e5);color:#fff}",
            ".mcp-form{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px dashed var(--dsw-alias-divider,#e5e7eb);border-radius:8px}",
            ".mcp-field{display:flex;flex-direction:column;gap:4px}",
            ".mcp-field label{font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af)}",
            ".mcp-field input,.mcp-field textarea{padding:6px 8px;border:1px solid var(--dsw-alias-divider,#e5e7eb);border-radius:6px;background:var(--dsw-alias-surface-primary,#fff);color:var(--dsw-alias-label-primary,#111827);font-size:13px;font-family:inherit}",
            ".mcp-form-actions{display:flex;gap:8px}",
          ].join("\n");
          document.head.appendChild(style);
        }
      } catch (err) {
        console.error("[mcp-manager] style injection failed", err);
      }
    }
    injectStyles();

    var STATUS_TEXT = { connected: "已连接", connecting: "连接中", disconnected: "未连接", error: "错误" };
    // Module-level ctx captured at apply time; components cannot see apply's parameter.
    var rootCtx = null;
    var STATUS_COLOR = {
      connected: "var(--dsw-alias-state-success-primary, #22c55e)",
      connecting: "var(--dsw-alias-state-warn-primary, #f59e0b)",
      disconnected: "var(--dsw-alias-label-secondary, #9ca3af)",
      error: "var(--dsw-alias-state-error-primary, #ef4444)",
    };
    var EMPTY_FORM = { name: "", command: "", args: "", env: "", cwd: "", timeout: "60000" };

    function McpManagerPanel(props) {
      var state = react.useState({ servers: [], loading: true, error: null });
      var view = state[0];
      var setView = state[1];
      var state2 = react.useState(false);
      var formOpen = state2[0];
      var setFormOpen = state2[1];
      var state3 = react.useState({});
      var busy = state3[0];
      var setBusy = state3[1];
      var state4 = react.useState(EMPTY_FORM);
      var form = state4[0];
      var setForm = state4[1];

      // Call host RPC and unwrap the RpcResult envelope {ok:true,value} | {ok:false,error}.
      function call(endpoint, payload) {
        var conn = rootCtx && rootCtx.get("connection");
        if (!conn || !conn.rpc || !conn.rpc.call) return Promise.reject(new Error("connection rpc unavailable"));
        return conn.rpc.call("/mcp-manager", endpoint, payload).then(function (res) {
          if (res && res.ok === true) return res.value;
          var msg = (res && res.error && res.error.message) || "RPC failed";
          throw new Error(msg);
        });
      }

      var refresh = react.useCallback(function () {
        call("list", {}).then(function (value) {
          setView(function (v) { return { ...v, loading: false, servers: (value && value.servers) || [] }; });
        }).catch(function (err) {
          setView(function (v) { return { ...v, loading: false, error: String((err && err.message) || err) }; });
        });
      }, []);

      react.useEffect(function () {
        refresh();
        var timer = setInterval(refresh, 2500);
        return function () { clearInterval(timer); };
      }, []);

      var setError = function (err) { setView(function (v) { return { ...v, loading: false, error: String((err && err.message) || err) }; }); };

      var act = function (method, args, id) {
        setBusy(function (b) { return { ...b, [id]: true }; });
        call(method, args).then(function () {
          setView(function (v) { return { ...v, error: null }; });
          return refresh();
        }).catch(setError).finally(function () { setBusy(function (b) { return { ...b, [id]: false }; }); });
      };

      var setField = function (key) { return function (ev) { setForm(function (f) { return { ...f, [key]: ev.target.value }; }); }; };

      var submit = function () {
        var args = form.args.split(/\s+/).filter(Boolean);
        var env = {};
        var lines = form.env.split("\n");
        for (var i = 0; i < lines.length; i++) {
          var m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(lines[i].trim());
          if (m) env[m[1]] = m[2];
        }
        var t = parseInt(form.timeout, 10);
        call("add", {
          name: form.name.trim(),
          command: form.command.trim(),
          args: args,
          env: env,
          cwd: form.cwd.trim(),
          toolCallTimeoutMs: Number.isFinite(t) && t > 0 ? t : 60000,
        }).then(function (value) {
          setFormOpen(false);
          setForm(EMPTY_FORM);
          setView({ servers: (value && value.servers) || [], loading: false, error: null });
        }).catch(setError);
      };

      var connected = 0;
      for (var i = 0; i < view.servers.length; i++) if (view.servers[i].status === "connected") connected += 1;

      var rows = view.servers.map(function (s) {
        return react.createElement("div", { className: "mcp-row", key: s.id },
          react.createElement("span", { className: "mcp-dot", style: { background: STATUS_COLOR[s.status] || STATUS_COLOR.disconnected } }),
          react.createElement("div", { className: "mcp-main" },
            react.createElement("div", { className: "mcp-name" },
              react.createElement("span", null, s.name),
              react.createElement("span", { className: "mcp-badge" }, "stdio"),
              react.createElement("span", { className: "mcp-status" }, STATUS_TEXT[s.status] || s.status)
            ),
            react.createElement("div", { className: "mcp-meta" }, s.commandLine || (s.command || "")),
            react.createElement("div", { className: "mcp-meta" }, "工具: " + s.toolCount + (s.skippedTools ? "（跳过 " + s.skippedTools + "）" : "")),
            s.error ? react.createElement("div", { className: "mcp-err" }, String(s.error)) : null
          ),
          react.createElement("div", { className: "mcp-actions" },
            s.status === "connected"
              ? react.createElement("button", { className: "mcp-btn", disabled: !!busy[s.id], onClick: function () { act("disconnect", { id: s.id }, s.id); } }, "断开")
              : react.createElement("button", { className: "mcp-btn mcp-btn-primary", disabled: !!busy[s.id], onClick: function () { act("connect", { id: s.id }, s.id); } }, "连接"),
            react.createElement("button", { className: "mcp-btn", disabled: !!busy[s.id], onClick: function () { act("remove", { id: s.id }, s.id); } }, "删除")
          )
        );
      });

      return react.createElement("div", { className: "mcp-manager" },
        react.createElement("div", { className: "mcp-header" },
          react.createElement("div", { className: "mcp-title" }, "MCP 服务器管理"),
          react.createElement("div", { className: "mcp-sub" }, connected + "/" + view.servers.length + " 已连接"),
          react.createElement("div", { className: "mcp-header-actions" },
            react.createElement("button", { className: "mcp-btn mcp-btn-primary", onClick: function () { setFormOpen(function (v) { return !v; }); } }, formOpen ? "收起表单" : "添加服务器"),
            react.createElement("button", { className: "mcp-btn", disabled: view.servers.length === 0, onClick: function () { act("removeAll", {}, "all"); } }, "清空")
          )
        ),
        view.error ? react.createElement("div", { className: "mcp-banner" }, String(view.error)) : null,
        view.loading ? react.createElement("div", { className: "mcp-empty" }, "加载中…") : rows,
        !formOpen && !view.loading && view.servers.length === 0 ? react.createElement("div", { className: "mcp-empty" }, "尚未配置 MCP 服务器，点击“添加服务器”开始") : null,
        formOpen ? react.createElement("div", { className: "mcp-form" },
          react.createElement("div", { className: "mcp-field" }, react.createElement("label", null, "名称 *"), react.createElement("input", { value: form.name, onChange: setField("name"), placeholder: "serverName（字母/数字/-/_，≤32）" })),
          react.createElement("div", { className: "mcp-field" }, react.createElement("label", null, "命令 *"), react.createElement("input", { value: form.command, onChange: setField("command"), placeholder: "绝对路径或 PATH 命令，如 npx / uvx / node / python" })),
          react.createElement("div", { className: "mcp-field" }, react.createElement("label", null, "参数"), react.createElement("input", { value: form.args, onChange: setField("args"), placeholder: "空格分隔，如 -y @modelcontextprotocol/server-everything" })),
          react.createElement("div", { className: "mcp-field" }, react.createElement("label", null, "环境变量"), react.createElement("textarea", { value: form.env, onChange: setField("env"), rows: 2, placeholder: "每行 KEY=VALUE" })),
          react.createElement("div", { className: "mcp-field" }, react.createElement("label", null, "工作目录"), react.createElement("input", { value: form.cwd, onChange: setField("cwd"), placeholder: "可选，默认继承" })),
          react.createElement("div", { className: "mcp-field" }, react.createElement("label", null, "调用超时(ms)"), react.createElement("input", { value: form.timeout, onChange: setField("timeout"), placeholder: "60000" })),
          react.createElement("div", { className: "mcp-form-actions" },
            react.createElement("button", { className: "mcp-btn mcp-btn-primary", onClick: submit }, "添加"),
            react.createElement("button", { className: "mcp-btn", onClick: function () { setFormOpen(false); } }, "取消")
          )
        ) : null
      );
    }

    // Cordis service injection (client side): slots = settings sections,
    // connection = RPC transport to the host half.
    var inject = ["slots", "connection"];
    function apply(ctx) {
      rootCtx = ctx;
      var slots = ctx.get("slots");
      if (slots === undefined) return;
      slots.inject("settings.section", function () {
        return slots.register(
          { name: "settings.section", id: "mcp-manager", order: 30, label: "MCP 服务器" },
          function () { return react.createElement(McpManagerPanel); }
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
