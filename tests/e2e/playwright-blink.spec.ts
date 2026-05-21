/**
 * E2E regression test for the tab-switch "blink" bug.
 *
 * Real Obsidian launched headed with --remote-debugging-port; CDP attaches and
 * drives the renderer with page.evaluate(). A separate WS observer connects to
 * the plugin's MCP bridge using the `mcp` subprotocol that A's WsAdapter
 * requires, and records every frame received.
 *
 * The blink: Claude follows every resources/list with resources/templates/list.
 * Before the fix, the server returned -32600 Unsupported method, and Claude's
 * MCP client invalidated ideSelection on the error — wiping "⧉ In file.md".
 * The fix returns {resourceTemplates: []} (and {prompts: []} for prompts/list).
 *
 * This spec asserts:
 *   1) Switching tabs A → B → A produces selection_changed frames for both
 *      files, in order, with no JSON-RPC error frames anywhere in the trace.
 *   2) An explicit resources/templates/list request answered with
 *      {resourceTemplates: []}, not an error.
 *   3) An explicit prompts/list request answered with {prompts: []}.
 *
 * Run:  npm run test:e2e:obsidian
 * Requires Obsidian.app on macOS and ALL Obsidian windows closed.
 */

import { test, expect, chromium } from '@playwright/test';
import {
  writeFile, readFile, readdir, stat, mkdir, copyFile, rm,
} from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { WebSocket } from 'ws';

// package.json sets "type": "module" so __dirname is undefined.
const __dirname = dirname(fileURLToPath(import.meta.url));

const OBSIDIAN_BIN = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
const CDP_PORT     = 19_225;
const PLUGIN_ID    = 'obsidian-claude-ide'; // manifest id (matches dir name)
const PLUGIN_DIR   = 'obsidian-claude-ide';

const REPO_ROOT       = join(__dirname, '..', '..');
const BUILT_MAIN_JS   = join(REPO_ROOT, 'dist', 'main.js');
const BUILT_MANIFEST  = join(REPO_ROOT, 'manifest.json');

const FILE_A = 'note-a.md';
const FILE_B = 'note-b.md';
const TEXT_A = '# Note A\n\nAlpha alpha alpha.\n';
const TEXT_B = '# Note B\n\nBravo bravo bravo.\n';

// ── Vault setup ────────────────────────────────────────────────────────────────

async function createTestVault(): Promise<string> {
  const vaultDir  = join(tmpdir(), `claude-ide-e2e-${randomBytes(4).toString('hex')}`);
  const pluginDir = join(vaultDir, '.obsidian', 'plugins', PLUGIN_DIR);
  await mkdir(pluginDir, { recursive: true });

  if (!existsSync(BUILT_MAIN_JS)) {
    throw new Error(`Build artefact missing: ${BUILT_MAIN_JS}. Run \`npm run build\` first.`);
  }

  await copyFile(BUILT_MAIN_JS,  join(pluginDir, 'main.js'));
  await copyFile(BUILT_MANIFEST, join(pluginDir, 'manifest.json'));

  await writeFile(join(vaultDir, '.obsidian', 'app.json'),
    JSON.stringify({ safeMode: false, livePreview: true }));
  await writeFile(join(vaultDir, '.obsidian', 'community-plugins.json'),
    JSON.stringify([PLUGIN_ID]));

  await writeFile(join(vaultDir, FILE_A), TEXT_A);
  await writeFile(join(vaultDir, FILE_B), TEXT_B);

  return vaultDir;
}

// Build a complete --user-data-dir for an isolated Obsidian process.
// Returns the dir path. The test passes --user-data-dir=<this> on spawn,
// which gives the second Obsidian its own Electron lock, its own
// obsidian.json, and its own cache — independent of the user's real
// Obsidian, so the test can run while the user keeps their Obsidian open.
async function prepareUserDataDir(vaultDir: string): Promise<string> {
  const userDataDir = join(tmpdir(), `obsidian-e2e-userdata-${randomBytes(4).toString('hex')}`);
  await mkdir(userDataDir, { recursive: true });
  const cfg = {
    vaults: {
      [randomBytes(8).toString('hex')]: {
        path: vaultDir,
        ts: Date.now(),
        open: true
      }
    }
  };
  await writeFile(join(userDataDir, 'obsidian.json'), JSON.stringify(cfg, null, 4));
  return userDataDir;
}

// ── Bridge discovery ──────────────────────────────────────────────────────────

interface BridgeInfo { port: number; authToken: string; vaultPath: string; }

