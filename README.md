# dsh-mcp-manager

在 DSH（DeepSeek Harness）中**可视化地管理 MCP 服务器**的宿主机插件（双半：host 连接层 + 设置页面板）。

- 显示当前已配置/已连接的 MCP 服务器及其状态
- 新增 MCP 服务器连接（stdio 传输）
- 一键 连接 / 断开 / 删除 服务器
- 把服务器暴露的工具注册为 `mcp__<serverName>__<toolName>`，可直接供 Agent 调用
- **配置持久化**：服务器配置写入 `$DSH_HOME/mcp-manager.json`，重启 DSH 不丢失、自动重连
- **宿主机级**：以 `dsh.bundle` 形式经 `dsh plugin` 安装进 profile 的 `dsh.profile.bundles` 层（其 `cordis.patch.yml` 自动 insert 插件行），进程级存活，卸载 = `dsh plugin --profile web remove mcp-manager`

## 界面

插件挂载在 **设置页 → 侧边栏 →「MCP 服务器」**（`settings.section`，order 30）。面板显示：

- 每个服务器的状态点（已连接 / 连接中 / 未连接 / 错误）
- 启动命令、工具数量、错误详情
- 「添加服务器」表单：名称、命令、参数、环境变量、工作目录、调用超时
- 「连接 / 断开 / 删除 / 清空」操作按钮，每 2.5s 自动刷新

## 安装（宿主机插件版，推荐）

`host-plugin/` 是一个完整的 npm 包（`mcp-manager`），host 半在 `lib/index.js`、client 半在 `lib/client.js`（手写 `__ModuleLoader__` bundle，无构建步骤）。包声明了 `dsh.bundle`，可直接用 **`dsh plugin`** 安装（pnpm 转发 + 自动挂载到 `dsh.profile.bundles` 层）——无需复制目录、无需手改 `cordis.patch.yml`。

### 本地克隆安装（推荐）

```bash
git clone <仓库地址> dsh-mcp-manager
cd dsh-mcp-manager
dsh plugin --profile web add file:./host-plugin
```

- `file:./host-plugin` 的相对路径以**当前目录**为锚点解析（`dsh plugin` 会做 cwd 锚定）；绝对路径亦可，如 `dsh plugin --profile web add C:\path\to\host-plugin`。
- 安装后 `dsh plugin` 自动把 `mcp-manager` 加入 profile 的 `dsh.profile.bundles` 层，**重启 DSH** 即自动挂载，打开 **设置页 → MCP 服务器**。
- 本地路径安装是符号链接：改 `host-plugin/` 代码后重启 DSH 即生效，适合开发迭代。

### 发布 npm 后安装（可选，面向分发）

```bash
cd host-plugin
npm publish
dsh plugin --profile web add mcp-manager
```

### 升级 / 卸载

- 升级：`dsh plugin --profile web update mcp-manager`（或重新 `add` 新路径/新版本）
- 卸载：`dsh plugin --profile web remove mcp-manager`（同时移出 bundles 层）

### 从旧版（手动复制 + 手动 insert）迁移

1. `dsh plugin --profile web add file:./host-plugin`（或绝对路径），重启 DSH 确认面板正常
2. 删除 `~/.dsh/profiles/web/cordis.patch.yml` 里手动追加的 `mcp-manager` insert 块（否则与 bundle patch 重复挂载）
3. 删除 `~/.dsh/profiles/web/node_modules/mcp-manager/` 旧副本（若存在）
4. 再次重启 DSH

首次启动会读取 `$DSH_HOME/mcp-manager.json`（不存在则视为空配置），自动连接全部已配置服务器。

> 依赖服务：`subprocess`、`tools`、`timer`、`connection`（dsh-base 与 web bundle 均已提供）。

## 配置存储

服务器增删改即时写入 `$DSH_HOME/mcp-manager.json`：

```json
[
  {
    "name": "codegraph",
    "command": "C:\\...\\node.exe",
    "args": ["--liftoff-only", "C:\\...\\codegraph.js", "serve", "--mcp"],
    "cwd": "C:\\path\\to\\workspace",
    "toolCallTimeoutMs": 60000
  }
]
```

`env` 为可选的键值对象（如 GitHub token）。删除服务器 = 从面板点「删除」或手动编辑该文件。

## 使用示例

添加并连接一个本地 MCP 服务器（如最小测试服务器 `examples/test-mcp-server.js`），直接在面板表单填写：

| 字段 | 值 |
|---|---|
| 名称 | `test` |
| 命令 | `node` |
| 参数 | `C:\path\to\examples\test-mcp-server.js` |

连接成功后，服务器暴露的工具会出现在 Agent 工具列表，形如：
`mcp__test__echo`、`mcp__test__add`、`mcp__test__complex`、`mcp__test__fail`。

## 架构与设计要点

- **双半插件**：host 半是真实 Cordis 插件（`ctx.tools.register` 注册工具、`ctx.connection.rpc.handle('/mcp-manager')` 提供 RPC、node:fs 落盘）；client 半注册 `settings.section`，经 `ctx.connection.rpc.call('/mcp-manager', endpoint, payload)` 通信（RPC 响应为 `{ok:true,value}|{ok:false,error}` envelope，由 `dsh-client-connection` 强制校验）。
- **stdio 传输**：JSON-RPC 2.0 换行分隔。握手流程 `initialize` → `notifications/initialized` → `tools/list`（支持分页）→ `tools/call`。
- **工具名规范化**：`mcp__<server>__<tool>`，非法字符转 `_`；超长时追加 12 位 FNV-1a 哈希。
- **schema 清洗**：MCP 服务器返回的 inputSchema 先转换成 DSH 工具 DSL 允许的子集（支持 `oneOf`、`enum`、`const`，剔除 `format/pattern/min*` 等），无法转换的工具跳过并计数。
- **生命周期**：意外退出捕获 stderr 尾部并标记错误；断开/删除/插件停止时终止子进程、注销全部工具、拒绝所有挂起请求；插件停止时彻底清理。

## 旧版（动态插件）

`src/host.js` + `src/client.js` 是早期的**动态插件**版（`cordis_define` 加载，进程内存态，重启丢失），仅作参考。新项目请使用 `host-plugin/` 宿主机版。

## 示例服务器

`examples/test-mcp-server.js` 是一个最小可用的 Node stdio MCP 服务器（无依赖），用于快速验证：

```bash
node examples/test-mcp-server.js
```

暴露 4 个工具：`echo`、`add`、`complex`（枚举 + 嵌套对象 + anyOf）、`fail`（isError 用例）。

## License

MIT
