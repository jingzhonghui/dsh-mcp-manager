// Minimal MCP stdio server used for acceptance testing of the mcp-manager plugin.
// Speaks newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport).
// Run: node test-mcp-server.js
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the given text back, repeated `times` times.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo' },
        times: { type: 'integer', description: 'How many times to repeat', minimum: 1 },
      },
      required: ['text'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers and return the sum.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' },
      },
      required: ['a', 'b'],
    },
  },
  {
    name: 'complex',
    description: 'Tool with a schema that stresses the sanitizer: enum, nested object with required, anyOf.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'slow'], description: 'Operating mode' },
        nested: {
          type: 'object',
          description: 'A nested object',
          properties: { x: { type: 'integer', description: 'Inner value' } },
          required: ['x'],
        },
        pick: { anyOf: [{ type: 'string' }, { type: 'number' }], description: 'Either a string or a number' },
      },
      required: ['mode'],
    },
  },
  {
    name: 'fail',
    description: 'Always fails with isError: true, to test error mapping.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return;
  }
  if (!msg || typeof msg !== 'object') return;

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'test-mcp-server', version: '1.0.0' },
      },
    });
    return;
  }
  if (msg.method === 'notifications/initialized') {
    return;
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    if (name === 'echo') {
      const text = String(args.text || '');
      const times = Math.max(1, Math.min(10, Number(args.times) || 1));
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: Array(times).fill(text).join(' ') }] },
      });
    } else if (name === 'add') {
      const sum = Number(args.a) + Number(args.b);
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: String(sum) }] },
      });
    } else if (name === 'complex') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify(args) }] },
      });
    } else if (name === 'fail') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: 'boom' }], isError: true },
      });
    } else {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'unknown tool: ' + name },
      });
    }
    return;
  }
  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: 'method not supported: ' + (msg.method || '') },
  });
});
