// Run with: node --test tests/media-resolution.test.cjs
// Execute the real extension functions in isolated browser fixtures. No network,
// browser account, Feishu record or production initialization is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ID = '7561234567890123456';
const OTHER_ID = '7561234567890123457';
const MEDIA = 'https://v3.douyinvod.com/video/tos/target.mp4';
const OTHER_MEDIA = 'https://v3.douyinvod.com/video/tos/other.mp4';
const DETAIL_URL = `https://www.douyin.com/video/${ID}`;

class Element {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = children;
    this.currentSrc = attrs.src || '';
    this.textContent = attrs.textContent || '';
    for (const child of children) child.parentElement = this;
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
    return descendants.filter((node) => {
      if (selector === '*') return true;
      if (selector === 'video') return node.tag === 'video';
      if (selector === 'source[src]') return node.tag === 'source' && Boolean(node.attrs.src);
      if (selector.includes('data-e2e-aweme-id')) {
        return Boolean(node.attrs['data-e2e-aweme-id'])
          && (!selector.includes('video-info') || (node.attrs['data-e2e'] || '').includes('video-info'));
      }
      return selector.startsWith('script') && node.tag === 'script';
    });
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function info(id, children = []) {
  return new Element('div', { 'data-e2e-aweme-id': id, 'data-e2e': 'detail-video-info' }, children);
}

function documentFixture(children = [], payload = null) {
  const body = new Element('body', {}, children);
  return {
    body,
    querySelectorAll: body.querySelectorAll.bind(body),
    querySelector: body.querySelector.bind(body),
    getElementById: (id) => id === 'RENDER_DATA' && payload
      ? { textContent: encodeURIComponent(JSON.stringify(payload)) } : null,
  };
}

function frontend({ children = [], payload = null, href = 'https://www.douyin.com/jingxuan', ...overrides } = {}) {
  const document = documentFixture(children, payload);
  const context = vm.createContext({
    URL, URLSearchParams, console, document, location: new URL(href),
    window: { innerWidth: 100, innerHeight: 100, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), setTimeout },
    fetch: () => { throw new Error('Unexpected network request'); },
    ...overrides,
  });
  const source = fs.readFileSync(path.join(ROOT, 'douhot-extractor.user.js'), 'utf8');
  const boot = source.indexOf('  window.douhotCreatorExtractor =');
  assert.ok(boot > 0, 'content-script bootstrap boundary exists');
  vm.runInContext(source.slice(0, boot) + `
    globalThis.api = { currentAwemeId, currentVisibleVideoInfo,
      collectCurrentVideoMediaUrl, readLoadedWorkMedia, buildTranscriptionMediaUrl,
      fetchCurrentVideoWorkFromHtml, fetchDouyinWorkDetailByApi, normalizeWork, hasTranscriptionMedia };
  })();`, context);
  return context.api;
}

function rawWork(id = ID, media = MEDIA) {
  return { aweme_id: id, desc: 'fixture', video: { play_addr: { url_list: [media] } } };
}

test('unchanged /jingxuan URL resolves the modal ID and its own video', () => {
  const target = info(ID);
  const modal = new Element('section', {}, [target, new Element('video', { src: MEDIA })]);
  const api = frontend({ children: [modal] });
  assert.equal(api.currentAwemeId(), ID);
  assert.equal(api.collectCurrentVideoMediaUrl(ID), MEDIA);
  assert.equal(api.readLoadedWorkMedia(ID).awemeId, ID);
  assert.equal(api.readLoadedWorkMedia(ID).mediaUrl, MEDIA);
});

test('preloaded neighboring works never supply the requested media', () => {
  const api = frontend({ children: [
    new Element('section', {}, [info(OTHER_ID), new Element('video', { src: OTHER_MEDIA })]),
    new Element('section', {}, [info(ID), new Element('video', { src: MEDIA })]),
  ] });
  assert.equal(api.collectCurrentVideoMediaUrl(ID), MEDIA);
  assert.equal(api.currentVisibleVideoInfo('7561234567890123458'), null);
  assert.equal(api.readLoadedWorkMedia('7561234567890123458'), null);
});

test('mixed-ID containers and multiple videos are ambiguous', () => {
  const mixed = frontend({ children: [new Element('section', {}, [info(ID), info(OTHER_ID), new Element('video', { src: OTHER_MEDIA })])] });
  assert.equal(mixed.collectCurrentVideoMediaUrl(ID), '');
  const multiple = frontend({ children: [info(ID, [new Element('video', { src: MEDIA }), new Element('video', { src: OTHER_MEDIA })])] });
  assert.equal(multiple.collectCurrentVideoMediaUrl(ID), '');
});

