// Runs the actual background sync loop against local Feishu response fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function event() {
  const listeners = new Set();
  return { listeners, addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => { for (const fn of [...listeners]) fn(...args); } };
}

function fixture({ onFetch } = {}) {
  const timers = new Map();
  let timerId = 0;
  const requests = [];
  const writes = [];
  const chrome = {
    runtime: { onMessage: event(), onInstalled: event(), onStartup: event() },
    alarms: { create() {}, onAlarm: event() },
    tabs: { onRemoved: event(), onUpdated: event() },
    storage: { local: {
      get: async (defaults) => ({ ...defaults, feishu: { personalBaseToken: 'fixture-token', appToken: 'base', tableId: 'table', autoCreateFields: false } }),
      set: async () => {},
    } },
  };
  const context = vm.createContext({
    chrome, URL, URLSearchParams, console, AbortController,
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, options) => {
      const request = { url, ...options };
      requests.push(request);
      const override = onFetch ? await onFetch(request, api) : null;
      if (override) return override;
      let data;
      if (options.method === 'GET' && /\/tables\?/.test(url)) {
        data = { items: [{ table_id: 'works', name: '竞品达人视频数据' }] };
      } else if (options.method === 'GET' && /\/fields\?/.test(url)) {
        data = { items: [{ field_name: '标题', field_id: 'title', type: 1 }, { field_name: '视频链接', field_id: 'link', type: 1 }] };
      } else if (options.method === 'GET' && /\/records\?/.test(url)) {
        data = { items: [] };
      } else if (options.method === 'POST' && /\/records$/.test(url)) {
        writes.push(JSON.parse(options.body).fields);
        data = { record: { record_id: `record-${writes.length}` } };
      } else {
        throw new Error(`Unexpected request ${options.method} ${url}`);
      }
      return { ok: true, json: async () => ({ code: 0, data }) };
    },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../background.js'), 'utf8'), context);
  const api = context;
  return {
    api, chrome, timers, requests, writes,
    control: (action, runId = 'test-run-1', tabId = 11) => api.controlManualRun({ action, runId }, tabId),
    run: (runId = 'test-run-1', tabId = 11) => api.getManualRun(runId, tabId),
    size: () => vm.runInContext('manualRuns.size', context),
    send: (message, tabId = 11) => new Promise((resolve) => chrome.runtime.onMessage.emit(message, { tab: { id: tabId } }, resolve)),
  };
}

const sample = { creatorName: 'fixture', works: [
  { title: 'first', videoLink: 'https://www.douyin.com/video/1111111111111111111' },
  { title: 'second', videoLink: 'https://www.douyin.com/video/2222222222222222222' },
] };

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('pause during the first write stops the real record loop, then resumes without duplicate writes', async () => {
  let paused = false;
  const f = fixture({ onFetch(request, api) {
    if (!paused && request.method === 'POST' && /\/records$/.test(request.url)) {
      paused = true;
      api.controlManualRun({ action: 'pause', runId: 'test-run-1' }, 11);
    }
  } });
  f.control('start');
  const result = f.api.syncWorksFeishu(sample, f.run());
  let finished = false;
  result.then(() => { finished = true; });
  await nextTurn();
  assert.deepEqual(f.writes.map((fields) => fields['标题']), ['first']);
  assert.equal(finished, false);
  const pausedRequestCount = f.requests.length;
  await nextTurn();
  assert.equal(f.requests.length, pausedRequestCount);
  f.control('resume');
  assert.equal((await result).created, 2);
  assert.deepEqual(f.writes.map((fields) => fields['标题']), ['first', 'second']);
  f.control('finish');
  assert.equal(f.size(), 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.chrome.tabs.onUpdated.listeners.size, 0);
  assert.equal(f.chrome.tabs.onRemoved.listeners.size, 0);
});

test('a paused run blocks schema/list operations as well as writes', async () => {
  const f = fixture();
  f.control('start');
  f.control('pause');
  const result = f.api.syncWorksFeishu(sample, f.run());
  await nextTurn();
  assert.equal(f.requests.length, 0);
  f.control('resume');
  assert.equal((await result).created, 2);
  f.control('finish');
});

test('same run ID in another tab and unscoped monitor sync remain independent', async () => {
  const f = fixture();
  f.control('start');
  f.control('pause');
  f.control('start', 'test-run-1', 22);
  assert.equal((await f.api.syncWorksFeishu(sample, f.run('test-run-1', 22))).created, 2);
  assert.equal((await f.api.syncWorksFeishu(sample)).created, 2);
  assert.equal(f.run().paused, true);
  assert.throws(() => f.api.getManualRun('test-run-1', 33), /失效/);
  f.control('finish', 'test-run-1', 22);
  f.control('finish');
});

test('finish releases a paused sync with an error and never starts a request', async () => {
  const f = fixture();
  f.control('start');
  f.control('pause');
  const result = f.api.syncWorksFeishu(sample, f.run());
  const rejected = assert.rejects(result, /任务已结束/);
  await nextTurn();
  f.control('finish');
  await rejected;
  assert.equal(f.requests.length, 0);
  assert.equal(f.size(), 0);
  assert.equal(f.timers.size, 0);
});

test('heartbeat renews the lease without resuming; expired paused tasks are released', async () => {
  const f = fixture();
  f.control('start');
  const firstTimer = f.run().leaseTimer;
  f.control('pause');
  f.control('heartbeat');
  assert.equal(f.run().paused, true);
  assert.equal(f.timers.has(firstTimer), false);
  const result = f.api.manualRunCheckpoint(f.run());
  const rejected = assert.rejects(result, /页面已断开/);
  [...f.timers.values()][0]();
  await rejected;
  assert.equal(f.size(), 0);
  assert.equal(f.timers.size, 0);
  assert.throws(() => f.control('resume'), /失效/);
});

test('tab close and page reload abort the run and clean up all listeners', async () => {
  for (const navigation of [false, true]) {
    const f = fixture();
    f.control('start');
    f.control('pause');
    const run = f.run();
    const result = f.api.manualRunCheckpoint(run);
    const rejected = assert.rejects(result, /页面已关闭|页面已刷新/);
    if (navigation) f.chrome.tabs.onUpdated.emit(11, { status: 'loading' });
    else f.chrome.tabs.onRemoved.emit(11);
    await rejected;
    assert.equal(run.abortController.signal.aborted, true);
    assert.equal(f.size(), 0);
    assert.equal(f.chrome.tabs.onRemoved.listeners.size, 0);
    assert.equal(f.chrome.tabs.onUpdated.listeners.size, 0);
  }
});

test('runtime messages require the matching started run and pause before issuing Feishu requests', async () => {
  const f = fixture();
  const missing = await f.send({ type: 'douhot:syncWorksFeishu', runId: 'missing-run', payload: sample });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /失效/);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.send({ type: 'douhot:manualRunControl', payload: { action: 'start', runId: 'test-run-1' } })).ok, true);
  f.control('pause');
  const result = f.send({ type: 'douhot:syncWorksFeishu', runId: 'test-run-1', payload: sample });
  await nextTurn();
  assert.equal(f.requests.length, 0);
  f.control('resume');
  assert.equal((await result).data.created, 2);
  f.control('finish');
});

