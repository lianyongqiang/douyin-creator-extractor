// Run with node --test tests/profile-capture.test.cjs (no network/browser account).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'douyin-profile-capture.js'), 'utf8');
const ORIGIN = 'https://www.douyin.com';
const CREATOR = 'MS4wLjABAAAAtarget-creator';
const OTHER = 'MS4wLjABAAAAanother-creator';
const ID = '7561234567890123456';
const endpoint = (creator = CREATOR, cursor = '0') => `${ORIGIN}/aweme/v1/web/aweme/post/?sec_user_id=${creator}&max_cursor=${cursor}`;
const raw = (id = ID, creator = CREATOR) => ({
  aweme_id: id, desc: '作品描述', author: { sec_uid: creator, uid: '12345678', nickname: '作者', private_email: 'omit' },
  create_time: 1700000000, aweme_type: 0, statistics: { digg_count: 23, comment_count: 4, secret: 'omit' },
  video: { duration: 10000, play_addr: { uri: 'v020video', url_list: ['https://v3.douyinvod.com/video.mp4'], credentials: 'omit' } },
  secret: 'omit',
});
const body = (works = [raw()], next = '20', has = true) => ({ status_code: 0, aweme_list: works, max_cursor: next, has_more: has });

function fixture(options = {}) {
  const messages = [];
  const notifications = [];
  const listeners = new Map();
  const calls = [];
  let responseData = options.data || body();
  let cloneCount = 0;
  let currentPromise;
  let currentResponse;
  let clock = 1000;
  class XHR {
    constructor() { this.listeners = new Map(); this.status = 200; this.responseType = ''; this.responseURL = ''; }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    emit(type) { for (const listener of [...(this.listeners.get(type) || [])]) listener.call(this, { target: this }); }
    open(...args) { this.openArgs = args; this.responseURL = String(args[1]); return 'open-result'; }
    send(...args) {
      this.sendArgs = args;
      if (options.xhrError) throw options.xhrError;
      if (options.xhrSynchronous) this.complete();
      return 'send-result';
    }
    complete(data = responseData) {
      this.response = data;
      this.responseText = typeof data === 'string' ? data : JSON.stringify(data);
      this.emit('load'); this.emit('loadend');
    }
    abort() { this.emit('abort'); this.emit('loadend'); }
  }
  const window = {
    XMLHttpRequest: XHR,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
    postMessage(data, targetOrigin) {
      notifications.push({ data, targetOrigin });
      // Most assertions concern response pages; pending invalidations are tested
      // separately via notifications, which retains every actual postMessage.
      if (!data.pending) messages.push({ data, targetOrigin });
    },
    fetch(...args) {
      calls.push({ self: this, args });
      if (options.syncError) throw options.syncError;
      const input = args[0];
      const dataAtRequest = responseData;
      currentResponse = {
        ok: true, url: options.responseUrl || (typeof input === 'string' ? new URL(input, ORIGIN).href : input.url),
        clone() { cloneCount++; if (options.cloneError) throw options.cloneError; return {
          text: () => options.readError ? Promise.reject(options.readError)
            : Promise.resolve(typeof dataAtRequest === 'string' ? dataAtRequest : JSON.stringify(dataAtRequest)),
        }; },
      };
      currentPromise = options.fetchError ? Promise.reject(options.fetchError) : Promise.resolve(currentResponse);
      return currentPromise;
    },
  };
  const context = vm.createContext({ window, location: new URL(`${ORIGIN}/user/${CREATOR}`), URL,
    console: options.console || { debug() {} },
    Date: { now: () => options.fixedTime ?? clock++ },
  });
  vm.runInContext(SOURCE, context);
  function replay(creatorId = CREATOR, extra = {}) {
    const event = { source: window, origin: ORIGIN, data: { source: 'douhot:profile-reader:v1', type: 'replay', creatorId }, ...extra };
    for (const listener of listeners.get('message') || []) listener(event);
  }
  return { window, messages, notifications, calls, XHR, replay,
    get promise() { return currentPromise; }, get response() { return currentResponse; },
    get clones() { return cloneCount; }, setData(data) { responseData = data; },
    reinstall() { vm.runInContext(SOURCE, context); },
  };
}
async function settle() { await new Promise((resolve) => setImmediate(resolve)); }
async function capture(fixture, data = body(), creator = CREATOR, cursor = '0') {
  fixture.setData(data); await fixture.window.fetch(endpoint(creator, cursor)); await settle();
}

