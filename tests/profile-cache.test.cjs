// Run with: node --test tests/profile-cache.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'douyin-profile-cache.js'), 'utf8');
const CREATOR = 'MS4wLjABAAAA_fixture_creator_01';
const OTHER = 'MS4wLjABAAAA_fixture_creator_02';
const ID = '7561234567890123456';
const ID2 = '7561234567890123457';
const ID3 = '7561234567890123458';
const work = (id = ID, values = {}) => ({ aweme_id: id, author: { sec_uid: CREATOR }, ...values });
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  const listeners = [];
  const messages = [];
  const window = {
    addEventListener: (type, handler) => { assert.equal(type, 'message'); listeners.push(handler); },
    postMessage: (message, origin) => messages.push({ message, origin }),
  };
  const location = new URL('https://www.douyin.com/user/' + CREATOR);
  const context = vm.createContext({ window, location });
  vm.runInContext(SOURCE, context);
  const emit = (data = {}, event = {}) => {
    const message = {
      source: 'douhot:profile-capture:v1', type: 'page', creatorId: CREATOR,
      cursor: '0', nextCursor: '10', hasMore: true, works: [work()], capturedAt: 10,
      ...data,
    };
    for (const listener of listeners) listener({ source: window, origin: location.origin, data: message, ...event });
  };
  return {
    emit, messages, context,
    api: context.douhotProfileCache,
    snapshot: (creatorId = CREATOR) => plain(context.douhotProfileCache.snapshot(creatorId)),
  };
}

test('out-of-order pages join only a continuous chain starting at zero', () => {
  const f = fixture();
  f.emit({ cursor: '10', nextCursor: '20', capturedAt: 20, works: [work(ID2)] });
  f.emit({ cursor: '20', hasMore: false, capturedAt: 30, works: [work(ID3)] });
  assert.deepEqual(f.snapshot(), { works: [], pageCount: 0, headLoaded: false, complete: false, truncated: false });
  f.emit();
  const result = f.snapshot();
  assert.deepEqual(result.works.map((item) => item.aweme_id), [ID, ID2, ID3]);
  assert.equal(result.pageCount, 3);
  assert.equal(result.complete, true);
});

test('a missing middle page prevents terminal pages from making the list complete', () => {
  const f = fixture();
  f.emit();
  f.emit({ cursor: '20', hasMore: false, capturedAt: 30, works: [work(ID3)] });
  assert.equal(f.snapshot().pageCount, 1);
  assert.equal(f.snapshot().complete, false);
  f.emit({ cursor: '10', nextCursor: '20', capturedAt: 20, works: [work(ID2)] });
  assert.equal(f.snapshot().complete, true);
});

test('replaying the same first page never removes later pages', () => {
  const f = fixture();
  f.emit();
  f.emit({ cursor: '10', hasMore: false, capturedAt: 20, works: [work(ID2)] });
  const before = f.snapshot();
  f.emit();
  f.emit({ cursor: '10', hasMore: false, capturedAt: 20, works: [work(ID2)] });
  assert.deepEqual(f.snapshot(), before);
});

test('a new native first page clears the old generation and ignores stale replay', () => {
  const f = fixture();
  f.emit();
  f.emit({ cursor: '10', hasMore: false, capturedAt: 20, works: [work(ID2)] });
  f.emit({ capturedAt: 30, works: [work(ID3)] });
  f.emit();
  f.emit({ cursor: '10', hasMore: false, capturedAt: 20, works: [work(ID2)] });
  assert.deepEqual(f.snapshot().works.map((item) => item.aweme_id), [ID3]);
  assert.equal(f.snapshot().complete, false);
  f.emit({ cursor: '10', hasMore: false, capturedAt: 40, works: [] });
  assert.equal(f.snapshot().complete, true);
});

test('newest duplicate data merge retains media, missing metrics and known zero', () => {
  const f = fixture();
  f.emit({ works: [work(ID, { desc: 'known', statistics: { digg_count: 10, share_count: 0 }, video: { duration: 3000 } })] });
  f.emit({ cursor: '10', hasMore: false, capturedAt: 20, works: [work(ID, { desc: '', statistics: { digg_count: 0, comment_count: 2 } })] });
  const result = f.snapshot();
  assert.equal(result.complete, true);
  assert.equal(result.works.length, 1);
  assert.equal(result.works[0].desc, 'known');
  assert.deepEqual(result.works[0].statistics, { digg_count: 0, share_count: 0, comment_count: 2 });
  assert.deepEqual(result.works[0].video, { duration: 3000 });
  result.works[0].statistics.digg_count = 999;
  assert.equal(f.snapshot().works[0].statistics.digg_count, 0);
});

