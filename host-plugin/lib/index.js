// ============================================================================
// mcp-manager — host half (Cordis host plugin)
// ----------------------------------------------------------------------------
// A persistent host-side MCP server manager for DSH:
//   - server configs persist to a JSON file (survive restarts)
//   - auto-connects every configured server on plugin activation
//   - registers each server's tools on ctx.tools as mcp__<server>__<tool>
//   - exposes a unary RPC channel (/mcp-manager) consumed by the settings
//     page client half: list/add/remove/connect/disconnect/removeAll
//
// This is a REAL Cordis plugin (no sandbox): node:fs, process, etc. are
// available. It is mounted from cordis.yml like any host plugin.
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'mcp-manager'
export const inject = ['subprocess', 'tools', 'timer', 'connection']

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const MAX_PUBLIC_NAME = 64
const HASH_LENGTH = 12
const SCALARS = { string: 1, number: 1, integer: 1, boolean: 1, null: 1 }

function fnv1a(str, seed) {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}
function hash12(str) {
  const a = fnv1a(str, 0x811c9dc5).toString(16).padStart(8, '0')
  const b = fnv1a(str, 0x01234567).toString(16).padStart(8, '0')
  return (a + b).slice(0, HASH_LENGTH)
}
function publicToolName(serverName, rawName) {
  const joined = 'mcp__' + serverName + '__' + rawName
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME) return normalized
  const hash = hash12(serverName + '\u0000' + rawName)
  return normalized.slice(0, MAX_PUBLIC_NAME - HASH_LENGTH - 1) + '_' + hash
}

function extractText(content) {
  if (!Array.isArray(content)) return '(no output)'
  const parts = []
  for (const b of content) {
    if (isObj(b)) {
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      else if (b.type === 'image') parts.push('[image]')
      else if (b.type === 'audio') parts.push('[audio]')
      else if (b.type === 'resource') parts.push('[resource]')
      else parts.push('[' + String(b.type) + ']')
    } else {
      parts.push('[unsupported]')
    }
  }
  return parts.join('\n') || '(no output)'
}

function sanitizeAnnotations(src, out) {
  if (typeof src.description === 'string') out.description = src.description
  if (typeof src.title === 'string') out.title = src.title
  if (src.default !== undefined) { try { out.default = JSON.parse(JSON.stringify(src.default)) } catch (e) {} }
  if (Array.isArray(src.examples)) { try { out.examples = JSON.parse(JSON.stringify(src.examples)) } catch (e) {} }
}
function sanitizeSchema(src, isRoot) {
  if (!isObj(src)) return isRoot ? { type: 'object', properties: {} } : {}
  if (isRoot) {
    if (src.type !== 'object') return { type: 'object', properties: {} }
    const out = { type: 'object', properties: {} }
    if (isObj(src.properties)) {
      const reqSet = new Set(Array.isArray(src.required) ? src.required.filter((r) => typeof r === 'string' && Object.prototype.hasOwnProperty.call(src.properties, r)) : [])
      const required = []
      for (const key of Object.keys(src.properties)) {
        out.properties[key] = sanitizeSchema(src.properties[key], false)
        if (reqSet.has(key)) required.push(key)
      }
      if (required.length > 0) out.required = required
    }
    sanitizeAnnotations(src, out)
    return out
  }
  const out = {}
  const type = typeof src.type === 'string' ? src.type : undefined
  if (Array.isArray(src.oneOf) && src.oneOf.length >= 2) {
    let ok = true
    const branches = []
    for (const b of src.oneOf) {
      if (!isObj(b)) { ok = false; break }
      branches.push(sanitizeSchema(b, false))
    }
    if (ok) { out.oneOf = branches; sanitizeAnnotations(src, out); return out }
  }
  if (type === 'object') {
    out.type = 'object'
    if (isObj(src.properties)) {
      out.properties = {}
      const reqSet = new Set(Array.isArray(src.required) ? src.required.filter((r) => typeof r === 'string' && Object.prototype.hasOwnProperty.call(src.properties, r)) : [])
      const required = []
      for (const key of Object.keys(src.properties)) {
        out.properties[key] = sanitizeSchema(src.properties[key], false)
        if (reqSet.has(key)) required.push(key)
      }
      if (required.length > 0) out.required = required
    }
    sanitizeAnnotations(src, out)
    return out
  }
  if (type === 'array') {
    out.type = 'array'
    if (isObj(src.items) && !Array.isArray(src.items)) out.items = sanitizeSchema(src.items, false)
    sanitizeAnnotations(src, out)
    return out
  }
  if (SCALARS[type]) {
    out.type = type
    if (Array.isArray(src.enum) && src.enum.length > 0) { try { out.enum = JSON.parse(JSON.stringify(src.enum.slice(0, 100))) } catch (e) {} }
    if (src.const !== undefined) { try { out.const = JSON.parse(JSON.stringify(src.const)) } catch (e) {} }
    sanitizeAnnotations(src, out)
    return out
  }
  sanitizeAnnotations(src, out)
  return out
}

