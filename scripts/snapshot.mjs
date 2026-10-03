#!/usr/bin/env node
/**
 * Visual integration check: drives the running dev server in headless Chrome over the
 * DevTools protocol (no dependencies), applies a list of scenarios, waits for the physics
 * worker to settle, and writes a screenshot per scenario.
 *
 *   npm run dev            # in another terminal
 *   node scripts/snapshot.mjs [scenarios.json] [--out dir] [--url http://localhost:5173]
 *
 * A scenario is { "name": "side-view", "setup": "<JS run in the page>", "wait": 1500 }.
 * The setup code can use `t` (the dev-only window.__tunnel handle: store, results, scene).
 * Without a scenarios file a default tour is captured. Console errors are reported and make
 * the script exit non-zero.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const outDir = resolve(flag('--out', 'snapshots'));
const baseUrl = flag('--url', 'http://localhost:5173');
const width = Number(flag('--width', '1440'));
const height = Number(flag('--height', '900'));
const chromePath =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const DEFAULT_SCENARIOS = [
  { name: '01-overview', setup: '', wait: 2500 },
  {
    name: '02-side-streamlines',
    setup: `t.store.set(s => ({...s, view: {...s.view, flowMode: 'streamlines', camera: 'side'}}))`,
    wait: 2500,
  },
  {
    name: '03-tip-vortex',
    setup: `t.store.set(s => ({...s, view: {...s.view, flowMode: 'both', camera: 'tip', rake: {...s.view.rake, mode: 'tip-vortex'}}}))`,
    wait: 3000,
  },
  {
    name: '04-stall',
    setup: `t.store.set(s => ({...s, flow: {...s.flow, alphaDeg: 18}, view: {...s.view, camera: 'overview'}}))`,
    wait: 3000,
  },
];

const scenarios = args[0] ? JSON.parse(readFileSync(args[0], 'utf8')) : DEFAULT_SCENARIOS;
mkdirSync(outDir, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'tunnel-chrome-'));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--hide-scrollbars',
    '--enable-unsafe-swiftshader',
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

const wsUrl = await connect();
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else res(msg.result);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? 'exception');
  }
};
const send = (method, params = {}) =>
  new Promise((res, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: res, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval');
  return r.result.value;
};
const settle = async (extraMs) => {
  // Wait until the physics worker reports nothing pending, then let animation run.
  for (let i = 0; i < 100; i++) {
    // Production builds have no dev handle: nothing to poll, just wait.
    const busy = await evaluate(
      `!!window.__tunnel && window.__tunnel.results.get().pending.length > 0`,
    );
    if (!busy) break;
    await sleep(150);
  }
  await sleep(extraMs);
};

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: baseUrl });
  // Wait for the dev handle (or, in a production build, for the canvas to appear).
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`!!window.__tunnel || !!document.querySelector('canvas')`)) break;
    await sleep(200);
  }
  const report = [];
  for (const sc of scenarios) {
    if (sc.setup) await evaluate(`(async () => { const t = window.__tunnel; ${sc.setup} })()`);
    await settle(sc.wait ?? 1500);
    const stats = await evaluate(`(() => { if (!window.__tunnel) return null;
      const r = window.__tunnel.results.get(); const a = r.aero;
      return a ? { CL: +a.CL.toFixed(3), LD: +a.liftToDrag.toFixed(1), liftKN: +(a.lift/1000).toFixed(0),
      stall: a.stall.any, alphaDeg: +(a.alpha*180/Math.PI).toFixed(1), fps: window.__tunnel.scene.fps,
      lines: r.streamlines?.length ?? 0 } : null })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(outDir, `${sc.name}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    report.push({ name: sc.name, file, stats });
    console.log(`${sc.name}: ${JSON.stringify(stats)}`);
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ report, consoleErrors }, null, 2));
  if (consoleErrors.length) {
    console.error(`Console errors:\n  ${consoleErrors.join('\n  ')}`);
    process.exitCode = 1;
  }
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