test('fetch preserves promise/response identity, receiver, arguments and request count', async () => {
  const f = fixture();
  const input = { url: endpoint() };
  const options = { method: 'GET', credentials: 'include' };
  const receiver = {};
  const promise = f.window.fetch.call(receiver, input, options);
  assert.equal(promise, f.promise);
  assert.equal(await promise, f.response);
  await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].self, receiver);
  assert.equal(f.calls[0].args[0], input);
  assert.equal(f.calls[0].args[1], options);
  assert.equal(f.clones, 1);
  assert.equal(f.messages.length, 1);
  const page = f.messages[0].data;
  assert.equal(page.source, 'douhot:profile-capture:v1');
  assert.equal(page.creatorId, CREATOR);
  assert.equal(page.cursor, '0');
  assert.equal(page.nextCursor, '20');
  assert.equal(page.hasMore, true);
  assert.equal(page.truncated, false);
  assert.equal(page.works[0].video.play_addr.uri, 'v020video');
  assert.equal(f.messages[0].targetOrigin, ORIGIN);
  assert.ok(!JSON.stringify(page).includes('omit'));
});

test('untrusted origins/routes and invalid author requests are not read', async () => {
  const f = fixture();
  for (const url of [endpoint().replace(ORIGIN, 'https://evil.example'),
    endpoint().replace(ORIGIN, 'http://www.douyin.com'),
    endpoint().replace(ORIGIN, 'http://www-hj.douyin.com'),
    endpoint().replace(ORIGIN, 'https://www-hj.douyin.com.evil.example'),
    endpoint().replace(ORIGIN, 'https://unobserved.douyin.com'),
    endpoint().replace(ORIGIN, 'https://www-hj.douyin.com:444'),
    endpoint().replace('/aweme/post/', '/aweme/detail/'),
    `${ORIGIN}/im/messages`, `${ORIGIN}/aweme/v1/web/aweme/post/`, endpoint('short')]) await f.window.fetch(url);
  await settle();
  assert.equal(f.clones, 0);
  assert.equal(f.messages.length, 0);
  const redirected = fixture({ responseUrl: 'https://evil.example/aweme/v1/web/aweme/post/?sec_user_id=' + CREATOR });
  await redirected.window.fetch(endpoint()); await settle();
  assert.equal(redirected.clones, 0);
});

test('native profile pagination across the observed www-hj host retains one author/cursor chain', async () => {
  const f = fixture();
  await capture(f, body([raw()], '20', true));
  const xhr = new f.XHR();
  xhr.open('GET', endpoint(CREATOR, '20').replace(ORIGIN, 'https://www-hj.douyin.com'));
  xhr.send();
  xhr.complete(body([raw('7561234567890123457')], '40', false));
  assert.deepEqual(f.messages.map((m) => [m.data.creatorId, m.data.cursor, m.data.nextCursor]),
    [[CREATOR, '0', '20'], [CREATOR, '20', '40']]);
  assert.equal(f.messages[1].data.hasMore, false);
  assert.equal(f.messages[1].data.truncated, false);
  assert.equal(f.messages[1].targetOrigin, ORIGIN);
  f.messages.length = 0; f.replay();
  assert.deepEqual(f.messages.map((m) => m.data.cursor), ['0', '20']);

  const redirected = fixture({ responseUrl: endpoint().replace(ORIGIN, 'https://www-hj.douyin.com') });
  await redirected.window.fetch(endpoint()); await settle();
  assert.equal(redirected.messages.length, 1);
  const apex = fixture();
  await apex.window.fetch(endpoint().replace(ORIGIN, 'https://douyin.com')); await settle();
  assert.equal(apex.messages.length, 1);
});

test('author mismatch and unsafe numeric IDs are excluded without losing pagination', async () => {
  const f = fixture();
  await capture(f, body([raw(ID, OTHER), raw(Number(ID)), raw()], '100', '0'));
  const page = f.messages[0].data;
  assert.equal(page.works.length, 1);
  assert.equal(page.works[0].aweme_id, ID);
  assert.equal(page.nextCursor, '100');
  assert.equal(page.hasMore, false);
  assert.equal(page.truncated, true);
  await capture(f, { aweme_list: [raw(ID, OTHER)] });
  assert.equal(f.messages[1].data.works.length, 0);
  assert.equal(f.messages[1].data.hasMore, null);
  assert.equal(f.messages[1].data.nextCursor, null);
  assert.equal(f.messages[1].data.truncated, true);
});