/** Default storage path for persisted server configs (under DSH_HOME). */
function defaultStorePath() {
  const home = process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh')
  return join(home, 'mcp-manager.json')
}

export function apply(ctx, config = {}) {
  const storePath = typeof config.storePath === 'string' && config.storePath
    ? config.storePath
    : defaultStorePath()
  const autoConnect = config.autoConnect !== false

  const servers = new Map()
  let idSeq = 0
  const nextId = () => { idSeq += 1; return 'srv' + idSeq + '-' + Date.now().toString(36) }

  /** Load persisted server configs and hydrate live entries (disconnected). */
  function loadPersisted() {
    try {
      const text = readFileSync(storePath, 'utf8')
      const data = JSON.parse(text)
      if (Array.isArray(data)) {
        for (const c of data) {
          try {
            const s = buildServer(c)
            if (s) servers.set(s.id, s)
          } catch (err) {
            console.error('[mcp-manager] skip persisted config: ' + String(err && err.message || err))
          }
        }
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') console.error('[mcp-manager] load persisted config failed: ' + String(err && err.message || err))
    }
  }
  /** Persist server configs (config only; no live status). */
  function persist() {
    try {
      mkdirSync(dirname(storePath), { recursive: true })
      const data = Array.from(servers.values()).map((s) => ({
        name: s.name,
        command: s.command,
        args: s.args,
        env: s.env,
        cwd: s.cwd,
        toolCallTimeoutMs: s.toolCallTimeoutMs,
      }))
      writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {
      console.error('[mcp-manager] persist config failed: ' + String(err && err.message || err))
    }
  }

  function listViews() { return Array.from(servers.values()).map(serverView) }
  function serverView(s) {
    return {
      id: s.id,
      name: s.name,
      transport: 'stdio',
      command: s.command,
      commandLine: s.command + (s.args.length ? ' ' + s.args.join(' ') : ''),
      cwd: s.cwd || '',
      toolCallTimeoutMs: s.toolCallTimeoutMs,
      status: s.status,
      error: s.error || null,
      toolCount: s.disposers.size,
      skippedTools: s.skippedTools || 0,
      tools: s.toolViews.slice(0, 200),
    }
  }
  function findServer(id) {
    const s = servers.get(id)
    if (!s) throw new Error('server not found: ' + id)
    return s
  }
  function enqueue(s, fn) {
    s.op = s.op.then(fn).catch((err) => {
      console.error('[mcp-manager] ' + s.name + ' op failed: ' + String((err && err.message) || err))
      if (s.status !== 'disconnected') {
        s.status = 'error'
        s.error = String((err && err.message) || err)
      }
    })
  }

  function writeLine(s, obj) {
    if (!s.handle || !s.handle.stdin) throw new Error('not connected')
    s.handle.stdin.write(JSON.stringify(obj) + '\n')
  }
  function rejectAllPending(s, reason) {
    for (const [id, entry] of Array.from(s.pending.entries())) {
      s.pending.delete(id)
      try { entry.cancel() } catch (e) {}
      entry.reject(new Error(reason || 'connection closed'))
    }
  }
  function request(s, method, params, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      const id = s.requestSeq++
      const entry = {
        resolve, reject,
        timer: null,
        onAbort: null,
        cancel() {
          if (entry.timer) { try { entry.timer() } catch (e) {} entry.timer = null }
          if (entry.onAbort && signal) { try { signal.removeEventListener('abort', entry.onAbort) } catch (e) {} entry.onAbort = null }
        },
      }
      s.pending.set(id, entry)
      entry.timer = ctx.timeout(() => {
        if (s.pending.get(id) !== entry) return
        s.pending.delete(id)
        entry.cancel()
        reject(new Error(method + ' timed out after ' + timeoutMs + 'ms'))
      }, timeoutMs)
      if (signal) {
        if (signal.aborted) {
          s.pending.delete(id)
          entry.cancel()
          reject(new Error('aborted'))
          return
        }
        entry.onAbort = () => {
          if (s.pending.get(id) !== entry) return
          s.pending.delete(id)
          reject(new Error('aborted'))
        }
        signal.addEventListener('abort', entry.onAbort)
      }
      try {
        writeLine(s, { jsonrpc: '2.0', id, method, params: params === undefined ? {} : params })
      } catch (err) {
        s.pending.delete(id)
        entry.cancel()
        reject(err)
      }
    })
  }
  function onData(s, chunk) {
    s.buf += s.decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = s.buf.indexOf('\n')) !== -1) {
      const line = s.buf.slice(0, idx).trim()
      s.buf = s.buf.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch (e) { continue }
      onMessage(s, msg)
    }
  }
  function onMessage(s, msg) {
    if (!isObj(msg)) return
    if (msg.id !== undefined && s.pending.has(msg.id)) {
      const entry = s.pending.get(msg.id)
      s.pending.delete(msg.id)
      entry.cancel()
      if (msg.error !== undefined) {
        entry.reject(new Error((msg.error && msg.error.message) || 'JSON-RPC error'))
      } else {
        entry.resolve(msg.result)
      }
      return
    }
    if (msg.method === 'notifications/tools/list_changed' && !s.closing) {
      enqueue(s, async () => { if (s.handle && s.status === 'connected') await syncTools(s) })
    }
  }
  function unregisterTools(s) {
    for (const d of Array.from(s.disposers.values())) { try { d() } catch (e) {} }
    s.disposers = new Map()
    s.toolViews = []
  }
  function onUnexpectedClose(s, reason) {
    if (s.closing || s.status === 'disconnected') return
    const reader = s.handle && s.handle.collected && s.handle.collected.stderr
    let tail = ''
    if (reader) { try { tail = String(reader.readFrom(0).text || '').trim() } catch (e) {} }
    if (tail) { const lines = tail.split('\n'); tail = lines.slice(-3).join('\n') }
    s.status = 'error'
    s.error = (reason || 'connection lost') + (tail ? '\nstderr: ' + tail : '')
    unregisterTools(s)
    rejectAllPending(s, s.error)
    s.handle = undefined
  }
  async function teardownProcess(s) {
    const handle = s.handle
    s.handle = undefined
    if (handle) {
      try { handle.terminate() } catch (e) {}
      try { await Promise.race([handle.done, ctx.timeout(3000)]) } catch (e) {}
    }
    unregisterTools(s)
    rejectAllPending(s, 'connection closed')
  }
  async function syncTools(s) {
    const tools = []
    let cursor
    let pages = 0
    do {
      const res = await request(s, 'tools/list', cursor === undefined ? {} : { cursor }, 15000)
      if (res && Array.isArray(res.tools)) for (const t of res.tools) tools.push(t)
      cursor = res && res.nextCursor
      pages += 1
    } while (cursor && pages < 100)
    const old = s.disposers
    s.disposers = new Map()
    s.toolViews = []
    for (const d of Array.from(old.values())) { try { d() } catch (e) {} }
    const skipped = []
    for (const t of tools) registerTool(s, t, skipped)
    s.skippedTools = skipped.length
    if (skipped.length) console.error('[mcp-manager] ' + s.name + ': skipped ' + skipped.length + ' tools: ' + skipped.join(', '))
  }
  function registerTool(s, rawTool, skipped) {
    if (!isObj(rawTool) || typeof rawTool.name !== 'string' || !rawTool.name) { skipped.push(rawTool && rawTool.name); return }
    try {
      const publicName = publicToolName(s.name, rawTool.name)
      if (s.disposers.has(publicName)) { skipped.push(rawTool.name); return }
      const description = typeof rawTool.description === 'string' ? rawTool.description : ''
      const parameters = sanitizeSchema(rawTool.inputSchema, true)
      const definition = {
        name: publicName,
        description,
        parameters,
        output: {
          schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false },
          render(args, value) {
            return [{ type: 'text', text: extractText(value && value.content) }]
          },
        },
        execute: async (args, exec) => {
          const result = await request(s, 'tools/call', { name: rawTool.name, arguments: isObj(args) ? args : {} }, s.toolCallTimeoutMs, exec.signal)
          const text = extractText(result && result.content)
          if (result && result.isError === true) throw new Error(text || 'MCP tool call failed')
          return { content: (result && result.content) || [] }
        },
      }
      const disposer = ctx.tools.register(definition)
      s.disposers.set(publicName, disposer)
      s.toolViews.push({ publicName, rawName: rawTool.name, description })
    } catch (err) {
      console.error('[mcp-manager] skip tool ' + (rawTool && rawTool.name) + ': ' + String((err && err.message) || err))
      skipped.push(rawTool && rawTool.name)
    }
  }
  async function connectServer(s) {
    if (s.status === 'connecting' || s.status === 'connected') return
    s.status = 'connecting'
    s.error = undefined
    s.closing = false
    s.pending = new Map()
    s.requestSeq = 1
    s.buf = ''
    s.decoder = new TextDecoder()
    s.disposers = new Map()
    s.toolViews = []
    s.skippedTools = 0
    try {
      const program = await ctx.subprocess.resolveExecutable(s.command, s.env)
      const handle = ctx.subprocess.spawn({
        argv: [program, ...s.args],
        cwd: s.cwd || '',
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 } },
        graceMs: 5000,
        env: s.env,
      })
      s.handle = handle
      handle.stdout.on('data', (chunk) => onData(s, chunk))
      handle.stdout.on('error', (err) => onUnexpectedClose(s, String((err && err.message) || err)))
      if (handle.stdin) handle.stdin.on('error', () => {})
      handle.done.then((outcome) => {
        const reason = outcome && outcome.signal ? 'killed by ' + outcome.signal : 'exited with code ' + (outcome && outcome.exitCode)
        onUnexpectedClose(s, reason)
      }, (err) => {
        onUnexpectedClose(s, String((err && err.message) || err))
      })
      await request(s, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'dsh-mcp-manager', version: '2.0.0' },
      }, 15000)
      writeLine(s, { jsonrpc: '2.0', method: 'notifications/initialized' })
      await syncTools(s)
      if (s.closing) return
      s.status = 'connected'
      s.error = undefined
    } catch (err) {
      if (!s.closing) {
        s.status = 'error'
        s.error = String((err && err.message) || err)
      }
      await teardownProcess(s)
    }
  }
  async function disconnectServer(s) {
    s.closing = true
    await teardownProcess(s)
    s.status = 'disconnected'
    s.error = undefined
    s.closing = false
  }
  function buildServer(a) {
    const rawName = String(a.name || '').trim()
    let name = rawName.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
    if (!name) throw new Error('name 必填（字母/数字/-/_）')
    if (name.length > 32) name = name.slice(0, 32)
    if (Array.from(servers.values()).some((s) => s.name === name)) throw new Error('服务器名已存在: ' + name)
    const command = String(a.command || '').trim()
    if (!command) throw new Error('command 必填')
    const argsArr = Array.isArray(a.args) ? a.args.map((x) => String(x)) : []
    const env = {}
    if (isObj(a.env)) for (const k of Object.keys(a.env)) env[k] = String(a.env[k])
    const cwd = typeof a.cwd === 'string' ? a.cwd.trim() : ''
    let timeout = Number(a.toolCallTimeoutMs)
    if (!Number.isFinite(timeout) || timeout <= 0) timeout = 60000
    const s = {
      id: nextId(),
      name,
      transport: 'stdio',
      command,
      args: argsArr,
      env,
      cwd,
      toolCallTimeoutMs: Math.min(Math.floor(timeout), 300000),
      status: 'disconnected',
      error: undefined,
      skippedTools: 0,
      toolViews: [],
      disposers: new Map(),
      pending: new Map(),
      requestSeq: 1,
      buf: '',
      decoder: null,
      handle: undefined,
      closing: false,
      op: Promise.resolve(),
    }
    servers.set(s.id, s)
    return s
  }

  // --- Load persisted config + auto-connect ---
  loadPersisted()
  if (autoConnect) {
    for (const s of Array.from(servers.values())) enqueue(s, () => connectServer(s))
  }

  // --- RPC channel (consumed by the client half via ctx.connection.rpc.call) ---
  ctx.effect(() => {
    const disposer = ctx.connection.rpc.handle('/mcp-manager', async (endpoint, args) => {
      try {
        let servers
        if (endpoint === 'list') {
          servers = listViews()
        } else if (endpoint === 'add') {
          const s = buildServer(isObj(args) ? args : {})
          persist()
          if (isObj(args) && args.connect === true) enqueue(s, () => connectServer(s))
          servers = listViews()
        } else if (endpoint === 'remove') {
          const s = findServer(args && args.id)
          s.closing = true
          await teardownProcess(s)
          servers.delete(s.id)
          persist()
          servers = listViews()
        } else if (endpoint === 'connect') {
          const s = findServer(args && args.id)
          enqueue(s, () => connectServer(s))
          servers = listViews()
        } else if (endpoint === 'disconnect') {
          const s = findServer(args && args.id)
          await disconnectServer(s)
          servers = listViews()
        } else if (endpoint === 'removeAll') {
          for (const s of Array.from(servers.values())) { s.closing = true; await teardownProcess(s) }
          servers.clear()
          persist()
          servers = []
        } else {
          return {
            ok: false,
            error: { code: 'bad-request', message: 'unknown endpoint: ' + String(endpoint), details: { issues: [] } }
          }
        }
        return { ok: true, value: { servers } }
      } catch (err) {
        return {
          ok: false,
          error: { code: 'bad-request', message: String((err && err.message) || err), details: { issues: [] } }
        }
      }
    }, { authority: 'loopback' })
    return disposer
  }, 'mcp-manager.rpc')

  // --- Cleanup on plugin stop ---
  ctx.effect(() => {
    return () => {
      for (const s of Array.from(servers.values())) {
        s.closing = true
        try { unregisterTools(s) } catch (e) {}
        try { if (s.handle) s.handle.terminate() } catch (e) {}
        rejectAllPending(s, 'plugin stopped')
      }
      servers.clear()
    }
  }, 'mcp-manager.cleanup')
}
