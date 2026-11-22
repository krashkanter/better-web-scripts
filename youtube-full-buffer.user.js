// ==UserScript==
// @name         YouTube Full Buffer
// @namespace    better-web-scripts
// @version      1.1.0
// @description  Make YouTube buffer the whole video ahead as soon as it opens, instead of about a minute at a time.
// @downloadURL  https://raw.githubusercontent.com/krashkanter/better-web-scripts/main/youtube-full-buffer.user.js
// @updateURL    https://raw.githubusercontent.com/krashkanter/better-web-scripts/main/youtube-full-buffer.user.js
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * How YouTube limits buffering, and what this script changes:
 *
 * 1. The player's streaming policy caps readahead per track at
 *    min(byte budget / bitrate, 120 s), with 20 MiB video and 8 MiB audio
 *    budgets. The script swaps that policy class for a subclass that, on the
 *    watch page, drops the time cap and sizes the byte budgets to the
 *    browser limit (below) at the current bitrate.
 * 2. Media comes over SABR: the player POSTs a protobuf that reports its
 *    position (player_time_ms) and what it has buffered, and the server only
 *    sends media up to ~15-30 s past that position. For the watch-page player
 *    the script reports a position just short of the buffered end, so the
 *    server keeps sending the next chunk.
 * 3. Each SABR response tells the player how far ahead to keep buffered
 *    (NextRequestPolicy.targetReadaheadMs). The script raises it so the player
 *    keeps asking until the video is buffered.
 *
 * The browser itself caps how much media a page may hold (Chromium default:
 * 12 MiB audio, 150 MiB video, about 7 minutes of audio). Past that, appends
 * fail and the player stops loading, so readahead stays below LIMITS_MIB.
 * The defaults below match a browser started with
 *   --mse-audio-buffer-size-limit-mb=512 --mse-video-buffer-size-limit-mb=3000
 * (Chromium multiplies these in 32 bits: 4096 or 8192 wrap to the default
 * limit, so stay below 4096.) Without those flags the browser runs out of
 * buffer space and playback can freeze, so set them (see the README). If you
 * start the browser with other limits, change LIMITS_MIB to match.
 *
 * Live streams, Shorts, previews and embeds are left alone. Anything the
 * script cannot parse is passed through untouched.
 */