async function findBridge(afterMs: number, vaultDir: string): Promise<BridgeInfo> {
  const lockDir  = join(homedir(), '.claude/ide');
  const deadline = Date.now() + 20_000;
  const seen: string[] = [];
  while (Date.now() < deadline) {
    try {
      for (const f of (await readdir(lockDir)).filter(x => x.endsWith('.lock'))) {
        const fp = join(lockDir, f);
        const st = await stat(fp);
        if (st.mtimeMs < afterMs) continue;
        const raw = await readFile(fp, 'utf8');
        const d = JSON.parse(raw);
        seen.push(`${f} ide=${d.ideName} folders=${JSON.stringify(d.workspaceFolders)} mtime=${Math.round(st.mtimeMs - afterMs)}ms`);
        if (d.ideName !== 'Obsidian') continue;
        if (!Array.isArray(d.workspaceFolders) || !d.workspaceFolders.includes(vaultDir)) continue;
        try { process.kill(d.pid, 0); } catch { continue; }
        return { port: parseInt(f, 10), authToken: d.authToken, vaultPath: d.workspaceFolders[0] };
      }
    } catch { /* lockDir may not exist yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(
    `Timed out waiting for Obsidian bridge (20s).\n` +
    `  expected vaultDir=${vaultDir}\n` +
    `  locks seen since launch (${seen.length}):\n    ${seen.join('\n    ') || '(none)'}\n`
  );
}

// ── WS observer ───────────────────────────────────────────────────────────────

interface Frame { dir: 'in' | 'out'; raw: string; parsed: any; t: number; }

interface Observer {
  close(): void;
  frames(): Frame[];
  request(method: string, params?: any): Promise<any>;
}

function connectObserver(bridge: BridgeInfo): Promise<Observer> {
  return new Promise((resolve, reject) => {
    // A's WsAdapter REQUIRES the `mcp` subprotocol — without it the connection
    // is closed with code 1008.
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, ['mcp'], {
      headers: { 'x-claude-code-ide-authorization': bridge.authToken },
    });

    const frames: Frame[] = [];
    const pending = new Map<number, (msg: any) => void>();
    let nextId = 1000;

    const trackIn = (raw: string): any => {
      const parsed = JSON.parse(raw);
      frames.push({ dir: 'in', raw, parsed, t: Date.now() });
      return parsed;
    };

    const trackOut = (msg: any) => {
      const raw = JSON.stringify(msg);
      frames.push({ dir: 'out', raw, parsed: msg, t: Date.now() });
      ws.send(raw);
    };

    ws.on('error', reject);
    ws.on('open', async () => {
      const drain = (ms = 200) => new Promise<void>(res => setTimeout(res, ms));

      ws.on('message', (raw: Buffer) => {
        const msg = trackIn(raw.toString());
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
        // Mimic Claude's MCP client: every list_changed triggers
        // resources/list → resources/templates/list → prompts/list. This is
        // the exact sequence that exposes the blink bug, so the tab-switch
        // trace must drive it for the "no error frames" assertion to mean
        // anything.
        if (msg.method === 'notifications/resources/list_changed') {
          trackOut({ jsonrpc: '2.0', id: ++nextId, method: 'resources/list' });
          trackOut({ jsonrpc: '2.0', id: ++nextId, method: 'resources/templates/list' });
          trackOut({ jsonrpc: '2.0', id: ++nextId, method: 'prompts/list' });
        }
      });

      trackOut({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          clientInfo: { name: 'playwright-observer', version: '0.0.1' },
          capabilities: {},
        },
      });
      await drain();

      trackOut({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await drain();

      trackOut({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      await drain();

      trackOut({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
      await drain();

      const request = (method: string, params?: any): Promise<any> =>
        new Promise((res) => {
          const id = ++nextId;
          pending.set(id, res);
          trackOut({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
        });

      resolve({
        close: () => ws.close(),
        frames: () => frames.slice(),
        request,
      });
    });
  });
}

// ── Test ──────────────────────────────────────────────────────────────────────

test.setTimeout(90_000);

test('tab switches produce no JSON-RPC error frames and templates/list returns empty', async () => {
  const launchTime = Date.now();

  const vaultDir     = await createTestVault();
  const userDataDir  = await prepareUserDataDir(vaultDir);
  let proc: ChildProcess | null = null;

  try {
    // --user-data-dir gives this Obsidian its own Electron single-instance
    // lock + obsidian.json so it runs independently from any other Obsidian
    // the user has open. CDP port must be distinct from any port a parallel
    // Obsidian is already using.
    proc = spawn(
      OBSIDIAN_BIN,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${userDataDir}`,
      ],
      { stdio: 'ignore', detached: false },
    );

    // 1. Wait for CDP endpoint.
    const cdpDeadline = Date.now() + 15_000;
    let browser;
    while (Date.now() < cdpDeadline) {
      try { browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`); break; }
      catch { await new Promise(r => setTimeout(r, 300)); }
    }
    if (!browser) throw new Error('CDP endpoint did not appear within 15s');

    const page = browser.contexts()[0].pages()[0];
    await page.waitForSelector('.workspace', { timeout: 20_000 });

    // 2. Dismiss the "Do you trust the author of this vault?" modal. Obsidian
    //    1.5+ shows this on first open and gates plugin loading on it — the
    //    bridge won't start until we click through. Selector is .mod-trust-folder
    //    and the primary button text is "Trust author and enable plugins".
    //    The dialog can appear up to several seconds after the workspace shell.
    try {
      await page.waitForSelector('.mod-trust-folder', { timeout: 10_000 });
      const trustBtn = page
        .locator('.mod-trust-folder button', { hasText: /trust author/i })
        .first();
      await trustBtn.click();
      await page.waitForSelector('.mod-trust-folder', { state: 'detached', timeout: 5_000 });
    } catch {
      // No trust dialog — vault was already trusted or Obsidian skipped it.
    }

    // 3. Find the MCP bridge created by this plugin instance, then attach observer.
    const bridge = await findBridge(launchTime, vaultDir);
    const observer = await connectObserver(bridge);

    // 4. Open A → settle → open B → settle → back to A → settle. Each opens
    //    via the workspace API (no HID), which goes through the same
    //    active-leaf-change path real tab clicks use.
    const openFile = async (fname: string) => {
      await page.evaluate(async (name: string) => {
        await (window as any).app.workspace.openLinkText(name.replace('.md', ''), '', false);
      }, fname);
      await page.waitForTimeout(800);
    };

    await openFile(FILE_A);
    await openFile(FILE_B);
    await openFile(FILE_A);

    // 5. Explicitly probe the methods that used to error.
    const tplResp     = await observer.request('resources/templates/list');
    const promptsResp = await observer.request('prompts/list');

    // 6. Bonus scenario: focusing a non-MarkdownView must NOT wipe ideSelection.
    //    Repro of the original "selection lost on terminal focus" bug — before
    //    the gate in main.ts, active-leaf-change on any leaf would call
    //    setActiveLeaf and emit selection_changed with a wrong/null filePath.
    //    Today the handler returns early when the new leaf isn't MarkdownView,
    //    so focusing a new empty tab should produce no new selection_changed.
    const frameCountBeforeFocus = observer.frames().length;
    await page.evaluate(async () => {
      const leaf = (window as any).app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: 'empty', active: true });
      (window as any).app.workspace.setActiveLeaf(leaf, { focus: true });
    });
    await page.waitForTimeout(600);

    const newSelChanges = observer
      .frames()
      .slice(frameCountBeforeFocus)
      .filter(f => f.dir === 'in' && f.parsed?.method === 'selection_changed');

    // 7. Drain and capture.
    await page.waitForTimeout(500);
    const allFrames = observer.frames();
    observer.close();
    await browser.close();

    // ── Assertions ────────────────────────────────────────────────────────────

    // (a) No error responses anywhere in the trace from the server.
    const errorFrames = allFrames.filter(
      f => f.dir === 'in' && f.parsed && f.parsed.error
    );
    expect(errorFrames, `error frames: ${errorFrames.map(f => f.raw).join('\n')}`)
      .toHaveLength(0);

    // (b) selection_changed pushes for both files appeared, with file paths
    //     ending in the expected filenames.
    const selPushes = allFrames.filter(
      f => f.dir === 'in' && f.parsed?.method === 'selection_changed'
    );
    const filePathsSeen = selPushes
      .map(f => String(f.parsed?.params?.filePath ?? ''))
      .filter(Boolean);
    expect(filePathsSeen.some(p => p.endsWith(FILE_A)),
      `expected selection_changed for ${FILE_A} in: ${filePathsSeen.join(', ')}`)
      .toBe(true);
    expect(filePathsSeen.some(p => p.endsWith(FILE_B)),
      `expected selection_changed for ${FILE_B} in: ${filePathsSeen.join(', ')}`)
      .toBe(true);

    // (c) templates/list returns an empty success, not an error.
    expect(tplResp.error).toBeUndefined();
    expect(tplResp.result).toEqual({ resourceTemplates: [] });

    // (d) prompts/list returns an empty success, not an error.
    expect(promptsResp.error).toBeUndefined();
    expect(promptsResp.result).toEqual({ prompts: [] });

    // (e) focusing a non-MarkdownView did not emit any selection_changed.
    expect(
      newSelChanges,
      `focusing a non-markdown leaf should not emit selection_changed but got: ${newSelChanges.map(f => f.raw).join('\n')}`
    ).toHaveLength(0);

    // (f) No notifications/resources/list_changed during tab switches.
    //     Claude clears ideSelection on list_changed and the trailing
    //     selection_changed races with the reset — producing the original
    //     "appears then disappears" flicker. Regression guard.
    const listChanges = allFrames.filter(
      f => f.dir === 'in' && f.parsed?.method === 'notifications/resources/list_changed'
    );
    expect(
      listChanges,
      `tab switches must NOT emit notifications/resources/list_changed but got: ${listChanges.map(f => f.raw).join('\n')}`
    ).toHaveLength(0);

  } finally {
    proc?.kill();
    // Give Obsidian a moment to exit cleanly so the lock file is gone.
    await new Promise(r => setTimeout(r, 500));
    await rm(vaultDir,    { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});