test('comment retries wait at the next request after pause', async () => {
  let count = 0;
  const f = fixture({ onFetch(_request, api) {
    count += 1;
    if (count === 1) api.controlManualRun({ action: 'pause', runId: 'test-run-1' }, 11);
    return { ok: true, text: async () => JSON.stringify({ comments: [] }) };
  } });
  f.control('start');
  const result = f.api.fetchDouyinTopComments('1111111111111111111', '', '', 11, f.run());
  await nextTurn();
  assert.equal(count, 1);
  f.control('resume');
  await result;
  assert.ok(count > 1);
  f.control('finish');
});

test('failed media API lookup cannot open the fallback tab while paused', async () => {
  const f = fixture();
  let fallbackCalls = 0;
  f.control('start');
  f.api.fetchDouyinWorkForTranscription = async () => {
    f.control('pause');
    throw new Error('fixture API failure');
  };
  f.api.resolveDouyinDetailMediaWork = async () => { fallbackCalls += 1; return { awemeId: '1111111111111111111' }; };
  const result = f.api.resolveDouyinWorkForTranscription('1111111111111111111', '', f.run());
  await nextTurn();
  assert.equal(fallbackCalls, 0);
  f.control('resume');
  await result;
  assert.equal(fallbackCalls, 1);
  f.control('finish');
});
