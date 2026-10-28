// Runs in the isolated content-script world. The MAIN-world observer only
// relays native profile-list responses; this cache performs no network requests.
(() => {
  "use strict";
  if (globalThis.douhotProfileCache) return;

  const CAPTURE_SOURCE = "douhot:profile-capture:v1";
  const READER_SOURCE = "douhot:profile-reader:v1";
  const MAX_CREATORS = 3;
  const MAX_PAGES = 100;
  const MAX_WORKS = 5000;
  const creators = new Map();

  function validCreatorId(value) {
    return typeof value === "string" && /^[\w.-]{12,256}$/.test(value);
  }

  function cursorValue(value) {
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    }
    return typeof value === "string" && /^\d{1,64}$/.test(value) ? value : null;
  }

  // Keep zero and false, but never let a missing value erase known metadata.
  // Also detach snapshots from the internal cache and ignore prototype keys.
  function mergeData(target, source, depth = 0) {
    if (depth > 12) return target;
    if (source === null || source === undefined || source === "") return target;
    if (Array.isArray(source)) {
      if (!source.length && Array.isArray(target) && target.length) return target;
      return source.slice(0, 200).map((value) => mergeData(undefined, value, depth + 1));
    }
    if (typeof source === "object") {
      const result = target && typeof target === "object" && !Array.isArray(target) ? target : {};
      for (const key of Object.keys(source).slice(0, 128)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        const value = mergeData(result[key], source[key], depth + 1);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    if (typeof source === "string") return source.slice(0, 32768);
    if (typeof source === "number") return Number.isFinite(source) ? source : target;
    return typeof source === "boolean" ? source : target;
  }

  function validWork(work, creatorId) {
    if (!work || typeof work !== "object" || Array.isArray(work)) return false;
    // Douyin IDs exceed JS's integer precision; a numeric ID cannot be repaired.
    if (typeof work.aweme_id !== "string" || !/^\d{8,32}$/.test(work.aweme_id)) return false;
    const author = work.author;
    if (author && (typeof author !== "object" || Array.isArray(author))) return false;
    if (!author || author.sec_uid == null || author.sec_uid === "" || author.sec_uid === creatorId) return true;
    // A native profile can include a co-created work whose primary author is
    // someone else. Only the observed, explicit co-creator ID establishes its
    // membership; arbitrary nested user IDs and display names do not.
    const coCreators = work.cooperation_info?.co_creators;
    return Array.isArray(coCreators)
      && coCreators.slice(0, 20).some((coCreator) => coCreator?.sec_uid === creatorId);
  }

  function touchCreator(creatorId, state) {
    creators.delete(creatorId);
    creators.set(creatorId, state);
    while (creators.size > MAX_CREATORS) creators.delete(creators.keys().next().value);
  }

  function receivePage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== CAPTURE_SOURCE || data.type !== "page") return;
    if (!validCreatorId(data.creatorId) || !Array.isArray(data.works)) return;
    if (!Number.isSafeInteger(data.capturedAt) || data.capturedAt <= 0) return;
    if (data.hasMore !== true && data.hasMore !== false && data.hasMore !== null) return;
    if (data.truncated !== undefined && typeof data.truncated !== "boolean") return;
    const cursor = cursorValue(data.cursor);
    const nextCursor = cursorValue(data.nextCursor);
    if (cursor === null || (data.nextCursor != null && nextCursor === null)) return;

    const state = creators.get(data.creatorId) || { pages: new Map(), headAt: 0, limitTruncated: false };
    if (state.headAt && data.capturedAt < state.headAt) return;
    if (cursor === "0" && data.capturedAt > state.headAt) {
      if (state.headAt) {
        // A fresh native first page starts a new collection, including refreshed
        // statistics. Replayed pages retain their original capture timestamp.
        state.pages.clear();
      } else {
        // First-page delivery may follow later pages. Keep only pages that can
        // belong to this generation, rather than throwing away valid disorder.
        for (const [key, page] of state.pages) {
          if (page.capturedAt < data.capturedAt) state.pages.delete(key);
        }
      }
      state.headAt = data.capturedAt;
      state.limitTruncated = false;
    }
    const previous = state.pages.get(cursor);
    if (previous && previous.capturedAt >= data.capturedAt) return;
    touchCreator(data.creatorId, state);
    if (!previous && state.pages.size >= MAX_PAGES) {
      state.limitTruncated = true;
      return;
    }
    let storedCount = 0;
    for (const [key, page] of state.pages) {
      if (key !== cursor) storedCount += page.works.length;
    }
    const capacity = MAX_WORKS - storedCount;
    const works = [];
    let rejected = data.truncated === true;
    for (const work of data.works.slice(0, MAX_WORKS + 1)) {
      if (!validWork(work, data.creatorId)) {
        rejected = true;
        continue;
      }
      if (works.length >= capacity) {
        state.limitTruncated = true;
        break;
      }
      works.push(mergeData(undefined, work));
    }
    if (data.works.length > MAX_WORKS) state.limitTruncated = true;
    state.pages.set(cursor, {
      cursor, nextCursor, hasMore: data.hasMore, capturedAt: data.capturedAt, works, rejected,
    });
  }

  function snapshot(creatorId) {
    const empty = { works: [], pageCount: 0, headLoaded: false, complete: false, truncated: false };
    if (!validCreatorId(creatorId)) return empty;
    const state = creators.get(creatorId);
    if (!state) return empty;
    touchCreator(creatorId, state);
    const head = state.pages.get("0");
    if (!head) return { ...empty, truncated: state.limitTruncated };
    const pages = [];
    const seenCursors = new Set();
    const workOrder = new Set();
    let cursor = "0";
    let complete = false;
    let truncated = state.limitTruncated;
    while (!seenCursors.has(cursor)) {
      const page = state.pages.get(cursor);
      if (!page) break;
      seenCursors.add(cursor);
      pages.push(page);
      truncated ||= page.rejected;
      for (const work of page.works) workOrder.add(work.aweme_id);
      // An explicit native terminal flag is necessary, including legitimate
      // empty terminal pages. An empty/stable list alone proves nothing.
      if (page.hasMore === false) {
        complete = true;
        break;
      }
      if (page.hasMore !== true || page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    const merged = new Map();
    for (const page of pages.slice().sort((a, b) => a.capturedAt - b.capturedAt)) {
      for (const work of page.works) {
        merged.set(work.aweme_id, mergeData(merged.get(work.aweme_id), work));
      }
    }
    return {
      works: [...workOrder].map((id) => merged.get(id)),
      pageCount: pages.length,
      headLoaded: true,
      complete: complete && !truncated,
      truncated,
      // Only expose the end of the connected chain. A later, isolated page
      // cannot prove that a requested date range has been fully loaded.
      frontier: pages.length ? {
        cursor: pages[pages.length - 1].cursor,
        nextCursor: pages[pages.length - 1].nextCursor,
        hasMore: pages[pages.length - 1].hasMore,
        works: pages[pages.length - 1].works.map((work) => mergeData(undefined, work)),
      } : null,
    };
  }

  function requestReplay(creatorId) {
    if (!validCreatorId(creatorId)) return false;
    window.postMessage({ source: READER_SOURCE, type: "replay", creatorId }, location.origin);
    return true;
  }

  window.addEventListener("message", receivePage);
  globalThis.douhotProfileCache = Object.freeze({ snapshot, requestReplay });
})();
