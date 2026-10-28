// Run with: node --test tests/profile-batch.test.cjs
// Exercise the real profile cache, collection, normalization and selection path.
// Native response messages are simulated; network, tabs and Feishu are never used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CREATOR = 'MS4wLjABAAAA_fixture_creator_01';
const OTHER_CREATOR = 'MS4wLjABAAAA_fixture_creator_02';
const IDS = ['7561234567890123456', '7561234567890123457', '7561234567890123458', '7561234567890123459'];
const plain = (value) => JSON.parse(JSON.stringify(value));

function work(id, values = {}) {
  return {
    aweme_id: id,
    desc: `作品 ${id}`,
    author: { sec_uid: CREATOR, nickname: '测试作者' },
    create_time: Date.parse('2026-09-10T12:00:00+08:00') / 1000,
    statistics: { digg_count: 10, comment_count: 2, collect_count: 3, share_count: 4 },
    ...values,
  };
}

function fixture({ onScroll, onSleep, onReplay } = {}) {
  const listeners = [];
  const trace = { scrolls: 0, sleeps: [], network: [], messages: [], controls: [], replays: [], statuses: [] };
  const statusNode = {
    dataset: {},
    set textContent(value) { trace.statuses.push(value); },
  };
  const pauseButton = { disabled: true, textContent: '', dataset: {}, setAttribute() {} };
  const panel = {
    querySelector: (selector) => selector === '.douhot-extractor-pause' ? pauseButton : statusNode,
    querySelectorAll: () => [],
  };
  const document = {
    title: '测试作者的主页 - 抖音',
    body: {},
    documentElement: { scrollHeight: 9000 },
    getElementById: (id) => id === 'douhot-creator-extractor-panel' ? panel : null,
    // No cards remain mounted: the batch must come from accumulated responses.
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  let fixtureApi;
  const window = {
    douhotCreatorExtractor: {},
    addEventListener: (type, listener) => { assert.equal(type, 'message'); listeners.push(listener); },
    postMessage: (message, origin) => {
      trace.replays.push({ message, origin });
      onReplay?.(fixtureApi, message);
    },
    scrollTo: () => { trace.scrolls += 1; onScroll?.(fixtureApi, trace.scrolls); },
    setTimeout: (callback, delay) => {
      trace.sleeps.push(delay);
      onSleep?.(fixtureApi, delay, trace.sleeps.length);
      queueMicrotask(callback);
      return trace.sleeps.length;
    },
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const context = vm.createContext({
    window, document, URL, URLSearchParams, console,
    location: new URL(`https://www.douyin.com/user/${CREATOR}`),
    fetch: (url) => {
      trace.network.push(String(url));
      throw new Error('Batch collection must not request a separate list or detail endpoint');
    },
    chrome: {
      runtime: {
        id: 'fixture-extension',
        lastError: null,
        sendMessage: (message, callback) => {
          if (message.type === 'douhot:manualRunControl') {
            trace.controls.push(plain(message));
            callback({ ok: true, data: { runId: message.payload.runId, paused: message.payload.action === 'pause' } });
            return;
          }
          trace.messages.push(plain(message));
          assert.equal(message.type, 'douhot:syncWorksFeishu', 'no detail, media or temporary-tab requests');
          callback({ ok: true, data: { total: message.payload.works.length, created: message.payload.works.length, updated: 0 } });
        },
      },
      tabs: {
        create: () => { throw new Error('Batch collection must not open work tabs'); },
        update: () => { throw new Error('Batch collection must not navigate work tabs'); },
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'douyin-profile-cache.js'), 'utf8'), context);
  const source = fs.readFileSync(path.join(ROOT, 'douhot-extractor.user.js'), 'utf8');
  const boot = source.indexOf('  window.douhotCreatorExtractor =');
  assert.ok(boot > 0, 'content-script bootstrap boundary exists');
  vm.runInContext(source.slice(0, boot) + `
    globalThis.api = { collectNativeDouyinProfileWorks, fetchDouyinCreatorWorks,
      runWorksExtractor, normalizeWork, applyWorksSelection };
  })();`, context);
  const emit = (page = {}) => {
    const data = {
      source: 'douhot:profile-capture:v1', type: 'page', creatorId: CREATOR,
      cursor: '0', nextCursor: '10', hasMore: true,
      capturedAt: 100, works: [work(IDS[0])], ...page,
    };
    for (const listener of listeners) {
      listener({ source: window, origin: context.location.origin, data });
    }
  };
  fixtureApi = {
    api: context.api, context, trace, emit,
    navigate: (href) => { context.location = new URL(href); },
    collect: (options = {}) => context.api.collectNativeDouyinProfileWorks(CREATOR, options),
    run: (options = {}) => context.api.runWorksExtractor({ sync: true, ...options }),
  };
  return fixtureApi;
}

function assertNoDetailRequests(f) {
  assert.deepEqual(f.trace.network, []);
  assert.ok(f.trace.messages.every((message) => message.type === 'douhot:syncWorksFeishu'));
}

test('complete native pages sync as one batch without detail requests or mounted cards', async () => {
  const f = fixture({ onScroll: (self) => self.emit({ cursor: '10', capturedAt: 200, hasMore: false, works: [work(IDS[1])] }) });
  f.emit();
  const result = await f.run();
  assert.deepEqual(plain(result.works.map((item) => item.awemeId)), IDS.slice(0, 2));
  assert.equal(f.trace.scrolls, 1);
  assert.equal(f.trace.messages.length, 1);
  assert.equal(f.trace.messages[0].payload.works.length, 2);
  assert.equal(result.includeComments, false);
  assert.equal(result.transcriptionRequested, false);
  assertNoDetailRequests(f);
});

test('asynchronous first-page replay is awaited before deciding the cache is empty', async () => {
  const f = fixture({ onSleep: (self, delay, count) => {
    if (count === 2) self.emit({ hasMore: false });
  } });
  const result = await f.collect();
  assert.equal(result.length, 1);
  assert.deepEqual(f.trace.sleeps, [250, 250]);
  assert.equal(f.trace.replays[0].message.creatorId, CREATOR);
  assert.equal(f.trace.scrolls, 0);
  assertNoDetailRequests(f);
});

test('a captured terminal page without the first page cannot sync a partial batch', async () => {
  const f = fixture();
  f.emit({ cursor: '10', capturedAt: 200, hasMore: false, works: [work(IDS[1])] });
  await assert.rejects(f.run(), /首批作品/);
  assert.equal(f.trace.messages.length, 0);
  assert.equal(f.trace.scrolls, 0);
  assertNoDetailRequests(f);
});

test('a first page with a missing terminal page stops without writing partial data', async () => {
  const f = fixture();
  f.emit();
  await assert.rejects(f.run(), /尚未加载完整.*已读取 1 条/);
  assert.ok(f.trace.scrolls > 0 && f.trace.scrolls < 20);
  assert.equal(f.trace.messages.length, 0);
  assertNoDetailRequests(f);
});

test('a missing middle page cannot be bypassed by a later terminal response', async () => {
  const f = fixture();
  f.emit();
  f.emit({ cursor: '20', capturedAt: 300, hasMore: false, works: [work(IDS[2])] });
  await assert.rejects(f.run(), /尚未加载完整/);
  assert.equal(f.trace.messages.length, 0);
  assertNoDetailRequests(f);
});

test('switching authors while waiting for the first page aborts', async () => {
  const f = fixture({ onSleep: (self) => self.navigate(`https://www.douyin.com/user/${OTHER_CREATOR}`) });
  await assert.rejects(f.run(), /切换了达人主页/);
  assert.equal(f.trace.messages.length, 0);
  assertNoDetailRequests(f);
});

test('switching authors or leaving the profile during pagination aborts before sync', async () => {
  for (const href of [`https://www.douyin.com/user/${OTHER_CREATOR}`, `https://www.douyin.com/video/${IDS[0]}`]) {
    const f = fixture({ onScroll: (self) => {
      self.emit({ cursor: '10', capturedAt: 200, hasMore: false, works: [work(IDS[1])] });
      self.navigate(href);
    } });
    f.emit();
    await assert.rejects(f.run(), /切换了达人主页/);
    assert.equal(f.trace.messages.length, 0);
    assertNoDetailRequests(f);
  }
});

test('malformed or foreign-author native work marks the batch incomplete', async () => {
  const f = fixture();
  f.emit({ hasMore: false, works: [work(IDS[0]), work(IDS[1], { author: { sec_uid: OTHER_CREATOR } })] });
  await assert.rejects(f.run(), /作品数据不完整/);
  assert.equal(f.trace.messages.length, 0);
  assertNoDetailRequests(f);
});

test('top-N by likes or comments considers later pages instead of stopping at the limit', async () => {
  for (const sort of ['like_desc', 'comment_desc']) {
    const f = fixture({ onScroll: (self) => self.emit({
      cursor: '10', capturedAt: 200, hasMore: false,
      works: [work(IDS[1], { statistics: { digg_count: 999, comment_count: 777 } })],
    }) });
    f.emit();
    const result = await f.run({ sort, limit: 1 });
    assert.equal(result.works.length, 1);
    assert.equal(result.works[0].awemeId, IDS[1]);
    assert.equal(f.trace.scrolls, 1);
    assertNoDetailRequests(f);
  }
});

test('date and like filters apply to the full batch before a default-order limit', async () => {
  const f = fixture({ onScroll: (self) => self.emit({
    cursor: '10', capturedAt: 200, hasMore: false,
    works: [
      work(IDS[2], { statistics: { digg_count: 500, comment_count: 8 } }),
      work(IDS[3], { statistics: { digg_count: 1000, comment_count: 9 } }),
    ],
  }) });
  // An old pinned post does not prove that all following pages predate the filter.
  f.emit({ works: [
    work(IDS[0], { create_time: Date.parse('2020-01-01T12:00:00+08:00') / 1000, statistics: { digg_count: 9000, comment_count: 90 } }),
    work(IDS[1], { statistics: { digg_count: 1, comment_count: 1 } }),
  ] });
  const result = await f.run({ dateStart: '2026-09-01', dateEnd: '2026-09-15', likeMin: 100, limit: 1 });
  assert.equal(result.works.length, 1);
  assert.equal(result.works[0].awemeId, IDS[2]);
  assert.equal(f.trace.scrolls, 1);
  assertNoDetailRequests(f);
});

test('missing metrics stay null, known zero survives, and no details are fetched to fill gaps', async () => {
  const f = fixture();
  f.emit({ hasMore: false, works: [
    work(IDS[0], { statistics: {} }),
    work(IDS[1], { statistics: { digg_count: 0, comment_count: 0 } }),
  ] });
  const result = await f.run();
  assert.equal(result.works[0].likeCount, null);
  assert.equal(result.works[0].commentCount, null);
  assert.equal(result.works[0].shareCount, null);
  assert.equal(result.works[1].likeCount, 0);
  assert.equal(result.works[1].commentCount, 0);
  assert.match(result.collectionWarning, /1 条作品.*保留为空/);
  assert.equal(f.trace.messages[0].payload.works[0].likeCount, null);
  assertNoDetailRequests(f);
});

test('unknown metrics prevent inaccurate ranking or threshold filtering instead of becoming zero', async () => {
  for (const options of [{ sort: 'like_desc' }, { sort: 'comment_desc' }, { likeMin: 1 }]) {
    const f = fixture();
    f.emit({ hasMore: false, works: [
      work(IDS[0], { statistics: {} }),
      work(IDS[1], { statistics: { digg_count: 0, comment_count: 0 } }),
    ] });
    await assert.rejects(f.run({ ...options, limit: 1 }), /缺少(?:点赞|评论)数/);
    assert.equal(f.trace.messages.length, 0);
    assertNoDetailRequests(f);
  }
});

test('known zero is valid for ranking and missing metrics outside the date range do not block it', async () => {
  const f = fixture();
  f.emit({ hasMore: false, works: [
    work(IDS[0], { statistics: {}, create_time: Date.parse('2020-01-01T12:00:00+08:00') / 1000 }),
    work(IDS[1], { statistics: { digg_count: 0, comment_count: 0 } }),
  ] });
  const result = await f.run({ dateStart: '2026-09-01', sort: 'like_desc', limit: 1 });
  assert.equal(result.works.length, 1);
  assert.equal(result.works[0].awemeId, IDS[1]);
  assert.equal(result.works[0].likeCount, 0);
  assertNoDetailRequests(f);
});

const localSeconds = (date, time = '12:00:00') => new Date(`${date}T${time}`).getTime() / 1000;
const dateCursor = (date) => String(localSeconds(date));
const extraId = (index) => String(7561234567890123500n + BigInt(index));
const datedWork = (index, date, values = {}) => work(extraId(index), { create_time: localSeconds(date), ...values });

test('a month range stops at its first fully covered native page without exhausting the profile', async () => {
  const firstCursor = dateCursor('2026-09-01');
  const secondCursor = dateCursor('2026-08-18');
  const f = fixture({ onScroll: (self, count) => {
    if (count === 1) self.emit({ cursor: firstCursor, nextCursor: secondCursor, capturedAt: 200,
      works: [datedWork(3, '2026-08-25'), datedWork(4, '2026-08-18')] });
    if (count === 2) self.emit({ cursor: secondCursor, nextCursor: dateCursor('2026-08-16'), capturedAt: 300,
      works: [datedWork(5, '2026-08-17', { create_time: localSeconds('2026-08-17', '00:00:00') }), datedWork(6, '2026-08-16')] });
  } });
  f.emit({ nextCursor: firstCursor, works: [datedWork(0, '2026-09-18'),
    datedWork(1, '2026-09-17', { create_time: localSeconds('2026-09-17', '23:59:59') }), datedWork(2, '2026-09-01')] });
  const result = await f.run({ dateStart: '2026-08-17', dateEnd: '2026-09-17' });
  assert.deepEqual(plain(result.works.map((item) => item.awemeId)), [1, 2, 3, 4, 5].map(extraId));
  assert.equal(f.trace.scrolls, 2, 'no native pages after the date boundary are requested');
  assert.match(result.collectionSummary, /所选日期已读齐，读取 7 条后停止翻页/);
  assert.equal(f.trace.messages.length, 1);
  assert.deepEqual(f.trace.messages[0].payload.works.map((item) => item.awemeId), [1, 2, 3, 4, 5].map(extraId));
  assertNoDetailRequests(f);
});

test('an already covered date range returns from cache without scrolling', async () => {
  const f = fixture();
  f.emit({ nextCursor: dateCursor('2026-08-16'), works: [datedWork(0, '2026-09-17'), datedWork(1, '2026-08-16')] });
  const result = await f.run({ dateStart: '2026-08-17', dateEnd: '2026-09-17' });
  assert.deepEqual(plain(result.works.map((item) => item.awemeId)), [extraId(0)]);
  assert.equal(f.trace.scrolls, 0);
  assertNoDetailRequests(f);
});

test('old pinned or co-created posts cannot alone prove that the month is covered', async () => {
  for (const values of [{ is_top: true }, { is_top: 1 }, { is_top: '1' },
    { author: { sec_uid: OTHER_CREATOR }, cooperation_info: { co_creators: [{ sec_uid: CREATOR }] } }]) {
    const firstCursor = dateCursor('2026-09-17');
    const oldCursor = dateCursor('2026-08-16');
    const f = fixture({ onScroll: (self, count) => {
      if (count === 1) self.emit({ cursor: firstCursor, nextCursor: oldCursor, capturedAt: 200,
        works: [datedWork(1, '2026-08-16', values)] });
      if (count === 2) self.emit({ cursor: oldCursor, capturedAt: 300, hasMore: false,
        works: [datedWork(2, '2026-08-18')] });
    } });
    f.emit({ nextCursor: firstCursor, works: [datedWork(0, '2026-09-17')] });
    const result = await f.run({ dateStart: '2026-08-17' });
    assert.deepEqual(plain(result.works.map((item) => item.awemeId)), [extraId(0), extraId(2)]);
    assert.equal(f.trace.scrolls, 2);
    assertNoDetailRequests(f);
  }
});

test('an old disconnected response cannot cover a missing middle page', async () => {
  const f = fixture();
  f.emit({ nextCursor: dateCursor('2026-09-01'), works: [datedWork(0, '2026-09-17')] });
  f.emit({ cursor: dateCursor('2026-08-18'), nextCursor: dateCursor('2026-08-16'), capturedAt: 300,
    works: [datedWork(1, '2026-08-16')] });
  await assert.rejects(f.run({ dateStart: '2026-08-17' }), /尚未加载完整/);
  assert.equal(f.trace.messages.length, 0);
  assertNoDetailRequests(f);
});

test('missing ordinary dates or reversed chronological order disable date early stopping', async () => {
  for (const middle of [
    [datedWork(1, '2026-08-25', { create_time: undefined }), datedWork(2, '2026-08-16')],
    [datedWork(1, '2026-08-16'), datedWork(2, '2026-08-18'), datedWork(3, '2026-08-15')],
  ]) {
    const firstCursor = dateCursor('2026-09-01');
    const oldCursor = dateCursor('2026-08-15');
    const f = fixture({ onScroll: (self, count) => {
      if (count === 1) self.emit({ cursor: firstCursor, nextCursor: oldCursor, capturedAt: 200, works: middle });
      if (count === 2) self.emit({ cursor: oldCursor, capturedAt: 300, hasMore: false, works: [] });
    } });
    f.emit({ nextCursor: firstCursor, works: [datedWork(0, '2026-09-17')] });
    await f.run({ dateStart: '2026-08-17' });
    assert.equal(f.trace.scrolls, 2, 'ambiguous dates require the genuine end of the profile');
    assertNoDetailRequests(f);
  }
});

test('an opaque cursor or cursor still at the start date cannot prove date coverage', async () => {
  for (const nextCursor of ['10', '1234567890123456789', String(localSeconds('2026-08-17', '00:00:00'))]) {
    const f = fixture({ onScroll: (self) => self.emit({ cursor: nextCursor, capturedAt: 200, hasMore: false, works: [] }) });
    f.emit({ nextCursor, works: [datedWork(0, '2026-09-17'), datedWork(1, '2026-08-16')] });
    await f.run({ dateStart: '2026-08-17' });
    assert.equal(f.trace.scrolls, 1);
    assertNoDetailRequests(f);
  }
});

test('millisecond timestamp cursors also allow a covered date range to stop', async () => {
  const f = fixture();
  f.emit({ nextCursor: String(localSeconds('2026-08-16') * 1000),
    works: [datedWork(0, '2026-09-17'), datedWork(1, '2026-08-16')] });
  await f.run({ dateStart: '2026-08-17' });
  assert.equal(f.trace.scrolls, 0);
  assertNoDetailRequests(f);
});

test('date-bounded like and comment rankings wait for all in-range works before applying the limit', async () => {
  for (const sort of ['like_desc', 'comment_desc']) {
    const firstCursor = dateCursor('2026-09-01');
    const f = fixture({ onScroll: (self, count) => {
      assert.equal(count, 1, 'the page crossing the start date is sufficient');
      self.emit({ cursor: firstCursor, nextCursor: dateCursor('2026-08-16'), capturedAt: 200,
        works: [datedWork(1, '2026-08-20', { statistics: { digg_count: 999, comment_count: 777 } }),
          datedWork(2, '2026-08-16', { statistics: { digg_count: 9999, comment_count: 7777 } })] });
    } });
    f.emit({ nextCursor: firstCursor, works: [datedWork(0, '2026-09-17')] });
    const result = await f.run({ dateStart: '2026-08-17', dateEnd: '2026-09-17', sort, limit: 1 });
    assert.deepEqual(plain(result.works.map((item) => item.awemeId)), [extraId(1)]);
    assert.equal(f.trace.scrolls, 1);
    assertNoDetailRequests(f);
  }
});

test('a date-bounded like threshold is applied after the range is fully covered', async () => {
  const firstCursor = dateCursor('2026-09-01');
  const f = fixture({ onScroll: (self) => self.emit({ cursor: firstCursor, nextCursor: dateCursor('2026-08-16'),
    capturedAt: 200, works: [datedWork(1, '2026-08-20', { statistics: { digg_count: 500, comment_count: 20 } }),
      datedWork(2, '2026-08-16', { statistics: { digg_count: 9999, comment_count: 99 } })] }) });
  f.emit({ nextCursor: firstCursor, works: [datedWork(0, '2026-09-17')] });
  const result = await f.run({ dateStart: '2026-08-17', likeMin: 100, limit: 1 });
  assert.deepEqual(plain(result.works.map((item) => item.awemeId)), [extraId(1)]);
  assert.equal(f.trace.scrolls, 1);
  assertNoDetailRequests(f);
});

test('without a start date the collector still reads the genuine last page', async () => {
  for (const options of [{}, { dateEnd: '2026-09-17' }]) {
    const oldCursor = dateCursor('2026-08-16');
    const f = fixture({ onScroll: (self) => self.emit({ cursor: oldCursor, capturedAt: 200, hasMore: false,
      works: [datedWork(2, '2026-08-15')] }) });
    f.emit({ nextCursor: oldCursor, works: [datedWork(0, '2026-09-17'), datedWork(1, '2026-08-16')] });
    const result = await f.run(options);
    assert.equal(result.works.length, 3);
    assert.equal(f.trace.scrolls, 1);
    assertNoDetailRequests(f);
  }
});