(() => {
  'use strict';

  const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (win.__ytFullBuffer) return;

  // Browser media buffer limits in MiB, as set by the flags above.
  const LIMITS_MIB = { audio: 512, video: 3000 };
  // Share of the browser limit that readahead may use.
  const SAFETY = 0.8;
  // Browser memory per second of media on top of the media bytes
  // (per-frame bookkeeping; matters for low-bitrate audio).
  const OVERHEAD_BYTES_PER_SEC = 6000;
  // Buffer health reported to the server while prefetching. High enough
  // that the server never sees a starving player, low enough that each
  // request still returns a sizeable chunk.
  const REPORTED_HEALTH_MS = 10000;
  // Ranges closer than this are treated as contiguous.
  const GAP_MS = 500;
  // Media this far behind the play position still counts as held (the
  // browser frees older data on its own when it needs room).
  const BEHIND_MS = 10000;
  // Bitrates swing within a video; size estimates use the higher of the
  // average and the last few segments, times this margin.
  const RATE_MARGIN = 1.2;
  const RECENT_SEGMENTS = 6;
  // The server may send a bit more than its stated readahead target.
  const SERVER_TARGET_MARGIN = 1.25;

  const PART_MEDIA_HEADER = 20;
  const PART_NEXT_REQUEST_POLICY = 35;
  const PART_FORMAT_INIT = 42;

  const debug = (() => { try { return localStorage.getItem('ytfb-debug') === '1'; } catch { return false; } })();
  const log = (...a) => { if (debug) console.log('[YT Full Buffer]', ...a); };

  const limitBytes = type => LIMITS_MIB[type] * 1048576;

  const itagType = new Map();   // itag -> 'audio' | 'video'
  const sessions = new Map();   // cpn -> per-playback state
  const state = { requests: 0, spoofed: 0, patched: 0, aheadMs: 0, maxAheadMs: 0, errors: 0, policyClass: null };
  win.__ytFullBuffer = state;

  function session(cpn) {
    let s = sessions.get(cpn);
    if (!s) {
      s = {
        complete: false,
        maxAheadMs: 0,
        serverTargetMs: 30000,
        ends: new Map(),   // itag -> end time (ms)
        rates: new Map(),  // itag -> { bytes, ms, recent: [[bytes, ms]...] }
        types: {},         // type -> selected itag
      };
      sessions.set(cpn, s);
      if (sessions.size > 20) sessions.delete(sessions.keys().next().value);
    }
    return s;
  }
  // Conservative bytes/second for an itag in this playback; 0 if unknown.
  function byteRate(s, itag) {
    const r = s.rates.get(itag);
    if (!r || r.ms < 5000) return 0;
    let rb = 0, rm = 0;
    for (const [b, m] of r.recent) { rb += b; rm += m; }
    return Math.max(r.bytes / r.ms, rm ? rb / rm : 0) * 1000 * RATE_MARGIN;
  }

  // ---- protobuf, just enough ----
  function readVarint(b, p) {
    let v = 0, m = 1, x;
    do {
      if (p >= b.length) throw new RangeError('varint');
      x = b[p++];
      v += (x & 0x7f) * m;
      m *= 128;
    } while (x & 0x80);
    return [v, p];
  }
  function pushVarint(out, v) {
    while (v >= 128) { out.push((v % 128) | 128); v = Math.floor(v / 128); }
    out.push(v);
  }
  function parse(b) {
    const fields = [];
    let p = 0;
    while (p < b.length) {
      const s = p;
      let key, v = null, vs;
      [key, p] = readVarint(b, p);
      const f = Math.floor(key / 8), w = key % 8;
      if (!f) throw new RangeError('field 0');
      vs = p;
      if (w === 0) [v, p] = readVarint(b, p);
      else if (w === 1) p += 8;
      else if (w === 5) p += 4;
      else if (w === 2) { let l; [l, p] = readVarint(b, p); vs = p; p += l; }
      else throw new RangeError('wire type ' + w);
      if (p > b.length) throw new RangeError('truncated');
      fields.push({ f, w, s, e: p, vs, v });
    }
    return fields;
  }
  const bytesOf = (b, x) => b.subarray(x.vs, x.e);
  const first = (fs, f, w) => fs.find(x => x.f === f && x.w === w);
  // Re-encode a message with some varint fields (ints) or sub-messages (msgs) replaced.
  function rebuild(b, fields, ints = {}, msgs = {}) {
    const out = [];
    const done = new Set();
    for (const x of fields) {
      if (x.w === 0 && x.f in ints) {
        if (done.has(x.f)) continue;
        done.add(x.f);
        pushVarint(out, x.f * 8);
        pushVarint(out, ints[x.f]);
      } else if (x.w === 2 && x.f in msgs) {
        if (done.has(x.f)) continue;
        done.add(x.f);
        pushVarint(out, x.f * 8 + 2);
        pushVarint(out, msgs[x.f].length);
        for (const c of msgs[x.f]) out.push(c);
      } else {
        for (let i = x.s; i < x.e; i++) out.push(b[i]);
      }
    }
    for (const f in ints) if (!done.has(+f)) { pushVarint(out, f * 8); pushVarint(out, ints[f]); }
    return Uint8Array.from(out);
  }
  const itagOf = formatId => first(parse(formatId), 1, 0)?.v ?? null;

  // ---- which requests to touch ----
  function mainPlayerCpn() {
    if (location.pathname !== '/watch') return null;
    const p = document.getElementById('movie_player');
    try {
      if (p?.getVideoData?.()?.isLive) return null;
      return p?.getVideoStats?.()?.cpn || null;
    } catch { return null; }
  }
  function targetCpn(url) {
    if (!url.includes('/videoplayback?') || !/[?&]sabr=1(&|$)/.test(url)) return null;
    const q = new URL(url, location.href).searchParams;
    if (q.get('source') === 'yt_live_broadcast' || q.has('live')) return null;
    const cpn = q.get('cpn');
    return cpn && cpn === mainPlayerCpn() ? cpn : null;
  }

  // ---- request: report a position just short of the buffered end ----
  function rewriteRequest(body, cpn) {
    const s = session(cpn);
    const top = parse(body);
    const abrField = first(top, 1, 2);
    if (!abrField) return null;
    const abrBytes = bytesOf(body, abrField);
    const abr = parse(abrBytes);
    const playerTime = first(abr, 28, 0)?.v ?? 0;

    const selected = {};  // type -> itag
    for (const x of top) {
      if (x.f !== 2 || x.w !== 2) continue;
      const itag = itagOf(bytesOf(body, x));
      const t = itagType.get(itag);
      if (!t) return null; // format not seen yet: leave this request alone
      selected[t] = itag;
    }
    const types = Object.keys(selected);
    if (!types.length) return null;

    // Buffered ranges per type, as [start, end, itag], merged per itag.
    const ranges = { audio: [], video: [] };
    const byItag = new Map();
    for (const x of top) {
      if (x.f !== 3 || x.w !== 2) continue;
      const rb = bytesOf(body, x);
      const r = parse(rb);
      const fmt = first(r, 1, 2);
      const itag = fmt && itagOf(bytesOf(rb, fmt));
      if (!itagType.has(itag)) continue;
      const start = first(r, 2, 0)?.v ?? 0, dur = first(r, 3, 0)?.v ?? 0;
      if (!byItag.has(itag)) byItag.set(itag, []);
      byItag.get(itag).push([start, start + dur]);
    }
    for (const [itag, list] of byItag) {
      list.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const [a, b] of list) {
        const last = merged[merged.length - 1];
        if (last && a <= last[1] + GAP_MS) last[1] = Math.max(last[1], b);
        else merged.push([a, b]);
      }
      for (const [a, b] of merged) ranges[itagType.get(itag)].push([a, b, itag]);
    }

    // Contiguous buffered end from the play position, per type.
    const end = {};
    let ahead = Infinity;
    for (const t of types) {
      let e = playerTime;
      for (const [a, b] of ranges[t].slice().sort((x, y) => x[0] - y[0])) {
        if (a > e + GAP_MS) break;
        if (b > e) e = b;
      }
      end[t] = e;
      ahead = Math.min(ahead, e);
    }
    state.aheadMs = ahead - playerTime;

    s.complete = types.every(t => s.ends.get(selected[t]) > 0 && end[t] >= s.ends.get(selected[t]) - GAP_MS);
    if (s.complete) { s.maxAheadMs = 0; return null; }

    // How much more media (ms past `ahead`) fits under the browser limit,
    // counting what each buffered range weighs at its own format's bitrate.
    let room = Infinity;
    for (const t of types) {
      const rate = byteRate(s, selected[t]);
      if (!rate) { s.maxAheadMs = 0; return null; } // no bitrate yet: normal behaviour
      let held = 0;
      for (const [a, b, itag] of ranges[t]) {
        const ms = b - Math.max(a, playerTime - BEHIND_MS);
        if (ms > 0) held += (ms / 1000) * ((byteRate(s, itag) || rate) + OVERHEAD_BYTES_PER_SEC);
      }
      s.types[t] = selected[t];
      const free = SAFETY * limitBytes(t) - held;
      room = Math.min(room, Math.max(0, free) / (rate + OVERHEAD_BYTES_PER_SEC) * 1000);
    }
    // Also kept when full, so the player asks again after a chunk's worth has played.
    s.maxAheadMs = ahead - playerTime + room;
    state.maxAheadMs = Math.round(s.maxAheadMs);
    if (!room) return null;

    // The server sends about its readahead target past the reported position.
    const serverSends = s.serverTargetMs * SERVER_TARGET_MARGIN;
    const spoof = Math.round(Math.min(ahead - REPORTED_HEALTH_MS, ahead + room - serverSends));
    if (spoof <= playerTime) return null;
    state.spoofed++;
    log(`position ${playerTime} -> ${spoof} ms (buffered to ${ahead}, room for ${Math.round(room / 1000)} s more)`);
    return rebuild(body, top, {}, { 1: rebuild(abrBytes, abr, { 28: spoof }) });
  }

  // ---- response parts ----
  function onFormatInit(payload, cpn) {
    const m = parse(payload);
    const fmt = first(m, 2, 2), mime = first(m, 5, 2), end = first(m, 3, 0);
    if (!fmt) return;
    const itag = itagOf(bytesOf(payload, fmt));
    if (mime) {
      const type = new TextDecoder().decode(bytesOf(payload, mime)).split('/')[0];
      if (type === 'audio' || type === 'video') itagType.set(itag, type);
    }
    if (end?.v) session(cpn).ends.set(itag, end.v);
  }
  function onMediaHeader(payload, cpn) {
    const m = parse(payload);
    if (first(m, 8, 0)?.v) return; // init segment
    const itag = first(m, 3, 0)?.v, ms = first(m, 12, 0)?.v, bytes = first(m, 14, 0)?.v;
    if (!itag || !ms || !bytes) return;
    const s = session(cpn);
    const r = s.rates.get(itag) || { bytes: 0, ms: 0, recent: [] };
    r.bytes += bytes;
    r.ms += ms;
    r.recent.push([bytes, ms]);
    if (r.recent.length > RECENT_SEGMENTS) r.recent.shift();
    s.rates.set(itag, r);
  }
  function patchPolicy(payload, cpn) {
    const s = session(cpn);
    const m = parse(payload);
    const serverTarget = Math.max(first(m, 1, 0)?.v ?? 0, first(m, 2, 0)?.v ?? 0);
    if (serverTarget) s.serverTargetMs = serverTarget;
    if (s.complete || !s.maxAheadMs || !serverTarget) return payload;
    // Ask again whenever more than one chunk's worth is missing from the cap.
    const target = Math.round(Math.max(serverTarget, s.maxAheadMs - s.serverTargetMs * SERVER_TARGET_MARGIN));
    if (target <= serverTarget) return payload;
    state.patched++;
    return rebuild(payload, m, { 1: target, 2: target });
  }

  // UMP framing: [type][size][payload]..., varints with a leading-ones length prefix.
  function readUmpVarint(b, p) {
    if (p >= b.length) return null;
    const b0 = b[p];
    const n = b0 < 128 ? 1 : b0 < 192 ? 2 : b0 < 224 ? 3 : b0 < 240 ? 4 : 5;
    if (p + n > b.length) return null;
    let v;
    if (n === 1) v = b0;
    else if (n === 2) v = (b0 & 0x3f) + 64 * b[p + 1];
    else if (n === 3) v = (b0 & 0x1f) + 32 * (b[p + 1] + 256 * b[p + 2]);
    else if (n === 4) v = (b0 & 0x0f) + 16 * (b[p + 1] + 256 * (b[p + 2] + 256 * b[p + 3]));
    else v = b[p + 1] + 256 * (b[p + 2] + 256 * (b[p + 3] + 256 * b[p + 4]));
    return [v, p + n];
  }
  function umpVarint(v) {
    if (v < 128) return [v];
    if (v < 16384) return [128 | (v & 0x3f), v >> 6];
    if (v < 2097152) return [192 | (v & 0x1f), (v >> 5) & 255, v >> 13];
    if (v < 268435456) return [224 | (v & 0x0f), (v >> 4) & 255, (v >> 12) & 255, v >> 20];
    return [240, v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
  }
  const concat = (a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; };
  const HELD = new Set([PART_MEDIA_HEADER, PART_NEXT_REQUEST_POLICY, PART_FORMAT_INIT]);

  // Streams the response through; only the small parts it reads are held back.
  function transformUmp(response, cpn) {
    const reader = response.body.getReader();
    let pending = new Uint8Array(0);
    let passRemaining = 0;   // bytes of a pass-through payload still to forward
    let hold = null;         // { type, size, header } while collecting a held part
    let broken = false;      // after a parse error, forward bytes untouched

    const body = new ReadableStream({
      async pull(controller) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            if (hold) controller.enqueue(hold.header);
            if (pending.length) controller.enqueue(pending);
            controller.close();
            return;
          }
          if (broken) { controller.enqueue(value); return; }
          const chunk = pending.length ? concat(pending, value) : value;
          pending = new Uint8Array(0);
          const out = [];
          let p = 0;
          try {
            while (p < chunk.length) {
              if (passRemaining) {
                const n = Math.min(passRemaining, chunk.length - p);
                out.push(chunk.subarray(p, p + n));
                passRemaining -= n;
                p += n;
                continue;
              }
              if (hold) {
                if (chunk.length - p < hold.size) break;
                let payload = chunk.subarray(p, p + hold.size);
                p += hold.size;
                try {
                  if (hold.type === PART_MEDIA_HEADER) onMediaHeader(payload, cpn);
                  else if (hold.type === PART_FORMAT_INIT) onFormatInit(payload, cpn);
                  else payload = patchPolicy(payload, cpn);
                } catch (e) { state.errors++; log('part', hold.type, e); }
                out.push(Uint8Array.from([...umpVarint(hold.type), ...umpVarint(payload.length)]), payload);
                hold = null;
                continue;
              }
              const t = readUmpVarint(chunk, p);
              const s = t && readUmpVarint(chunk, t[1]);
              if (!s) break;
              const [type] = t, [size, next] = s;
              if (HELD.has(type) && size < 65536) {
                hold = { type, size, header: chunk.slice(p, next) };
              } else {
                out.push(chunk.subarray(p, next));
                passRemaining = size;
              }
              p = next;
            }
            if (p < chunk.length) pending = chunk.slice(p);
          } catch (e) {
            state.errors++;
            log('stream', e);
            broken = true;
            if (hold) out.push(hold.header);
            out.push(chunk.subarray(p));
            hold = null;
            pending = new Uint8Array(0);
          }
          let emitted = false;
          for (const c of out) if (c.length) { controller.enqueue(c); emitted = true; }
          if (emitted) return;
        }
      },
      cancel(reason) { return reader.cancel(reason); },
    });

    const headers = new Headers(response.headers);
    headers.delete('content-length'); // the body may change length
    const patched = new Response(body, { status: response.status, statusText: response.statusText, headers });
    for (const k of ['url', 'redirected', 'type']) {
      try { Object.defineProperty(patched, k, { value: response[k] }); } catch {}
    }
    return patched;
  }

  // ---- player readahead caps ----
  // Found by its constructor defaults (20 MiB video, 8 MiB audio, 120 s) so
  // it survives player updates that rename everything. On the watch page the
  // caps become: no time limit, and a byte budget sized to the browser limit
  // for the current bitrate. The player holds back anything past its budget,
  // which keeps it under the browser limit even when the server sends more.
  // Other players (Shorts, previews) keep YouTube's values.
  function playerBudget(type, original) {
    const s = sessions.get(state.lastCpn);
    const itag = s?.types[type];
    const rate = itag && byteRate(s, itag);
    if (!rate) return original;
    return (SAFETY * limitBytes(type) * rate) / (rate + OVERHEAD_BYTES_PER_SEC) / RATE_MARGIN;
  }
  function pin(obj, prop, value) {
    let original = obj[prop];
    try {
      Object.defineProperty(obj, prop, {
        get: () => (location.pathname === '/watch' ? value(original) : original),
        set: v => { original = v; },
        configurable: true,
        enumerable: true,
      });
    } catch {}
  }
  function patchPlayerClasses() {
    const ns = win._yt_player;
    if (!ns || ns.__ytfbPatched) return;
    ns.__ytfbPatched = true;
    for (const key of Object.keys(ns)) {
      const C = ns[key];
      if (typeof C !== 'function') continue;
      let src;
      try { src = Function.prototype.toString.call(C); } catch { continue; }
      if (!src.startsWith('class') || !src.includes('=20971520') || !src.includes('=8388608')) continue;
      const video = /this\.([\w$]+)=20971520[;,]/.exec(src)?.[1];
      const audio = /this\.([\w$]+)=8388608[;,]/.exec(src)?.[1];
      const secs = /this\.([\w$]+)=120[;,]/.exec(src)?.[1];
      if (!video || !audio || !secs) continue;
      ns[key] = class extends C {
        constructor(...args) {
          super(...args);
          pin(this, video, o => playerBudget('video', o));
          pin(this, audio, o => playerBudget('audio', o));
          pin(this, secs, () => 7 * 86400);
        }
      };
      state.policyClass = key;
      log(`player readahead caps lifted (_yt_player.${key})`);
    }
    if (!state.policyClass) log('player policy class not found; buffering stays capped at about 2 minutes');
  }
  document.addEventListener('load', e => {
    const s = e.target;
    if (s instanceof HTMLScriptElement && /\/s\/player\/.+\/base\.js/.test(s.src)) patchPlayerClasses();
  }, true);
  patchPlayerClasses();

  // ---- fetch hook ----
  const nativeFetch = win.fetch;
  win.fetch = async function fetch(input, init) {
    let cpn = null;
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      cpn = url && targetCpn(url);
    } catch {}
    if (!cpn) return nativeFetch.apply(this, arguments);

    state.requests++;
    state.lastCpn = cpn;
    let args = [input, init];
    try {
      const ownBody = init && 'body' in init;
      const src = ownBody ? init.body : input instanceof Request ? await input.clone().arrayBuffer() : null;
      const body = src instanceof ArrayBuffer ? new Uint8Array(src)
        : ArrayBuffer.isView(src) ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength) : null;
      const rewritten = body && body.length && rewriteRequest(body, cpn);
      if (rewritten) {
        args = input instanceof Request && !ownBody
          ? [new Request(input, { body: rewritten })]
          : [input, { ...init, body: rewritten }];
      }
    } catch (e) {
      state.errors++;
      log('request', e);
      args = [input, init];
    }

    const response = await nativeFetch.apply(this, args);
    if (!response.ok || !response.body) return response;
    try { return transformUmp(response, cpn); } catch (e) { state.errors++; log('response', e); return response; }
  };
})();