test('newest timestamps win even when page delivery and cursor order differ', () => {
  const f = fixture();
  f.emit({ works: [work(ID, { statistics: { digg_count: 10 } })] });
  f.emit({ cursor: '20', capturedAt: 20, hasMore: false, works: [work(ID, { statistics: { digg_count: 20 } })] });
  f.emit({ cursor: '10', nextCursor: '20', capturedAt: 30, works: [work(ID, { statistics: { digg_count: 30 } })] });
  assert.equal(f.snapshot().works[0].statistics.digg_count, 30);
});

test('unknown hasMore and empty nonterminal pages never imply completeness', () => {
  const f = fixture();
  f.emit({ works: [], hasMore: null });
  assert.equal(f.snapshot().complete, false);
  f.emit({ works: [], capturedAt: 20 });
  f.emit({ cursor: '10', capturedAt: 30, works: [], hasMore: true });
  assert.equal(f.snapshot().complete, false);
});

test('explicitly terminal empty pages complete a continuous chain', () => {
  const f = fixture();
  f.emit();
  f.emit({ cursor: '10', capturedAt: 20, nextCursor: '10', works: [], hasMore: false });
  assert.equal(f.snapshot().complete, true);
  const empty = fixture();
  empty.emit({ works: [], nextCursor: '0', hasMore: false });
  assert.equal(empty.snapshot().complete, true);
});

test('cursor cycles terminate safely and do not imply completeness', () => {
  const f = fixture();
  f.emit();
  f.emit({ cursor: '10', nextCursor: '0', capturedAt: 20, works: [work(ID2)] });
  assert.equal(f.snapshot().pageCount, 2);
  assert.equal(f.snapshot().complete, false);
  f.emit({ cursor: '10', nextCursor: '10', capturedAt: 30, works: [work(ID2)] });
  assert.equal(f.snapshot().complete, false);
});

test('creator caches are isolated and recommended works cannot enter profile data', () => {
  const f = fixture();
  f.emit({ hasMore: false, works: [work(), work(ID2, { author: { sec_uid: OTHER } })] });
  assert.deepEqual(f.snapshot().works.map((item) => item.aweme_id), [ID]);
  assert.equal(f.snapshot().truncated, true);
  assert.equal(f.snapshot().complete, false);
  f.emit({ creatorId: OTHER, hasMore: false, works: [work(ID2, { author: { sec_uid: OTHER } })] });
  assert.deepEqual(f.snapshot(OTHER).works.map((item) => item.aweme_id), [ID2]);
  const rejectedOnly = fixture();
  rejectedOnly.emit({ hasMore: false, works: [work(ID2, { author: { sec_uid: OTHER } })] });
  assert.equal(rejectedOnly.snapshot().complete, false);
});

test('an exact native co-creator ID allows a work from another primary author', () => {
  const f = fixture();
  f.emit({ hasMore: false, works: [work(ID, {
    author: { sec_uid: OTHER },
    cooperation_info: { co_creators: [{ sec_uid: OTHER }, { sec_uid: CREATOR }] },
  })] });
  const result = f.snapshot();
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
  assert.equal(result.works[0].author.sec_uid, OTHER);
  assert.equal(result.works[0].cooperation_info.co_creators[1].sec_uid, CREATOR);
});

test('cooperation metadata without an exact matching co-creator does not prove membership', () => {
  for (const cooperation_info of [
    { co_creators: [{ sec_uid: OTHER }] },
    { co_creators: [{ sec_uid: CREATOR + '_suffix' }] },
    { co_creators: [{ uid: CREATOR }, { nickname: CREATOR }] },
    { co_creators: { sec_uid: CREATOR } },
    { author: { sec_uid: CREATOR } },
  ]) {
    const f = fixture();
    f.emit({ hasMore: false, works: [work(ID, { author: { sec_uid: OTHER }, cooperation_info })] });
    assert.equal(f.snapshot().works.length, 0);
    assert.equal(f.snapshot().complete, false);
    assert.equal(f.snapshot().truncated, true);
  }
});

test('co-creator membership checks stop after twenty entries', () => {
  const f = fixture();
  f.emit({ hasMore: false, works: [work(ID, {
    author: { sec_uid: OTHER },
    cooperation_info: { co_creators: [...Array.from({ length: 20 }, () => ({ sec_uid: OTHER })), { sec_uid: CREATOR }] },
  })] });
  assert.equal(f.snapshot().works.length, 0);
  assert.equal(f.snapshot().complete, false);
  assert.equal(f.snapshot().truncated, true);
});

