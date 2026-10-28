// Run with: node --test tests/manual-pause.test.cjs
// Real content-script control flow with deterministic browser/backend fixtures.
// No network requests, downloads or Feishu writes leave the fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CREATOR = 'MS4wLjABAAAA_fixture_creator_01';
const IDS = ['7561234567890123456', '7561234567890123457', '7561234567890123458'];
const plain = (value) => JSON.parse(JSON.stringify(value));
const drain = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };

function work(id) {
  return { aweme_id: id, desc: `作品 ${id}`, author: { sec_uid: CREATOR, nickname: '测试作者' },
    create_time: Date.parse('2026-09-10T12:00:00+08:00') / 1000,
    statistics: { digg_count: 10, comment_count: 2, collect_count: 3, share_count: 4 } };
}

function fixture({ onScroll, onControl, onMessage, onTimeout, confirmation = true } = {}) {
  const listeners = [];
  const intervals = new Map();
  const trace = { controls: [], messages: [], network: [], scrolls: 0, statuses: [], confirms: [], clearedIntervals: [] };
  const nodes = new Map();
  for (const name of ['primary', 'sync', 'single-work', 'works', 'works-filter', 'secondary', 'pause', 'collapse',
    'comment-toggle', 'transcribe-toggle']) {
    nodes.set(`.douhot-extractor-${name}`, { disabled: name === 'pause', style: {}, dataset: {}, textContent: '',
      setAttribute(name, value) { this[name] = value; } });
  }
  let statusText = '';
  const statusNode = { dataset: {}, get textContent() { return statusText; },
    set textContent(value) { statusText = value; trace.statuses.push(value); } };
  nodes.set('.douhot-extractor-status', statusNode);
  const buttons = ['primary', 'sync', 'single-work', 'works', 'works-filter', 'secondary', 'pause', 'collapse']
    .map((name) => nodes.get(`.douhot-extractor-${name}`));
  const panel = {
    dataset: {},
    querySelector: (selector) => nodes.get(selector) || null,
    querySelectorAll: (selector) => buttons.filter((button) =>
      !(selector.includes(':not(.douhot-extractor-collapse)') && button === nodes.get('.douhot-extractor-collapse'))
      && !(selector.includes(':not(.douhot-extractor-pause)') && button === nodes.get('.douhot-extractor-pause'))),
  };
  const document = {
    title: '测试作者的主页 - 抖音', body: {}, documentElement: { scrollHeight: 9000 },
    getElementById: (id) => id === 'douhot-creator-extractor-panel' ? panel : null,
    querySelector: () => null, querySelectorAll: () => [],
  };
  let self;
  let timerId = 0;
  const window = {
    douhotCreatorExtractor: {},
    addEventListener: (type, listener) => { if (type === 'message') listeners.push(listener); },
    postMessage: () => {},
    scrollTo: () => { trace.scrolls += 1; onScroll?.(self, trace.scrolls); },
    setTimeout: (callback, delay) => {
      if (onTimeout?.(self, callback, delay) !== true) queueMicrotask(callback);
      return ++timerId;
    },
    clearTimeout: () => {},
    setInterval: (callback) => { const id = ++timerId; intervals.set(id, callback); return id; },
    clearInterval: (id) => { intervals.delete(id); trace.clearedIntervals.push(id); },
    confirm: (message) => { trace.confirms.push(message); return confirmation; },
  };
  const context = vm.createContext({
    window, document, URL, URLSearchParams, console,
    location: new URL(`https://www.douyin.com/user/${CREATOR}`),
    fetch: async (url) => { trace.network.push(String(url)); return { ok: true, text: async () => JSON.stringify({ code: 0, data: { value: 1 } }) }; },
    chrome: { runtime: {
      id: 'fixture-extension', lastError: null,
      sendMessage: (message, callback) => {
        if (message.type === 'douhot:manualRunControl') {
          trace.controls.push(plain(message));
          if (onControl?.(self, message, callback) === true) return;
          callback({ ok: true, data: { runId: message.payload.runId, paused: message.payload.action === 'pause' } });
          return;
        }
        trace.messages.push(plain(message));
        if (onMessage?.(self, message, callback) === true) return;
        const total = message.payload?.works?.length || 0;
        callback({ ok: true, data: { total, created: total, updated: 0 } });
      },
    } },
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'douyin-profile-cache.js'), 'utf8'), context);
  const source = fs.readFileSync(path.join(ROOT, 'douhot-extractor.user.js'), 'utf8');
  const boot = source.indexOf('  window.douhotCreatorExtractor =');
  assert.ok(boot > 0, 'content-script bootstrap boundary exists');
  vm.runInContext(source.slice(0, boot) + `
    globalThis.api = { createManualRun, startManualRun, finishManualRun, manualCheckpoint,
      toggleManualRunPause, sendExtensionMessage, requestJson, fetchDouyinApiJson, status, updatePrimaryButton,
      runWorksExtractor, confirmAllWorksSync, runAllWorksWithConfirmation,
      getRun: () => activeManualRun, setRoute: (fn) => { runOrRouteWorks = fn; } };
  })();`, context);
  self = {
    api: context.api, context, trace, nodes, intervals,
    pauseButton: nodes.get('.douhot-extractor-pause'), statusNode,
    emit: (page = {}) => {
      const data = { source: 'douhot:profile-capture:v1', type: 'page', creatorId: CREATOR,
        cursor: '0', nextCursor: '10', hasMore: true, capturedAt: 100, works: [work(IDS[0])], ...page };
      for (const listener of listeners) listener({ source: window, origin: context.location.origin, data });
    },
    start: async () => { const run = context.api.createManualRun(); await context.api.startManualRun(run); return run; },
  };
  return self;
}

