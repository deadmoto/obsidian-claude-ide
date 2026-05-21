/*
 * End-to-end wire-trace verifier for the resources/templates/list + prompts/list
 * fix in src/bridge/ws-adapter.ts.
 *
 * Approach: bundle ws-adapter.ts to a tmp CJS file with esbuild (obsidian is
 * marked external so we can stub it), then import it, boot the bridge against
 * a hand-rolled stub EditorStateAdapter, run the full Claude-style handshake,
 * trigger broadcast paths, record every received frame, and assert there is
 * no error response anywhere in the trace.
 *
 * Run: node scripts/verify-no-error-trace.mjs
 */

import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

// Emit the bundle inside the repo so the bundled `require('ws')` can resolve
// against the repo's node_modules.
const outDir = path.join(repoRoot, 'node_modules', '.cache', 'verify-wire');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `ws-adapter-${process.pid}.cjs`);

// Bundle ws-adapter.ts to a standalone CJS file. `obsidian` is marked external
// so the unused import in editor/state.ts can be neutralized — but we don't
// pull editor/state.ts at all because ws-adapter only imports a *type* from it,
// which esbuild drops.
await build({
  entryPoints: [path.join(repoRoot, 'src/bridge/ws-adapter.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['ws', 'obsidian'],
  outfile: outFile,
  logLevel: 'error'
});

const { WsAdapter } = require(outFile);

// Minimal EditorStateAdapter stub satisfying the surface ws-adapter touches:
//   getCurrentFile(), getCurrentFilePath(), getSelectionPayload(),
//   getWorkspaceFolderPath(), openFile(path).
const fileA = {
  path: '/tmp/vault/a.md',
  relativePath: 'a.md',
  language: 'markdown',
  content: '# A\n',
  isDirty: false,
  timestamp: new Date().toISOString()
};
const fileB = {
  path: '/tmp/vault/b.md',
  relativePath: 'b.md',
  language: 'markdown',
  content: '# B\n',
  isDirty: false,
  timestamp: new Date().toISOString()
};
let activeFile = fileA;

const editorStub = {
  getCurrentFile: () => activeFile,
  getCurrentFilePath: () => activeFile.path,
  getWorkspaceFolderPath: () => '/tmp/vault',
  getSelectionPayload: () => ({
    filePath: activeFile.path,
    selection: null,
    text: ''
  }),
  openFile: async () => activeFile
};

const AUTH = 'verify-token';
const adapter = new WsAdapter(
  { authToken: AUTH, workspaceFolder: '/tmp/vault' },
  editorStub,
  () => undefined
);

const port = await adapter.start();
console.log(`[verify] bridge listening on 127.0.0.1:${port}`);

const trace = [];
const errors = [];

const ws = new WebSocket(`ws://127.0.0.1:${port}/`, 'mcp', {
  headers: { 'x-claude-code-ide-authorization': AUTH }
});

ws.on('message', (raw) => {
  const text = raw.toString();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { __unparsed__: text };
  }
  trace.push({ dir: '<', frame: parsed });
  if (parsed && parsed.error) {
    errors.push(parsed);
  }
});

const opened = new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});
await opened;

let nextId = 1;
const pending = new Map();
ws.on('message', (raw) => {
  try {
    const parsed = JSON.parse(raw.toString());
    if (parsed && typeof parsed.id !== 'undefined' && pending.has(parsed.id)) {
      const resolve = pending.get(parsed.id);
      pending.delete(parsed.id);
      resolve(parsed);
    }
  } catch {
    /* already recorded */
  }
});

function send(obj) {
  trace.push({ dir: '>', frame: obj });
  ws.send(JSON.stringify(obj));
}

function request(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method };
  if (params !== undefined) msg.params = params;
  const p = new Promise((resolve) => pending.set(id, resolve));
  send(msg);
  return p;
}

function notify(method, params) {
  const msg = { jsonrpc: '2.0', method };
  if (params !== undefined) msg.params = params;
  send(msg);
}

// Full Claude-style handshake.
await request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'verify-script', version: '0.0.0' }
});
notify('notifications/initialized');
await request('tools/list');
await request('resources/list');
await request('resources/templates/list'); // the fixed path
await request('prompts/list');             // the fixed path

// Simulate a tab switch: change the stub's active file and fire the broadcasts
// the plugin would emit when Obsidian's workspace state changes.
activeFile = fileB;
adapter.emitResourcesListChanged();
adapter.emitSelectionChanged(editorStub.getSelectionPayload());

// Repeat the post-switch poll Claude does (resources/list +
// resources/templates/list).
await request('resources/list');
await request('resources/templates/list');
await request('prompts/list');

// Drain a beat in case any out-of-band frames arrive late.
await new Promise((r) => setTimeout(r, 100));

ws.close();
await adapter.stop();
try {
  fs.unlinkSync(outFile);
} catch {
  /* ignore */
}

console.log('\n[verify] === wire trace ===');
for (const { dir, frame } of trace) {
  const arrow = dir === '>' ? 'C→S' : 'S→C';
  console.log(arrow, JSON.stringify(frame));
}

const errorFrames = trace.filter((e) => e.dir === '<' && e.frame && e.frame.error);
console.log(`\n[verify] frames received: ${trace.filter((e) => e.dir === '<').length}`);
console.log(`[verify] error frames: ${errorFrames.length}`);

if (errorFrames.length > 0) {
  console.error('[verify] FAIL — error responses present:');
  for (const e of errorFrames) console.error('   ', JSON.stringify(e.frame));
  process.exit(1);
}

console.log('[verify] PASS — no error responses in trace.');
process.exit(0);