test('blob/data media cannot become a public URL, and body-wide videos are ignored', () => {
  for (const source of ['blob:https://www.douyin.com/opaque', 'data:video/mp4;base64,AAAA']) {
    const api = frontend({ children: [info(ID, [new Element('video', { src: source })])] });
    assert.equal(api.collectCurrentVideoMediaUrl(ID), '');
    assert.equal(api.readLoadedWorkMedia(ID), null);
    assert.equal(api.buildTranscriptionMediaUrl(source), '');
  }
  const api = frontend({ children: [info(ID), new Element('video', { src: OTHER_MEDIA })] });
  assert.equal(api.collectCurrentVideoMediaUrl(ID), '');
  assert.equal(api.buildTranscriptionMediaUrl('//v3.douyinvod.com/test.mp4'), 'https://v3.douyinvod.com/test.mp4');
  assert.match(api.buildTranscriptionMediaUrl('v0200validPlayUri'), /video_id=v0200validPlayUri/);
});

test('loaded script data is matched by work ID rather than array order', () => {
  const api = frontend({ payload: { aweme_list: [rawWork(OTHER_ID, OTHER_MEDIA), rawWork()] } });
  assert.equal(api.readLoadedWorkMedia(ID).mediaUrl, MEDIA);
  assert.equal(api.readLoadedWorkMedia('7561234567890123458'), null);
  const invalidSource = rawWork();
  invalidSource.video.play_addr = { uri: 'blob:https://www.douyin.com/opaque' };
  assert.equal(frontend({ payload: { aweme_detail: invalidSource } }).readLoadedWorkMedia(ID), null);
});

test('HTML fallback fetches canonical target detail while the address bar stays on /jingxuan', async () => {
  let requested = '';
  const api = frontend({
    fetch: async (url) => { requested = String(url); return { ok: true, text: async () => '<html></html>' }; },
    DOMParser: class { parseFromString() { return documentFixture([], { aweme_detail: rawWork() }); } },
  });
  assert.equal((await api.fetchCurrentVideoWorkFromHtml(ID)).aweme_id, ID);
  assert.equal(requested, DETAIL_URL);
});

test('frontend rejects an API detail response with another work ID', async () => {
  const api = frontend({ fetch: async () => ({ ok: true, text: async () => JSON.stringify({ status_code: 0, aweme_detail: rawWork(OTHER_ID) }) }) });
  await assert.rejects(api.fetchDouyinWorkDetailByApi(ID, 1), /ID.*不匹配/);
});

function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => { for (const fn of listeners) fn(...args); },
  };
}

function backend({ loadedWork = null, networkPayload = null, resources = [], attachFails = false, updateFails = false } = {}) {
  const trace = [];
  const onEvent = event();
  const onUpdated = event();
  let tab = { id: 91, url: 'about:blank', status: 'complete' };
  const chrome = {
    runtime: { onMessage: event(), onInstalled: event(), onStartup: event(), lastError: null },
    alarms: { create() {}, onAlarm: event() },
    tabs: {
      onUpdated,
      create: (options, callback) => { trace.push(['create', options]); tab.url = options.url; callback(tab); },
      get: (id, callback) => callback ? callback(tab) : Promise.resolve(tab),
      update: (id, options, callback) => {
        trace.push(['update', options]);
        if (updateFails) throw new Error('navigation failed');
        tab.url = options.url;
        if (networkPayload) {
          onEvent.emit({ tabId: id }, 'Network.responseReceived', { requestId: 'r1', response: { status: 200, url: `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${ID}` } });
          onEvent.emit({ tabId: id }, 'Network.loadingFinished', { requestId: 'r1' });
        }
        callback(tab);
      },
      remove: (id, callback) => { trace.push(['remove', id]); callback(); },
      sendMessage: (id, message, callback) => { trace.push(['message', message]); callback({ ok: true, data: { work: loadedWork } }); },
    },
    debugger: {
      onEvent,
      attach: async () => { trace.push(['attach']); if (attachFails) throw new Error('debugger unavailable'); },
      detach: async () => { trace.push(['detach']); },
      sendCommand: async (target, method) => {
        trace.push(['command', method]);
        if (method === 'Network.getResponseBody') return { body: JSON.stringify(networkPayload) };
        if (method === 'Runtime.evaluate') return { result: { value: JSON.stringify({ url: tab.url, urls: resources }) } };
        return {};
      },
    },
  };
  const context = vm.createContext({
    chrome, URL, URLSearchParams, console,
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ aweme_detail: rawWork(OTHER_ID) }) }),
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context);
  return { api: context, trace, onEvent, onUpdated, temporaryCount: () => vm.runInContext('temporaryDouyinDetailTabs.size', context) };
}