test('competitor buttons have the requested names on the profile', () => {
  const f = fixture();
  f.api.updatePrimaryButton();
  assert.equal(f.nodes.get('.douhot-extractor-primary').textContent, '竞品信息下载');
  assert.equal(f.nodes.get('.douhot-extractor-sync').textContent, '竞品信息收集');
  assert.equal(f.nodes.get('.douhot-extractor-works').textContent, '同步主页作品');
});

test('full-profile confirmation cancels without routing, requests or a busy run', async () => {
  const f = fixture({ confirmation: false });
  let routed = 0;
  f.api.setRoute(() => { routed += 1; });
  await f.api.runAllWorksWithConfirmation({ sync: true });
  assert.deepEqual(f.trace.confirms, ['会提取主页所有的作品，时间较长，是否继续？']);
  assert.equal(routed, 0);
  assert.equal(f.api.getRun(), null);
  assert.deepEqual(f.trace.controls, []);
  assert.deepEqual(f.trace.messages, []);
});

test('accepting full-profile confirmation routes exactly once with the original options', async () => {
  const f = fixture();
  const routed = [];
  f.api.setRoute((options) => { routed.push(plain(options)); return Promise.resolve({ routed: true }); });
  const result = await f.api.runAllWorksWithConfirmation({ sync: true, includeComments: true });
  assert.deepEqual(routed, [{ sync: true, includeComments: true }]);
  assert.equal(f.trace.confirms.length, 1);
  assert.equal(result.routed, true);
});

test('a manual run excludes a second run and keeps pause/collapse available while busy', async () => {
  const f = fixture();
  const run = await f.start();
  assert.throws(() => f.api.createManualRun(), /正在|进行|完成|任务/);
  assert.equal(f.nodes.get('.douhot-extractor-primary').disabled, true);
  assert.equal(f.nodes.get('.douhot-extractor-collapse').disabled, false);
  assert.equal(f.pauseButton.disabled, false);
  assert.equal(f.pauseButton.textContent, '暂停同步提取');
  await f.api.finishManualRun(run);
  assert.equal(f.api.getRun(), null);
  assert.equal(f.nodes.get('.douhot-extractor-primary').disabled, false);
  assert.equal(f.pauseButton.disabled, true);
  assert.equal(f.pauseButton.textContent, '暂停同步提取');
  assert.equal(f.intervals.size, 0);
  assert.deepEqual(f.trace.controls.map((message) => message.payload.action), ['start', 'finish']);
});