test('a native co-creator ID is exact ownership evidence, while unrelated collaborators are rejected', async () => {
  const f = fixture();
  const collaboration = raw(ID, OTHER);
  collaboration.cooperation_info = { tag: '共创', secret: 'omit', co_creators: [
    { sec_uid: CREATOR, uid: '65877015311', private_email: 'omit' },
  ] };
  await capture(f, body([collaboration], '20', false));
  const page = f.messages[0].data;
  assert.equal(page.truncated, false);
  assert.equal(page.works.length, 1);
  assert.equal(page.works[0].author.sec_uid, OTHER);
  assert.equal(page.works[0].cooperation_info.co_creators[0].sec_uid, CREATOR);
  assert.equal(page.works[0].cooperation_info.co_creators[0].uid, '65877015311');
  assert.ok(!JSON.stringify(page).includes('omit'));
  collaboration.cooperation_info.co_creators = [{ sec_uid: `${CREATOR}-different` }];
  await capture(f, body([collaboration], '20', false));
  assert.equal(f.messages[1].data.works.length, 0);
  assert.equal(f.messages[1].data.truncated, true);
  const unknown = raw(); delete unknown.author;
  await capture(f, body([unknown], '20', false));
  assert.equal(f.messages[2].data.works.length, 1);
  assert.equal(f.messages[2].data.truncated, false);
});

test('co-creator transport is capped at 20 but never drops the matched creator identity', async () => {
  const f = fixture(); const collaboration = raw(ID, OTHER);
  collaboration.cooperation_info = { co_creators: [
    ...Array.from({ length: 30 }, (_, index) => ({ sec_uid: `${OTHER}-${index}` })),
    { sec_uid: CREATOR, uid: '65877015311' },
  ] };
  await capture(f, body([collaboration]));
  const selected = f.messages[0].data.works[0].cooperation_info.co_creators;
  assert.equal(selected.length, 20);
  assert.equal(selected[0].sec_uid, CREATOR);
  assert.equal(f.messages[0].data.truncated, false);
});

test('same-window same-origin replay is author scoped and returns independent JSON copies', async () => {
  const f = fixture();
  const data = body();
  await capture(f, data);
  const originalTime = f.messages[0].data.capturedAt;
  data.aweme_list[0].desc = 'changed-page-object';
  f.messages[0].data.works[0].desc = 'changed-recipient-object';
  await capture(f, body([raw(ID, OTHER)]), OTHER);
  f.messages.length = 0;
  f.replay(CREATOR, { origin: 'https://evil.example' });
  f.replay(CREATOR, { source: {} });
  assert.equal(f.messages.length, 0);
  f.replay();
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].data.works[0].desc, '作品描述');
  assert.equal(f.messages[0].data.capturedAt, originalTime);
  assert.equal(f.messages[0].data.creatorId, CREATOR);
});

test('new first page resets old pagination and duplicate cursor is replaced', async () => {
  const f = fixture();
  await capture(f);
  await capture(f, body(), CREATOR, '20');
  await capture(f, body([], '60', false), CREATOR, '20');
  f.messages.length = 0; f.replay();
  assert.deepEqual(f.messages.map((m) => m.data.cursor), ['0', '20']);
  assert.equal(f.messages[1].data.nextCursor, '60');
  await capture(f, body([], '40'));
  f.messages.length = 0; f.replay();
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].data.cursor, '0');
});

test('late responses from an older request generation cannot join the new first page', () => {
  const f = fixture();
  const send = (cursor) => { const xhr = new f.XHR(); xhr.open('GET', endpoint(CREATOR, cursor)); xhr.send(); return xhr; };
  const oldHead = send('0'); oldHead.complete(body([raw()], '20', true));
  const oldTail = send('20');
  const newHead = send('0');
  const pending = f.notifications.at(-1).data;
  assert.equal(pending.pending, true);
  assert.equal(pending.cursor, '0'); assert.equal(pending.hasMore, null);
  assert.equal(pending.truncated, false); assert.equal(pending.works.length, 0);
  assert.ok(pending.capturedAt > f.messages[0].data.capturedAt);
  // Replay while a fresh head is in flight cannot bring back the old cached head.
  f.messages.length = 0; f.replay(); assert.equal(f.messages.length, 0);
  newHead.complete(body([raw('7561234567890123457')], '40', true));
  oldTail.complete(body([raw('7561234567890123458')], '40', false));
  const newTail = send('40'); newTail.complete(body([raw('7561234567890123459')], '80', false));
  assert.deepEqual(f.messages.map((m) => m.data.cursor), ['0', '40']);
  assert.equal(f.messages[0].data.works[0].aweme_id, '7561234567890123457');
  f.messages.length = 0; f.replay();
  assert.deepEqual(f.messages.map((m) => m.data.cursor), ['0', '40']);
});

