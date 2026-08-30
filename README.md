# dsh-mcp-manager

在 DSH（DeepSeek Harness）中**可视化地管理 MCP 服务器**的动态插件。

- 显示当前已配置/已连接的 MCP 服务器及其状态
- 新增 MCP 服务器连接（stdio 传输）
- 一键 连接 / 断开 / 删除 服务器
- 把服务器暴露的工具注册为 `mcp__<serverName>__<toolName>`，可直接供 Agent 调用
- 附带一个 Agent 可调用的管理工具 `mcp_manager`，与设置页共用同一注册表

## 界面

插件挂载在 **设置页 → 侧边栏 →「MCP 服务器」**（`settings.section`，order 30）。面板显示：

- 每个服务器的状态点（已连接 / 连接中 / 未连接 / 错误）
- 启动命令、工具数量、错误详情
- 「添加服务器」表单：名称、命令、参数、环境变量、工作目录、调用超时
- 「连接 / 断开 / 删除 / 清空」操作按钮，每 2.5s 自动刷新

## 安装

这是 DSH 的动态插件（Cordis Plugin）。在 DSH 会话中用 `cordis_define` 加载：

1. 把 `src/host.js` 的内容作为 `code.host`，`src/client.js` 的内容作为 `code.client` 提交。
   `plugin` 用 `{ "kind": "new", "idPrefix": "mcp" }`。
2. `cordis_run` 激活（首次运行需在 GUI 授权）。
3. 打开 **设置页 → MCP 服务器** 即可看到管理面板；Agent 侧同时获得 `mcp_manager` 工具。

> 当前为内存态注册表：插件停止后配置不持久化（可自行扩展为写入 profile 的 `cordis.patch.yml`）。

## 使用示例

添加并连接一个本地 MCP 服务器（如一个最小测试服务器 `examples/test-mcp-server.js`）：

```json
{
  "action": "add",
  "name": "test",
  "command": "node",
  "args": ["C:\\path\\to\\examples\\test-mcp-server.js"],
  "connect": true
}
```

连接成功后，服务器暴露的工具会出现在 Agent 工具列表，形如：
`mcp__test__echo`、`mcp__test__add`、`mcp__test__complex`、`mcp__test__fail`。

也可以直接在设置页表单里填写。所有工具调用都走 MCP `tools/call`，支持超时与中断。

## mcp_manager 工具

Agent 可用的管理工具，动作：`list` / `add` / `connect` / `disconnect` / `remove` / `removeAll`。

## 设计要点

- **stdio 传输**：JSON-RPC 2.0 换行分隔。握手流程 `initialize` → `notifications/initialized` → `tools/list`（支持分页）→ `tools/call`。
- **工具名规范化**：`mcp__<server>__<tool>`，非法字符转 `_`；超长时追加 12 位 FNV-1a 哈希。
- **schema 清洗**：MCP 服务器返回的 inputSchema 会先转换成 DSH 工具 DSL 允许的子集（支持 `oneOf`、`enum`、`const`，剔除 `format/pattern/min*` 等），无法转换的工具会被跳过并计数。
- **生命周期**：意外退出会捕获 stderr 尾部并标记错误；断开/删除/插件停止时终止子进程、注销全部工具、拒绝所有挂起请求。
- 传输层目前仅支持 **stdio**（`ctx.web.fetch` 仅 GET，streamable-http 暂不可行）。

## 示例服务器

`examples/test-mcp-server.js` 是一个最小可用的 Node stdio MCP 服务器（无依赖），用于快速验证本插件：

```bash
node examples/test-mcp-server.js
```

暴露 4 个工具：`echo`、`add`、`complex`（枚举 + 嵌套对象 + anyOf）、`fail`（isError 用例）。

## License

MIT