test('paused collection does not scroll or sync and resumes from the accumulated native page', async () => {
  let pausing;
  const f = fixture({ onScroll: (self, count) => {
    if (count === 1) pausing = self.api.toggleManualRunPause();
    if (count === 2) self.emit({ cursor: '20', nextCursor: '30', capturedAt: 300,
      hasMore: false, works: [work(IDS[2])] });
  } });
  f.emit();
  const pending = f.api.runWorksExtractor({ sync: true });
  await drain();
  await pausing;
  assert.equal(f.trace.scrolls, 1);
  assert.equal(f.trace.messages.length, 0);
  f.emit({ cursor: '10', nextCursor: '20', capturedAt: 200, works: [work(IDS[1])] });
  await drain();
  assert.equal(f.trace.scrolls, 1, 'native pages can arrive, but the extension must not request another page');
  assert.equal(f.trace.messages.length, 0);
  assert.equal(f.pauseButton.textContent, '继续同步提取');
  await f.api.toggleManualRunPause();
  const result = await pending;
  assert.deepEqual(plain(result.works.map((item) => item.awemeId)), IDS);
  assert.equal(f.trace.scrolls, 2);
  assert.equal(f.trace.messages.length, 1, 'resume must not submit the same batch twice');
  assert.equal(f.trace.messages[0].type, 'douhot:syncWorksFeishu');
  assert.ok(f.trace.messages[0].runId);
  assert.equal(f.api.getRun(), null);
});

test('pause blocks new extension requests and direct hotspot API requests until resume', async () => {
  const f = fixture();
  const run = await f.start();
  await f.api.toggleManualRunPause();
  const sync = f.api.sendExtensionMessage({ type: 'douhot:syncWorksFeishu', payload: { works: [work(IDS[0])] } });
  const request = f.api.requestJson('/douhot/v1/author_analysis/author_info', { sec_uid: CREATOR });
  await drain();
  assert.equal(f.trace.messages.length, 0);
  assert.equal(f.trace.network.length, 0);
  await f.api.toggleManualRunPause();
  await Promise.all([sync, request]);
  assert.equal(f.trace.messages.length, 1);
  assert.equal(f.trace.messages[0].runId, run.id);
  assert.equal(f.trace.network.length, 1);
  await f.api.finishManualRun(run);
});

test('a response that arrives during pause cannot trigger downstream work before resume', async () => {
  let release;
  const f = fixture({ onMessage: (_self, _message, callback) => { release = callback; return true; } });
  const run = await f.start();
  let completed = false;
  const pending = f.api.sendExtensionMessage({ type: 'douhot:syncWorksFeishu', payload: { works: [work(IDS[0])] } })
    .then(() => { completed = true; });
  await drain();
  assert.equal(f.trace.messages.length, 1);
  await f.api.toggleManualRunPause();
  release({ ok: true, data: { total: 1 } });
  await drain();
  assert.equal(completed, false);
  await f.api.toggleManualRunPause();
  await pending;
  assert.equal(completed, true);
  assert.equal(f.trace.messages.length, 1);
  await f.api.finishManualRun(run);
});

test('progress arriving during pause preserves pause status and resumes the latest status', async () => {
  const f = fixture();
  const run = await f.start();
  f.api.status('正在读取第 2 页...');
  await f.api.toggleManualRunPause();
  f.api.status('正在同步 3 条作品...');
  assert.match(f.statusNode.textContent, /已暂停/);
  await f.api.toggleManualRunPause();
  assert.equal(f.statusNode.textContent, '正在同步 3 条作品...');
  await f.api.finishManualRun(run);
});

test('rapid repeated clicks cannot invert a pending pause, and resume waits for backend acknowledgement', async () => {
  const replies = new Map();
  const f = fixture({ onControl: (_self, message, callback) => {
    if (!['pause', 'resume'].includes(message.payload.action)) return false;
    replies.set(message.payload.action, callback);
    return true;
  } });
  const run = await f.start();
  const pause = f.api.toggleManualRunPause();
  await f.api.toggleManualRunPause();
  assert.equal(f.pauseButton.disabled, true);
  assert.deepEqual(f.trace.controls.map((message) => message.payload.action), ['start', 'pause']);
  const pending = f.api.sendExtensionMessage({ type: 'douhot:syncWorksFeishu', payload: { works: [work(IDS[0])] } });
  replies.get('pause')({ ok: true, data: { paused: true } });
  await pause;
  const resume = f.api.toggleManualRunPause();
  await drain();
  assert.equal(f.trace.messages.length, 0, 'the frontend must wait for the backend to resume too');
  replies.get('resume')({ ok: true, data: { paused: false } });
  await resume;
  await pending;
  assert.equal(f.trace.messages.length, 1);
  await f.api.finishManualRun(run);
});