test('numeric and malformed work IDs are rejected without precision conversions', () => {
  const f = fixture();
  f.emit({ hasMore: false, works: [work(), work(Number(ID2)), work('123'), work('1e20')] });
  assert.deepEqual(f.snapshot().works.map((item) => item.aweme_id), [ID]);
  assert.equal(f.snapshot().truncated, true);
});

test('unknown author IDs are allowed but present mismatches are rejected', () => {
  const f = fixture();
  f.emit({ hasMore: false, works: [work(ID, { author: { sec_uid: '' } }), work(ID2, { author: {} }), work(ID3, { author: null })] });
  assert.equal(f.snapshot().works.length, 3);
  assert.equal(f.snapshot().complete, true);
});

test('observer truncation cannot turn rejected data into an apparently complete empty page', () => {
  const f = fixture();
  f.emit({ hasMore: false, works: [], truncated: true });
  assert.equal(f.snapshot().headLoaded, true);
  assert.equal(f.snapshot().truncated, true);
  assert.equal(f.snapshot().complete, false);
});

test('messages require same window, origin, protocol, valid creator and timestamp', () => {
  for (const [data, event] of [
    [{}, { source: {} }], [{}, { origin: 'https://evil.example' }],
    [{ source: 'other' }], [{ type: 'replay' }], [{ creatorId: 'self' }],
    [{ creatorId: 'https://www.douyin.com/user/' + CREATOR }],
    [{ capturedAt: 0 }], [{ capturedAt: NaN }], [{ capturedAt: '10' }],
    [{ works: {} }], [{ cursor: 'abc' }], [{ cursor: Number.MAX_SAFE_INTEGER + 1 }],
    [{ hasMore: 'false' }], [{ nextCursor: 'abc' }], [{ truncated: 'false' }],
  ]) {
    const f = fixture();
    f.emit(data, event);
    assert.equal(f.snapshot().headLoaded, false);
  }
});

test('replay requests use the documented protocol and exact origin', () => {
  const f = fixture();
  assert.equal(f.api.requestReplay(CREATOR), true);
  assert.deepEqual(plain(f.messages), [{ message: { source: 'douhot:profile-reader:v1', type: 'replay', creatorId: CREATOR }, origin: 'https://www.douyin.com' }]);
  assert.equal(f.api.requestReplay('self'), false);
  assert.equal(f.messages.length, 1);
});

test('retains at most three recently used creators', () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) {
    const creatorId = CREATOR + i;
    f.emit({ creatorId, works: [work(ID, { author: { sec_uid: creatorId } })], hasMore: false });
  }
  assert.equal(f.snapshot(CREATOR + '0').headLoaded, false);
  for (let i = 1; i < 4; i++) assert.equal(f.snapshot(CREATOR + i).complete, true);
});

test('page and work bounds mark truncation instead of claiming completeness', () => {
  const f = fixture();
  for (let i = 0; i <= 100; i++) {
    f.emit({ cursor: String(i), nextCursor: String(i + 1), capturedAt: 10 + i,
      works: [work(String(8000000000000000000n + BigInt(i)))], hasMore: i !== 100 });
  }
  assert.equal(f.snapshot().pageCount, 100);
  assert.equal(f.snapshot().truncated, true);
  assert.equal(f.snapshot().complete, false);
  const many = fixture();
  many.emit({ works: Array.from({ length: 5001 }, (_, i) => work(String(8000000000000000000n + BigInt(i)))), hasMore: false });
  assert.equal(many.snapshot().works.length, 5000);
  assert.equal(many.snapshot().truncated, true);
  assert.equal(many.snapshot().complete, false);
  many.emit({ capturedAt: 20, works: [work()], hasMore: false });
  assert.equal(many.snapshot().truncated, false);
  assert.equal(many.snapshot().complete, true);
});

test('cache initialization is idempotent and snapshots cannot mutate retained data', () => {
  const f = fixture();
  f.emit({ hasMore: false });
  const original = f.api;
  vm.runInContext(SOURCE, f.context);
  assert.equal(f.context.douhotProfileCache, original);
  const snapshot = f.api.snapshot(CREATOR);
  snapshot.works[0].author.sec_uid = OTHER;
  snapshot.works.push(work(ID2));
  assert.equal(f.snapshot().works.length, 1);
  assert.equal(f.snapshot().works[0].author.sec_uid, CREATOR);
});