function assertClean(fixture, { detached = true } = {}) {
  assert.equal(fixture.temporaryCount(), 0);
  assert.equal(fixture.onEvent.listeners.size, 0);
  assert.equal(fixture.onUpdated.listeners.size, 0);
  assert.equal(fixture.trace.filter(([name]) => name === 'remove').length, 1);
  assert.equal(fixture.trace.filter(([name]) => name === 'detach').length, detached ? 1 : 0);
}

test('existing source tabs only use ID-verified content data, never page-wide resources', async () => {
  const fixture = backend({ loadedWork: { id: OTHER_ID, mediaUrl: OTHER_MEDIA }, resources: [MEDIA] });
  assert.equal(await fixture.api.resolveLoadedDouyinMediaUrl(11, ID), '');
  assert.equal(await fixture.api.resolveUniqueFreshDouyinMediaUrl(11, ID), '');
  assert.equal(fixture.trace.length, 1);
  assert.equal(fixture.trace[0][1].type, 'douhot:readLoadedWorkMedia');
  assert.equal(fixture.trace[0][1].awemeId, ID);
});

test('backend rejects wrong-ID API payload and conflicting normalized IDs', async () => {
  const { api } = backend();
  await assert.rejects(api.fetchDouyinWorkForTranscription(ID), /匹配/);
  assert.equal(api.douyinWorkMatchesId({ awemeId: ID, id: OTHER_ID }, ID), false);
  assert.equal(api.transcriptionWorkFromDetailPayload({ aweme_detail: rawWork(OTHER_ID) }, ID), null);
  assert.equal(api.preferredTranscriptionMediaUrl({ sourcePlayUri: 'blob:https://www.douyin.com/opaque' }), '');
});

test('native detail response supplies matching media and cleans up debugger/tab/listeners', async () => {
  const fixture = backend({ networkPayload: { aweme_detail: rawWork() } });
  const work = await fixture.api.resolveDouyinDetailMediaWork(ID);
  assert.equal(work.awemeId, ID);
  assert.equal(work.mediaUrl, MEDIA);
  assert.equal(fixture.trace.find(([name]) => name === 'create')[1].url, 'about:blank');
  assert.equal(fixture.trace.find(([name]) => name === 'update')[1].url, DETAIL_URL);
  assert.ok(fixture.trace.findIndex(([name]) => name === 'attach') < fixture.trace.findIndex(([name]) => name === 'update'));
  assertClean(fixture);
});

test('wrong-ID native response and ambiguous media fail without leaking temporary resources', async () => {
  const fixture = backend({ networkPayload: { aweme_detail: rawWork(OTHER_ID) }, resources: [MEDIA, OTHER_MEDIA] });
  await assert.rejects(fixture.api.resolveDouyinDetailMediaWork(ID), /归属明确/);
  assertClean(fixture);
});

test('fresh detail deduplicates byte ranges while preserving the original playable URL', async () => {
  const fixture = backend({ resources: [`${MEDIA}?range=0-999`, `${MEDIA}?range=1000-1999`] });
  assert.equal((await fixture.api.resolveDouyinDetailMediaWork(ID)).mediaUrl, `${MEDIA}?range=0-999`);
  assertClean(fixture);
});

test('debugger refusal still permits matched DOM media and closes the temporary tab', async () => {
  const fixture = backend({ attachFails: true, loadedWork: { id: ID, awemeId: ID, mediaUrl: MEDIA } });
  assert.equal((await fixture.api.resolveDouyinDetailMediaWork(ID)).mediaUrl, MEDIA);
  assertClean(fixture, { detached: false });
});

test('navigation failure also detaches debugger and removes listeners/tab', async () => {
  const fixture = backend({ updateFails: true });
  await assert.rejects(fixture.api.resolveDouyinDetailMediaWork(ID), /navigation failed/);
  assertClean(fixture);
});