test('failed pause aborts queued work instead of letting it continue without a backend pause', async () => {
  const f = fixture({ onControl: (_self, message, callback) => {
    if (message.payload.action !== 'pause') return false;
    callback({ ok: false, error: '后台任务已失效' });
    return true;
  } });
  const run = await f.start();
  const pause = f.api.toggleManualRunPause();
  const pending = f.api.sendExtensionMessage({ type: 'douhot:syncWorksFeishu', payload: { works: [work(IDS[0])] } });
  await pause;
  await assert.rejects(pending, /暂停\/继续失败.*后台任务已失效/);
  assert.equal(f.trace.messages.length, 0);
  assert.equal(f.pauseButton.disabled, true);
  assert.match(f.statusNode.textContent, /本次任务已停止/);
  assert.ok(f.trace.controls.some((message) => message.payload.action === 'finish'));
  await f.api.finishManualRun(run);
});

test('a lost heartbeat releases paused waiters with an error and cannot submit queued writes', async () => {
  const f = fixture({ onControl: (_self, message, callback) => {
    if (message.payload.action !== 'heartbeat') return false;
    callback({ ok: false, error: 'Extension context invalidated' });
    return true;
  } });
  const run = await f.start();
  await f.api.toggleManualRunPause();
  const pending = f.api.sendExtensionMessage({ type: 'douhot:syncWorksFeishu', payload: { works: [work(IDS[0])] } });
  f.intervals.values().next().value();
  await assert.rejects(pending, /任务连接已中断/);
  assert.equal(f.trace.messages.length, 0);
  assert.equal(f.pauseButton.disabled, true);
  await f.api.finishManualRun(run);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.api.getRun(), null);
});

test('late parallel media responses after a lost run cannot restart unscoped fallback requests', async () => {
  const replies = [];
  const f = fixture({
    onControl: (_self, message, callback) => {
      if (message.payload.action !== 'heartbeat') return false;
      callback({ ok: false, error: 'Extension context invalidated' });
      return true;
    },
    onMessage: (_self, message, callback) => {
      if (message.type !== 'douhot:fetchDouyinApiJson') return false;
      replies.push(callback);
      return true;
    },
  });
  const works = Array.from({ length: 5 }, (_, index) => work(String(BigInt(IDS[0]) + BigInt(index))));
  f.emit({ hasMore: false, works });
  const pending = f.api.runWorksExtractor({ sync: true, transcribe: true });
  await drain();
  assert.equal(replies.length, 3, 'the real media preparation path has three parallel workers');
  f.intervals.values().next().value();
  await drain();
  replies[0]({ ok: true, data: { aweme_detail: works[0] } });
  await assert.rejects(pending, /任务连接已中断/);
  assert.equal(f.api.getRun(), null);
  // The remaining requests were already issued before the failure. They can
  // finish later, but their workers must remain associated with the ended run.
  replies[1]({ ok: true, data: { aweme_detail: works[1] } });
  replies[2]({ ok: true, data: { aweme_detail: works[2] } });
  await drain();
  assert.equal(f.trace.network.length, 0, 'a late response must not start a direct fallback after cleanup');
  assert.equal(f.trace.messages.length, 3, 'an ended worker must not take another item or sync partial work');
});

test('an API retry sleeping when its run ends cannot resume as an unscoped request', async () => {
  let releaseRetry;
  const f = fixture({
    onTimeout: (_self, callback, delay) => {
      assert.equal(delay, 2000);
      releaseRetry = callback;
      return true;
    },
    onMessage: (_self, message, callback) => {
      assert.equal(message.type, 'douhot:fetchDouyinApiJson');
      callback({ ok: false, error: 'HTTP 403' });
      return true;
    },
  });
  const run = await f.start();
  const pending = f.api.fetchDouyinApiJson(new URL('https://www.douyin.com/aweme/v1/web/aweme/post/'), '主页接口', 2);
  await drain();
  assert.equal(typeof releaseRetry, 'function');
  assert.equal(f.trace.messages.length, 1);
  await f.api.finishManualRun(run);
  releaseRetry();
  await assert.rejects(pending, /任务已结束/);
  assert.equal(f.trace.messages.length, 1);
  assert.deepEqual(f.trace.network, []);
});

test('a failed run clears the heartbeat and restores controls for the next run', async () => {
  const f = fixture();
  f.emit({ truncated: true });
  await assert.rejects(f.api.runWorksExtractor({ sync: true }), /数据不完整/);
  assert.equal(f.api.getRun(), null);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.pauseButton.disabled, true);
  assert.equal(f.nodes.get('.douhot-extractor-works').disabled, false);
  assert.deepEqual(f.trace.messages, []);
  const next = await f.start();
  assert.equal(f.pauseButton.disabled, false);
  await f.api.finishManualRun(next);
});
