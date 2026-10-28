// MAIN-world, document_start bridge. Reuses only the site's own profile responses.
// It never issues a request, adds request parameters, or reads other API routes.
(() => {
  "use strict";
  const GUARD = "__douhotProfileCaptureV1Installed";
  if (window[GUARD]) return;
  const origin = location.origin;
  if (location.protocol !== "https:" || !["www.douyin.com", "douyin.com"].includes(location.hostname)) return;
  Object.defineProperty(window, GUARD, { value: true });

  const SOURCE = "douhot:profile-capture:v1";
  const READER = "douhot:profile-reader:v1";
  // The website can switch its native profile-pagination XHR to www-hj.
  // These are exact observed API origins, not a wildcard permission to read APIs.
  const PROFILE_API_ORIGINS = new Set([
    "https://www.douyin.com", "https://douyin.com", "https://www-hj.douyin.com",
  ]);
  const MAX_BODY = 8 * 1024 * 1024;
  const MAX_WORKS = 5000;
  const authors = new Map();
  const requests = new Map();
  const xhrStates = new WeakMap();
  let lastCapturedAt = 0;
  let lastGeneration = 0;

  function text(value, limit = 256) {
    return typeof value === "string" || typeof value === "number"
      ? String(value).slice(0, limit) : "";
  }

  function requestInfo(input) {
    try {
      // Avoid invoking arbitrary string conversions on fetch input objects.
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      if (typeof raw !== "string") return null;
      const url = new URL(raw, location.href);
      if (!PROFILE_API_ORIGINS.has(url.origin) || !/^\/aweme\/v1\/web\/aweme\/post\/?$/.test(url.pathname)) return null;
      const creatorId = url.searchParams.get("sec_user_id");
      const cursor = url.searchParams.get("max_cursor") || "0";
      if (!creatorId || !/^[\w.-]{12,256}$/.test(creatorId) || cursor.length > 128) return null;
      const restricted = url.searchParams.getAll("time_list_query").some((value) => value !== "" && value !== "0");
      return { creatorId, cursor, restricted };
    } catch (_) { return null; }
  }

  function capturedAt() {
    lastCapturedAt = Math.max(Date.now(), lastCapturedAt + 1);
    return lastCapturedAt;
  }

  function beginRequest(info) {
    if (!info) return null;
    let state = requests.get(info.creatorId);
    if (info.restricted || info.cursor === "0" || !state) {
      state = { generation: ++lastGeneration, restricted: info.restricted };
      // Clear immediately: a replay while the new request is in flight must not
      // resurrect the preceding collection or a different date-filter scope.
      authors.delete(info.creatorId);
    }
    requests.delete(info.creatorId);
    requests.set(info.creatorId, state);
    while (requests.size > 3) requests.delete(requests.keys().next().value);
    if (info.restricted) {
      emit(JSON.stringify({ source: SOURCE, type: "page", creatorId: info.creatorId,
        cursor: "0", nextCursor: null, hasMore: null, capturedAt: capturedAt(), works: [], truncated: true }));
    } else if (info.cursor === "0") {
      // Invalidate the isolated cache too, while this new native head is pending.
      emit(JSON.stringify({ source: SOURCE, type: "page", creatorId: info.creatorId,
        cursor: "0", nextCursor: null, hasMore: null, capturedAt: capturedAt(), works: [], truncated: false, pending: true }));
    }
    // A later unfiltered tail cannot undo an active date filter. Only a new
    // unrestricted first-page request can establish a complete-profile scope.
    if (state.restricted) return null;
    return { ...info, generation: state.generation };
  }

  function address(value) {
    if (!value || typeof value !== "object") return undefined;
    const result = {};
    for (const key of ["url_list", "urlList"]) {
      if (!Array.isArray(value[key])) continue;
      result[key] = value[key].slice(0, 4).filter((url) => typeof url === "string" && url.length <= 8192
        && /^(?:https?:)?\/\//i.test(url));
    }
    if (typeof value.uri === "string") result.uri = value.uri.slice(0, 512);
    return Object.keys(result).length ? result : undefined;
  }

  function numericFields(value, keys) {
    const result = {};
    for (const key of keys) {
      if (typeof value?.[key] === "number" && Number.isFinite(value[key])) result[key] = value[key];
      else if (typeof value?.[key] === "string" && /^\d{1,20}$/.test(value[key])) result[key] = value[key];
    }
    return result;
  }

  function work(value, creatorId) {
    if (!value || typeof value !== "object") return null;
    const authorId = text(value.author?.sec_uid, 1024);
    const coCreators = Array.isArray(value.cooperation_info?.co_creators) ? value.cooperation_info.co_creators : [];
    const matchedCoCreator = coCreators.find((creator) => creator?.sec_uid === creatorId);
    if (authorId && authorId !== creatorId && !matchedCoCreator) return null;
    const id = value.aweme_id;
    if (typeof id !== "string" || !/^\d{8,32}$/.test(id)) return null;
    const result = { aweme_id: id, desc: text(value.desc, 6000) };
    Object.assign(result, numericFields(value, ["create_time", "aweme_type", "is_top"]));
    if (typeof value.is_top === "boolean") result.is_top = value.is_top;
    if (typeof value.share_url === "string") result.share_url = value.share_url.slice(0, 8192);
    if (value.author && typeof value.author === "object") {
      result.author = {
        sec_uid: text(value.author.sec_uid),
        uid: text(value.author.uid, 64),
        nickname: text(value.author.nickname, 256),
      };
    }
    if (coCreators.length) {
      const selected = [];
      const seen = new Set();
      const include = (creator) => {
        if (!creator || typeof creator.sec_uid !== "string" || !/^[\w.-]{12,256}$/.test(creator.sec_uid)) return;
        if (seen.has(creator.sec_uid) || selected.length >= 20) return;
        seen.add(creator.sec_uid);
        selected.push({ sec_uid: creator.sec_uid, uid: text(creator.uid, 64) });
      };
      // Keep the exact ownership evidence even if the native collaborator list
      // is longer than our transport limit; the isolated cache rechecks it.
      if (matchedCoCreator) include(matchedCoCreator);
      for (const creator of coCreators) {
        include(creator);
        if (selected.length >= 20) break;
      }
      if (selected.length) result.cooperation_info = { co_creators: selected };
    }
    result.statistics = numericFields(value.statistics, [
      "digg_count", "comment_count", "collect_count", "share_count", "play_count",
      "download_count", "forward_count", "lose_count", "lose_comment_count",
    ]);
    if (value.video && typeof value.video === "object") {
      result.video = numericFields(value.video, ["duration"]);
      for (const key of ["play_addr", "play_addr_h264", "play_addr_265", "cover", "origin_cover", "download_addr"]) {
        const selected = address(value.video[key]);
        if (selected) result.video[key] = selected;
      }
    }
    // Preserve the image-post marker and its first cover; omit the rest of its payload.
    if (Array.isArray(value.images)) result.images = value.images.length ? [address(value.images[0]) || {}] : [];
    return result;
  }

  function hasMore(value) {
    if (value === true || value === 1 || value === "1" || value === "true") return true;
    if (value === false || value === 0 || value === "0" || value === "false") return false;
    return null;
  }

  function emit(serialized, truncated = false) {
    try {
      const page = JSON.parse(serialized);
      if (truncated) page.truncated = true;
      try {
        console.debug("[喂鱼主页采集] 分页 " + JSON.stringify({ cursor: page.cursor, nextCursor: page.nextCursor,
          hasMore: page.hasMore, count: page.works.length, truncated: page.truncated }));
      } catch (_) { /* Diagnostic logging must never suppress delivery. */ }
      window.postMessage(page, origin);
    } catch (_) { /* Best effort. */ }
  }

  function accept(info, data, forcedTruncation = false) {
    try {
      const current = requests.get(info.creatorId);
      if (!current || current.restricted || current.generation !== info.generation) return;
      if (!data || !Array.isArray(data.aweme_list)) return;
      if (data.status_code != null && Number(data.status_code) !== 0) return;
      const works = data.aweme_list.length > MAX_WORKS ? []
        : data.aweme_list.map((item) => work(item, info.creatorId)).filter(Boolean);
      const next = data.max_cursor ?? data.next_cursor;
      const page = {
        source: SOURCE, type: "page", creatorId: info.creatorId, cursor: info.cursor,
        nextCursor: next == null ? null : text(next, 128),
        hasMore: hasMore(data.has_more), capturedAt: capturedAt(), works,
        truncated: forcedTruncation || works.length !== data.aweme_list.length,
      };
      // Store strings so neither the page nor a replay recipient can mutate our cache.
      let serialized = JSON.stringify(page);
      if (serialized.length > MAX_BODY) {
        page.works = [];
        page.truncated = true;
        serialized = JSON.stringify(page);
      }
      let entry = authors.get(info.creatorId);
      if (!entry || info.cursor === "0") entry = { pages: new Map(), count: 0, size: 0, truncated: false };
      authors.delete(info.creatorId);
      authors.set(info.creatorId, entry);
      const previous = entry.pages.get(info.cursor);
      if (previous) { entry.count -= previous.count; entry.size -= previous.serialized.length; }
      entry.pages.delete(info.cursor);
      entry.pages.set(info.cursor, { serialized, count: page.works.length });
      entry.count += page.works.length;
      entry.size += serialized.length;
      while (entry.pages.size > 100 || entry.count > MAX_WORKS || entry.size > MAX_BODY) {
        const key = entry.pages.keys().next().value;
        const removed = entry.pages.get(key);
        entry.pages.delete(key);
        entry.count -= removed.count;
        entry.size -= removed.serialized.length;
        entry.truncated = true;
      }
      while (authors.size > 3) authors.delete(authors.keys().next().value);
      emit(serialized);
    } catch (_) { /* A malformed response must never interfere with the website. */ }
  }

  function acceptText(info, body) {
    try {
      if (typeof body !== "string") return;
      if (body.length > MAX_BODY) accept(info, { aweme_list: [] }, true);
      else accept(info, JSON.parse(body));
    } catch (_) { /* Non-JSON or partial responses are ignored. */ }
  }

  window.addEventListener("message", (event) => {
    try {
      if (event.source !== window || event.origin !== origin) return;
      const data = event.data;
      if (data?.source !== READER || data.type !== "replay" || typeof data.creatorId !== "string") return;
      const entry = authors.get(data.creatorId);
      if (entry) for (const page of entry.pages.values()) emit(page.serialized, entry.truncated);
    } catch (_) { /* Ignore malformed page messages. */ }
  });

  if (typeof window.fetch === "function") {
    const nativeFetch = window.fetch;
    window.fetch = function (...args) {
      // Return the exact native promise and preserve native synchronous exceptions.
      const promise = Reflect.apply(nativeFetch, this, args);
      try {
        const info = beginRequest(requestInfo(args[0]));
        if (info) promise.then((response) => {
          try {
            if (!response || !response.ok) return;
            // A redirect to a different resource must not be treated as profile data.
            if (response.url) {
              const finalInfo = requestInfo(response.url);
              if (!finalInfo || finalInfo.restricted || finalInfo.creatorId !== info.creatorId) return;
            }
            const copy = response.clone();
            copy.text().then((body) => acceptText(info, body), () => {});
          } catch (_) { /* clone/read failures do not affect the site's response. */ }
        }, () => {});
      } catch (_) { /* Preserve fetch semantics even if inspection fails. */ }
      return promise;
    };
  }

  const prototype = window.XMLHttpRequest?.prototype;
  if (!prototype || typeof prototype.open !== "function" || typeof prototype.send !== "function") return;
  const nativeOpen = prototype.open;
  const nativeSend = prototype.send;
  prototype.open = function (...args) {
    const result = Reflect.apply(nativeOpen, this, args);
    try {
      xhrStates.get(this)?.cleanup?.();
      xhrStates.set(this, { info: requestInfo(args[1]), cleanup: null });
    } catch (_) { /* Preserve open semantics. */ }
    return result;
  };
  prototype.send = function (...args) {
    let cleanup = null;
    let onSent = null;
    try {
      const state = xhrStates.get(this);
      if (state?.info) {
        const xhr = this;
        let info = null;
        let sent = false;
        let loadedSynchronously = false;
        const onLoad = () => {
          try {
            if (!sent) { loadedSynchronously = true; return; }
            if (!info) return;
            if (xhr.status < 200 || xhr.status >= 300) return;
            if (xhr.responseURL) {
              const finalInfo = requestInfo(xhr.responseURL);
              if (!finalInfo || finalInfo.restricted || finalInfo.creatorId !== info.creatorId) return;
            }
            if (xhr.responseType === "json") accept(info, xhr.response);
            else if (!xhr.responseType || xhr.responseType === "text") acceptText(info, xhr.responseText);
          } catch (_) { /* Unsupported response types and getters are ignored. */ }
        };
        cleanup = () => {
          xhr.removeEventListener("load", onLoad);
          xhr.removeEventListener("loadend", cleanup);
          if (state.cleanup === cleanup) state.cleanup = null;
        };
        state.cleanup?.();
        state.cleanup = cleanup;
        xhr.addEventListener("load", onLoad);
        xhr.addEventListener("loadend", cleanup);
        onSent = () => {
          info = beginRequest(state.info);
          sent = true;
          if (loadedSynchronously) onLoad();
        };
      }
    } catch (_) { /* Preserve send semantics. */ }
    try {
      const result = Reflect.apply(nativeSend, this, args);
      try { onSent?.(); } catch (_) { /* Preserve a successfully sent request. */ }
      return result;
    }
    catch (error) {
      try { cleanup?.(); } catch (_) { /* Rethrow the original network error. */ }
      throw error;
    }
  };
})();