test('opening without sending does not advance the request generation', () => {
  const f = fixture();
  const head = new f.XHR(); head.open('GET', endpoint()); head.send(); head.complete();
  const tail = new f.XHR(); tail.open('GET', endpoint(CREATOR, '20')); tail.send();
  const unsentHead = new f.XHR(); unsentHead.open('GET', endpoint());
  tail.complete(body([], '40', false));
  assert.deepEqual(f.messages.map((m) => m.data.cursor), ['0', '20']);
});

test('native date-filter requests invalidate the full-profile scope and never read their response', async () => {
  const f = fixture();
  await capture(f, body([raw()], '20', false));
  const oldTail = new f.XHR(); oldTail.open('GET', endpoint(CREATOR, '20')); oldTail.send();
  const clonesBefore = f.clones;
  const promise = f.window.fetch(endpoint() + '&time_list_query=202609');
  assert.equal(promise, f.promise);
  assert.equal(f.messages.length, 2, 'invalidates when sent, before the response');
  const invalidation = f.messages[1].data;
  assert.equal(invalidation.cursor, '0'); assert.equal(invalidation.hasMore, null);
  assert.equal(invalidation.truncated, true); assert.equal(invalidation.works.length, 0);
  await promise; await settle();
  assert.equal(f.clones, clonesBefore);
  oldTail.complete(body([], '40', false));
  assert.equal(f.messages.length, 2);
  await f.window.fetch(endpoint(CREATOR, '40')); await settle();
  assert.equal(f.messages.length, 2, 'an unfiltered tail does not reset the active restricted scope');
  f.messages.length = 0; f.replay(); assert.equal(f.messages.length, 0);
  await f.window.fetch(endpoint() + '&time_list_query=0'); await settle();
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].data.truncated, false);
  assert.equal(f.messages[0].data.works.length, 1);
  assert.equal('generation' in f.messages[0].data, false);
  assert.equal('restricted' in f.messages[0].data, false);
});

test('XHR filtered scopes invalidate without reading their body; empty date query remains unrestricted', () => {
  const f = fixture();
  const filtered = new f.XHR(); filtered.open('GET', endpoint() + '&time_list_query=2026'); filtered.send();
  Object.defineProperty(filtered, 'responseText', { get() { throw new Error('filtered response must not be read'); } });
  filtered.emit('load'); filtered.emit('loadend');
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].data.truncated, true);
  const restored = new f.XHR(); restored.open('GET', endpoint() + '&time_list_query='); restored.send(); restored.complete();
  assert.equal(f.messages.length, 2); assert.equal(f.messages[1].data.truncated, false);
});

test('synchronous XHR delivery is captured after a successful native send', () => {
  const f = fixture({ xhrSynchronous: true });
  const xhr = new f.XHR(); xhr.open('GET', endpoint(), false);
  assert.equal(xhr.send(), 'send-result');
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].data.works.length, 1);
  assert.equal(xhr.listeners.get('load').size, 0);
});

test('different responses in one millisecond get distinct timestamps; replay retains the timestamp', async () => {
  const f = fixture({ fixedTime: 1000 });
  await capture(f);
  await capture(f, body(), CREATOR, '20');
  await capture(f, body([], '40'));
  assert.deepEqual(f.notifications.map((m) => m.data.capturedAt), [1000, 1001, 1002, 1003, 1004]);
  assert.deepEqual(f.messages.map((m) => m.data.capturedAt), [1001, 1002, 1004]);
  f.messages.length = 0; f.replay();
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].data.capturedAt, 1004);
});

test('unavailable diagnostic console cannot suppress captured pages', async () => {
  const f = fixture({ console: {} });
  await capture(f);
  assert.equal(f.messages.length, 1);
});