// The reported /media-video-hvc1/ MP4 was probed as HEVC video-only (213.9s).
// These markers identify separate tracks; HEVC or .mp4 alone does not.
test('reported split video and audio paths are rejected across frontend and backend', () => {
  const frontendApi = frontend();
  const { api } = backend();
  for (const name of ['media-video-hvc1', 'media-video-avc1', 'media-audio-mp4a']) {
    const url = `https://v11-weba.douyinvod.com/video/tos/fixture/${name}/?mime_type=video_mp4`;
    assert.equal(frontendApi.buildTranscriptionMediaUrl(url), '');
    assert.equal(frontendApi.hasTranscriptionMedia({ mediaUrl: url }), false);
    assert.equal(api.buildDouyinSourceUrl(url), '');
    assert.equal(api.isUsableTranscriptionMediaUrl(url), false);
    assert.equal(api.preferredTranscriptionMediaUrl({ mediaUrl: url }), '');
  }
  const ordinary = `${MEDIA}?codec=hvc1&label=media-video-hvc1`;
  assert.equal(frontendApi.buildTranscriptionMediaUrl(ordinary), ordinary);
  assert.equal(api.isUsableTranscriptionMediaUrl(ordinary), true);
});

test('split first candidate does not shadow the later complete download address', () => {
  const split = 'https://v11-weba.douyinvod.com/video/tos/fixture/media-video-hvc1/';
  const raw = { aweme_id: ID, video: { play_addr: { uri: split, url_list: [split] }, download_addr: { url_list: [MEDIA] } } };
  assert.equal(frontend().normalizeWork(raw, '').mediaUrl, MEDIA);
  assert.equal(backend().api.normalizeTranscriptionWorkDetail(raw).mediaUrl, MEDIA);
});

test('a rejected URI does not shadow a later valid play URI', () => {
  const split = 'https://v11-weba.douyinvod.com/video/tos/fixture/media-video-hvc1/';
  const raw = { aweme_id: ID, video: { play_addr: { uri: split }, play_addr_h264: { uri: 'validCompleteVideoId' } } };
  for (const result of [frontend().normalizeWork(raw, ''), backend().api.normalizeTranscriptionWorkDetail(raw)]) {
    assert.equal(result.sourcePlayUri, 'validCompleteVideoId');
    assert.match(result.mediaUrl, /video_id=validCompleteVideoId/);
  }
});

test('the player cannot overwrite existing script media and split DOM sources stay unavailable', () => {
  const split = 'https://v11-weba.douyinvod.com/video/tos/fixture/media-video-hvc1/';
  for (const playerSource of [split, OTHER_MEDIA]) {
    const api = frontend({
      payload: { aweme_detail: rawWork() },
      children: [info(ID, [new Element('video', { src: playerSource })])],
    });
    assert.equal(api.readLoadedWorkMedia(ID).mediaUrl, MEDIA);
  }
  const withoutScript = frontend({ children: [info(ID, [new Element('video', { src: split })])] });
  assert.equal(withoutScript.readLoadedWorkMedia(ID), null);
});

test('resource fallback skips separate tracks and keeps a complete alternative', async () => {
  const split = 'https://v11-weba.douyinvod.com/video/tos/fixture/media-video-hvc1/';
  const onlySplit = backend({ resources: [split] });
  await assert.rejects(onlySplit.api.resolveDouyinDetailMediaWork(ID), /归属明确/);
  assertClean(onlySplit);
  const withComplete = backend({ resources: [split, MEDIA] });
  assert.equal((await withComplete.api.resolveDouyinDetailMediaWork(ID)).mediaUrl, MEDIA);
  assertClean(withComplete);
});

test('regional native detail host remains restricted by endpoint and exact work ID', () => {
  const { api } = backend();
  assert.equal(api.isTargetDouyinDetailResponse(`https://www-hj.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${ID}`, ID), true);
  assert.equal(api.isTargetDouyinDetailResponse(`https://www-hj.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${OTHER_ID}`, ID), false);
  assert.equal(api.isTargetDouyinDetailResponse(`https://evil.example/aweme/v1/web/aweme/detail/?aweme_id=${ID}`, ID), false);
});

test('old queued split-track URLs are rejected before a paid transcription submission', async () => {
  const { api } = backend();
  await assert.rejects(api.submitDashScopeTranscription({}, 'https://v11-weba.douyinvod.com/video/tos/fixture/media-video-hvc1/'), /分离轨道/);
});