test('cache evicts old authors and pages at its bounds', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) await capture(f, body([raw(ID, `${CREATOR}${i}`)]), `${CREATOR}${i}`);
  f.messages.length = 0; f.replay(`${CREATOR}0`);
  assert.equal(f.messages.length, 0);
  f.replay(`${CREATOR}1`);
  assert.equal(f.messages.length, 1);
  for (let i = 0; i <= 100; i++) await capture(f, body([], String(i + 1)), CREATOR, String(i));
  f.messages.length = 0; f.replay();
  assert.equal(f.messages.length, 100);
  assert.equal(f.messages[0].data.cursor, '1');
  assert.ok(f.messages.every((message) => message.data.truncated));
});

test('work-count and payload limits are reported as truncated rather than complete empty pages', async () => {
  const f = fixture();
  const oversized = body(Array.from({ length: 5001 }, () => raw()), '0', false);
  await capture(f, oversized);
  assert.equal(f.messages[0].data.truncated, true);
  assert.equal(f.messages[0].data.works.length, 0);
  await capture(f, ' '.repeat(8 * 1024 * 1024 + 1));
  assert.equal(f.messages[1].data.truncated, true);
  assert.equal(f.messages[1].data.hasMore, null);
  const manyWorks = body(Array.from({ length: 2600 }, (_, index) => raw(String(BigInt(ID) + BigInt(index)))));
  await capture(f, manyWorks);
  await capture(f, manyWorks, CREATOR, '20');
  f.messages.length = 0; f.replay();
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].data.cursor, '20');
  assert.equal(f.messages[0].data.truncated, true);
  assert.equal(f.messages[0].data.works.length, 2600);
});

test('text is bounded and only selected address/image/statistics fields survive', async () => {
  const f = fixture();
  const item = raw(); item.desc = 'x'.repeat(10000);
  item.images = [{ url_list: ['https://image.example/cover.jpg'], secret: 'omit' }, { secret: 'omit' }];
  item.video.play_addr.url_list.push('blob:https://www.douyin.com/opaque', 'data:abc');
  await capture(f, body([item]));
  const selected = f.messages[0].data.works[0];
  assert.equal(selected.desc.length, 6000);
  assert.equal(selected.images.length, 1);
  assert.equal(selected.video.play_addr.url_list.length, 1);
  assert.ok(!JSON.stringify(selected).includes('omit'));
});

test('XHR text and JSON are read without changing open/send, with abort cleanup', () => {
  const f = fixture();
  for (const responseType of ['', 'text', 'json']) {
    const xhr = new f.XHR(); xhr.responseType = responseType;
    assert.equal(xhr.open('GET', endpoint(), true), 'open-result');
    assert.equal(xhr.send('unchanged-body'), 'send-result');
    assert.deepEqual(xhr.sendArgs, ['unchanged-body']);
    xhr.complete();
    assert.equal(xhr.listeners.get('load').size, 0);
    assert.equal(xhr.listeners.get('loadend').size, 0);
  }
  assert.equal(f.messages.length, 3);
  const xhr = new f.XHR(); xhr.open('GET', endpoint()); xhr.send(); xhr.abort();
  assert.equal(xhr.listeners.get('load').size, 0);
  xhr.complete(); assert.equal(f.messages.length, 3);
  const unrelated = new f.XHR(); unrelated.open('GET', `${ORIGIN}/im/messages`); unrelated.send(); unrelated.complete();
  assert.equal(f.messages.length, 3);
});

test('network errors, parse failures and response read errors do not change native results', async () => {
  const error = new Error('native failure');
  const sync = fixture({ syncError: error });
  assert.throws(() => sync.window.fetch(endpoint()), (actual) => actual === error);
  const rejected = fixture({ fetchError: error });
  const promise = rejected.window.fetch(endpoint());
  assert.equal(promise, rejected.promise);
  await assert.rejects(promise, (actual) => actual === error);
  for (const options of [{ data: '<not-json>' }, { cloneError: error }, { readError: error }]) {
    const f = fixture(options); assert.equal(await f.window.fetch(endpoint()), f.response);
    await settle(); assert.equal(f.messages.length, 0);
  }
  const failedXhr = fixture({ xhrError: error });
  const xhr = new failedXhr.XHR(); xhr.open('GET', endpoint());
  assert.throws(() => xhr.send(), (actual) => actual === error);
  assert.equal(xhr.listeners.get('load').size, 0);
});

test('reinstalling the document_start bridge never stacks hooks', async () => {
  const f = fixture(); const original = f.window.fetch; f.reinstall();
  assert.equal(f.window.fetch, original);
  await capture(f);
  assert.equal(f.messages.length, 1);
  f.messages.length = 0; f.replay();
  assert.equal(f.messages.length, 1);
});
