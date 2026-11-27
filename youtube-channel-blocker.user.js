// ==UserScript==
// @name         YouTube Channel Blocker
// @namespace    better-web-scripts
// @version      1.0.0
// @description  Block YouTube channels like accounts on other social networks: their videos, Shorts, posts and comments disappear everywhere.
// @downloadURL  https://raw.githubusercontent.com/krashkanter/better-web-scripts/main/youtube-channel-blocker.user.js
// @updateURL    https://raw.githubusercontent.com/krashkanter/better-web-scripts/main/youtube-channel-blocker.user.js
// @match        https://www.youtube.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

/*
 * Where you can block:
 *   - "Block channel" in the ⋮ menu of videos, Shorts cards, comments and posts
 *   - a Block button next to Subscribe on watch pages, channel pages and the
 *     Shorts player
 * What blocking does:
 *   - hides the channel's videos, Shorts, playlists, posts and comments in
 *     feeds, search, the watch-page sidebar and comment sections
 *   - covers and pauses its videos and Shorts when you open one directly,
 *     with "Watch anyway" and "Unblock"
 *   - covers its channel page with a notice, with "View channel" and "Unblock"
 * Manage the list (unblock, export, import) from the Tampermonkey menu:
 * "Blocked channels".
 *
 * Channels are matched by @handle or channel ID taken from links on the page.
 * Cards that show no channel link (Shorts, the watch-page sidebar) are
 * resolved with YouTube's oEmbed endpoint, only while the list is non-empty.
 */
(() => {
  'use strict';

  const STORE = 'blockedChannels';
  const LOOKUPS_AT_ONCE = 3;

  // ---- Blocklist -----------------------------------------------------------
  // { [key]: { handle?, id?, name, added } }, keyed by lowercase @handle, or by
  // channel ID (UC...) for a channel blocked where no handle was shown.
  let blocked = readStore(GM_getValue(STORE, {}));
  let keys = new Set();
  let names = new Set();
  let nameless = false; // some entry's name is only its @handle or ID
  reindex();

  function readStore(value) {
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [key, entry] of Object.entries(value)) {
      if (!entry || typeof entry !== 'object') continue;
      const clean = { name: typeof entry.name === 'string' ? entry.name : '', added: typeof entry.added === 'string' ? entry.added : '' };
      if (typeof entry.handle === 'string' && entry.handle.startsWith('@')) clean.handle = entry.handle;
      if (typeof entry.id === 'string' && /^UC[\w-]{22}$/.test(entry.id)) clean.id = entry.id;
      if (clean.handle || clean.id) out[key] = clean;
    }
    return out;
  }

  function norm(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function reindex() {
    keys = new Set();
    names = new Set();
    nameless = false;
    for (const [key, entry] of Object.entries(blocked)) {
      keys.add(key);
      if (entry.handle) keys.add(entry.handle.toLowerCase());
      if (entry.id) keys.add(entry.id);
      if (hasDisplayName(entry)) names.add(norm(entry.name));
      else nameless = true;
    }
  }

  function hasDisplayName(entry) {
    return !!entry.name && !entry.name.startsWith('@') && entry.name !== entry.id;
  }

  const keyOf = ch => (ch.handle ? ch.handle.toLowerCase() : ch.id);

  function isBlocked(ch) {
    return !!ch && (!!(ch.handle && keys.has(ch.handle.toLowerCase())) || !!(ch.id && keys.has(ch.id)));
  }

  function matches(key, entry, ch) {
    const handle = ch.handle && ch.handle.toLowerCase();
    return !!(handle && (key === handle || (entry.handle && entry.handle.toLowerCase() === handle))) ||
      !!(ch.id && (key === ch.id || entry.id === ch.id));
  }

  function describe(ch) {
    if (ch.name && ch.handle && norm(ch.name) !== norm(ch.handle)) return `${ch.name} (${ch.handle})`;
    return ch.name || ch.handle || ch.id;
  }

  function block(ch) {
    if (!ch || !keyOf(ch) || isBlocked(ch)) return;
    const entry = { name: ch.name || ch.handle || ch.id, added: new Date().toISOString() };
    if (ch.handle) entry.handle = ch.handle;
    if (ch.id) entry.id = ch.id;
    blocked = { ...blocked, [keyOf(ch)]: entry };
    commit();
    toast(`Blocked ${describe(entry)}`, 'Undo', () => unblock(entry, true));
  }

  function unblock(ch, quiet) {
    const next = { ...blocked };
    for (const [key, entry] of Object.entries(next)) if (matches(key, entry, ch)) delete next[key];
    blocked = next;
    commit();
    if (!quiet) toast(`Unblocked ${describe(ch)}`);
  }

  function commit() {
    GM_setValue(STORE, blocked);
    reindex();
    refresh();
  }

  GM_addValueChangeListener(STORE, (_name, _old, value, remote) => {
    if (!remote) return;
    blocked = readStore(value);
    reindex();
    refresh();
  });

  // ---- Channel identity ----------------------------------------------------
  // A channel reference from a link: /@handle or /channel/UC...
  function channelFromHref(href, name) {
    if (!href) return null;
    let path;
    try { path = new URL(href, location.origin).pathname; } catch { return null; }
    let m = /^\/(@[^/?#]+)/.exec(path);
    if (m) {
      let handle = m[1];
      try { handle = decodeURIComponent(handle); } catch { /* keep as is */ }
      return { handle, name: name || undefined };
    }
    m = /^\/channel\/(UC[\w-]{22})(?:[/?#]|$)/.exec(path);
    return m ? { id: m[1], name: name || undefined } : null;
  }

  const CHANNEL_LINK = 'a[href^="/@"], a[href^="/channel/UC"], a[href^="https://www.youtube.com/@"], a[href^="https://www.youtube.com/channel/UC"]';

  // Feed entries that belong to one channel. Shorts and posts are wrapped, so
  // the wrapper is hidden instead (see hideTarget).
  const ITEMS = [
    'yt-lockup-view-model', 'ytm-shorts-lockup-view-model', 'ytd-rich-grid-media', 'ytd-video-renderer',
    'ytd-compact-video-renderer', 'ytd-grid-video-renderer', 'ytd-reel-item-renderer',
    'ytd-playlist-renderer', 'ytd-radio-renderer', 'ytd-channel-renderer', 'ytd-post-renderer'
  ].join(', ');

  const ownerItem = el => el.parentElement && el.parentElement.closest(ITEMS);

  function hideTarget(item) {
    // A video attached to a post is hidden on its own, not with the post.
    if (ownerItem(item)) return item;
    // Hide the grid cell or wrapper too, so no empty slot is left behind.
    return item.closest('ytd-rich-item-renderer') ||
      item.closest('[class*="GridShelfItem"], [class*="grid-shelf-item"]') ||
      item.closest('ytm-shorts-lockup-view-model-v2, ytd-backstage-post-thread-renderer') || item;
  }

  function itemChannel(item) {
    let found = null;
    for (const a of item.querySelectorAll(CHANNEL_LINK)) {
      if (a.closest(ITEMS) !== item) continue;
      const ch = channelFromHref(a.getAttribute('href'));
      if (!ch) continue;
      if (!found) found = ch;
      else if (keyOf(ch) !== keyOf(found)) continue;
      const text = a.textContent.trim();
      if (text && !found.name) found.name = text;
    }
    return found;
  }

  // The channel name printed on a card that has no channel link.
  function itemName(item) {
    const el = item.querySelector('yt-content-metadata-view-model [class*="MetadataText"], yt-content-metadata-view-model [class*="metadata-text"]');
    return el ? el.textContent.trim() : '';
  }

  function itemVideoId(item) {
    for (const a of item.querySelectorAll('a[href^="/watch?"], a[href^="/shorts/"]')) {
      if (a.closest(ITEMS) !== item) continue;
      const url = new URL(a.getAttribute('href'), location.origin);
      const id = url.pathname.startsWith('/shorts/') ? url.pathname.split('/')[2] : url.searchParams.get('v');
      if (/^[\w-]{11}$/.test(id || '')) return id;
    }
    return null;
  }

  // ---- Video owner lookups (oEmbed) ----------------------------------------
  const owners = new Map(); // video ID -> channel, or null if YouTube names none
  const failedAt = new Map();
  const queue = [];
  const queued = new Set();
  let lookupsRunning = 0;

  async function fetchOwner(id) {
    const target = encodeURIComponent(`https://www.youtube.com/watch?v=${id}`);
    const response = await fetch(`/oembed?format=json&url=${target}`, {
      credentials: 'omit', signal: AbortSignal.timeout(10000)
    });
    // Private, removed and unembeddable videos have no public owner.
    if ([400, 401, 403, 404].includes(response.status)) return null;
    if (!response.ok) throw new Error(`oEmbed ${response.status}`);
    const data = await response.json();
    return channelFromHref(data.author_url, data.author_name);
  }

  function lookup(id) {
    if (owners.has(id) || queued.has(id) || Date.now() - (failedAt.get(id) || 0) < 60000) return;
    queued.add(id);
    queue.push(id);
    pump();
  }

  function pump() {
    while (lookupsRunning < LOOKUPS_AT_ONCE && queue.length) {
      const id = queue.shift();
      lookupsRunning++;
      fetchOwner(id).then(ch => {
        owners.set(id, ch);
        failedAt.delete(id);
        learnName(ch);
      }).catch(() => {
        failedAt.set(id, Date.now());
      }).finally(() => {
        queued.delete(id);
        lookupsRunning--;
        schedule();
        pump();
      });
    }
  }

  // Blocks made from a comment or an import know only the @handle; take the
  // display name from the first lookup that names the channel.
  function learnName(ch) {
    if (!ch || !ch.name || !isBlocked(ch)) return;
    for (const [key, entry] of Object.entries(blocked)) {
      if (!matches(key, entry, ch) || hasDisplayName(entry)) continue;
      blocked = { ...blocked, [key]: { ...entry, name: ch.name } };
      commit();
      return;
    }
  }

  async function ownerOf(id) {
    if (owners.has(id)) return owners.get(id);
    const ch = await fetchOwner(id);
    owners.set(id, ch);
    return ch;
  }

  // ---- Hiding --------------------------------------------------------------
  function setHidden(el, hidden) {
    if (hidden === el.hasAttribute('data-ytcb-hidden')) return;
    if (hidden) el.setAttribute('data-ytcb-hidden', '');
    else el.removeAttribute('data-ytcb-hidden');
  }

  function itemBlocked(item) {
    const ch = itemChannel(item);
    if (ch) return isBlocked(ch);
    const id = itemVideoId(item);
    if (!id) return false;
    const name = itemName(item);
    const nameMatch = !!name && names.has(norm(name));
    // Videos YouTube won't describe (embedding disabled) fall back to the name.
    if (owners.has(id)) return owners.get(id) ? isBlocked(owners.get(id)) : nameMatch;
    // Look up cards that print no name (Shorts) or a blocked channel's name,
    // and hide the latter until the lookup confirms or clears it. While some
    // block has no display name, every card is looked up.
    if (name && !nameMatch && !nameless) return false;
    lookup(id);
    return nameMatch;
  }

  function commentChannel(comment) {
    const a = comment.querySelector('#author-text') || comment.querySelector(CHANNEL_LINK);
    return a ? channelFromHref(a.getAttribute('href'), a.textContent.trim()) : null;
  }

  function commentTarget(comment) {
    if (comment.closest('ytd-comment-replies-renderer')) return comment;
    return comment.closest('ytd-comment-thread-renderer') || comment;
  }

  // ---- Watch page and Shorts -----------------------------------------------
  const allowedVideos = new Set(); // "Watch anyway", for this tab
  const allowedChannels = new Set(); // "View channel", for this tab

  function watchOwner() {
    if (location.pathname !== '/watch') return null;
    const a = document.querySelector('ytd-watch-metadata #owner ytd-video-owner-renderer a[href]');
    if (!a) return null;
    const ch = channelFromHref(a.getAttribute('href'));
    const name = document.querySelector('ytd-watch-metadata #owner ytd-channel-name a');
    if (ch && name) ch.name = name.textContent.trim() || ch.name;
    return ch;
  }

  function shortsId() {
    const m = /^\/shorts\/([\w-]{11})/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function activeReel() {
    // Older Shorts pages keep several reels and mark one active; the current
    // one renders a single reel holding the player.
    const active = document.querySelector('ytd-shorts ytd-reel-video-renderer[is-active]');
    if (active) return active;
    const reels = [...document.querySelectorAll('ytd-shorts ytd-reel-video-renderer')].filter(r => r.querySelector('video'));
    return reels.length === 1 ? reels[0] : null;
  }

  // The owner of the current Short. The channel bar lags behind when moving
  // to the next Short, so the wall waits for the lookup; only the menu falls
  // back to the bar (withBar).
  function shortsOwner(withBar) {
    const id = shortsId();
    if (!id) return null;
    if (owners.has(id)) return owners.get(id);
    if (keys.size || withBar) lookup(id);
    if (!withBar) return null;
    const reel = activeReel();
    const a = reel && reel.querySelector('yt-reel-channel-bar-view-model a[href], ytd-channel-name a[href]');
    return a ? channelFromHref(a.getAttribute('href')) : null;
  }

  function pause(video, videoId) {
    video.dataset.ytcbPausedFor = videoId;
    if (!video.paused) video.pause();
  }

  function currentVideoId() {
    return shortsId() || (location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null);
  }

  // Videos under a notice stay paused, whatever starts them. A notice left
  // over from the previous video (Shorts reuse one player) is dropped instead.
  document.addEventListener('play', e => {
    for (const wall of document.querySelectorAll('.ytcb-wall')) {
      if (!wall.parentElement || !wall.parentElement.contains(e.target)) continue;
      if (wall.dataset.video === currentVideoId()) pause(e.target, wall.dataset.video);
      else wall.remove();
    }
  }, true);

  function syncWall(kind, host, ch, videoId) {
    const show = !!(host && ch && videoId && isBlocked(ch) && !allowedVideos.has(videoId));
    for (const old of document.querySelectorAll(`.ytcb-wall[data-kind="${kind}"]`)) {
      if (!show || old.parentElement !== host || old.dataset.video !== videoId) old.remove();
    }
    if (!show) return;
    if (!host.querySelector(':scope > .ytcb-wall')) {
      const buttons = [
        button('Watch anyway', () => {
          allowedVideos.add(videoId);
          refresh();
          const video = host.querySelector('video');
          if (video) video.play().catch(() => {});
        }),
        button('Unblock', () => unblock(ch))
      ];
      if (kind === 'shorts') {
        buttons.unshift(button('Next Short', () => {
          const next = document.querySelector('ytd-shorts #navigation-button-down button');
          if (next) next.click();
        }, 'ytcb-primary'));
      }
      host.append(h('div', { class: 'ytcb-wall', 'data-kind': kind, 'data-video': videoId },
        h('div', { class: 'ytcb-wall-box' },
          blockIcon(),
          h('div', { class: 'ytcb-wall-title' }, `You blocked ${describe(ch)}`),
          h('div', { class: 'ytcb-wall-text' }, 'This video is hidden because you blocked its channel.'),
          h('div', { class: 'ytcb-wall-actions' }, buttons))));
    }
    for (const video of host.querySelectorAll('video')) pause(video, videoId);
  }

  // The player keeps a paused state into the next video (Shorts share one
  // player), so a video paused for a notice is resumed once another video is
  // showing and no notice covers it.
  function resumeSkipped() {
    const current = currentVideoId();
    if (!current) return;
    const owner = shortsId() ? owners.get(current) : watchOwner();
    for (const video of document.querySelectorAll('video[data-ytcb-paused-for]')) {
      if ([...document.querySelectorAll('.ytcb-wall')].some(w => w.parentElement && w.parentElement.contains(video))) continue;
      // Resume only once the video showing is known not to need the notice:
      // another video, "Watch anyway", or an owner that turned out unblocked.
      const cleared = current !== video.dataset.ytcbPausedFor || allowedVideos.has(current) || (owner && !isBlocked(owner));
      if (!cleared) continue;
      delete video.dataset.ytcbPausedFor;
      if (video.paused) video.play().catch(() => {});
    }
  }

  function syncWatch() {
    const ch = watchOwner();
    const owner = ch && document.querySelector('ytd-watch-metadata #owner');
    if (owner) headerButton(owner, owner.querySelector(':scope > #subscribe-button'), ch);
    const host = document.querySelector('ytd-watch-flexy #movie_player');
    syncWall('watch', host, ch, new URLSearchParams(location.search).get('v'));
  }

  function syncShorts() {
    const id = shortsId();
    const reel = id && activeReel();
    const host = reel && (reel.querySelector('#player-container') || reel);
    syncWall('shorts', host, id ? shortsOwner() : null, id);
    // The Shorts player has no ⋮ menu, so Block sits next to the channel name.
    const bar = reel && reel.querySelector('yt-reel-channel-bar-view-model');
    const ch = bar && shortsOwner(true);
    // Inside the bar's row, after Subscribe.
    const row = bar && (bar.firstElementChild && getComputedStyle(bar.firstElementChild).display.includes('flex') ? bar.firstElementChild : bar);
    if (ch) headerButton(row, null, ch, 'ytcb-shorts-btn');
  }

  // ---- Channel page ----------------------------------------------------------
  function channelPage() {
    if (!/^\/(@|channel\/|c\/|user\/)/.test(location.pathname)) return null;
    const browse = document.querySelector('ytd-browse[page-subtype="channels"]:not([hidden])');
    const header = browse && browse.querySelector('yt-page-header-view-model');
    if (!header) return null;
    const ch = channelFromHref(location.pathname) || {};
    if (!ch.handle) {
      const handle = [...header.querySelectorAll('span')].map(s => s.textContent.trim()).find(t => /^@[^\s@]+$/.test(t));
      if (handle) ch.handle = handle;
    }
    if (!ch.handle && !ch.id) return null;
    const title = header.querySelector('h1');
    ch.name = (title && title.textContent.replace(/\s+/g, ' ').trim()) || ch.handle || ch.id;
    return { ch, browse, header };
  }

  function syncChannel() {
    const page = channelPage();
    const key = page && keyOf(page.ch);
    const cover = !!(page && isBlocked(page.ch) && !allowedChannels.has(key));
    for (const el of document.querySelectorAll('ytd-browse[data-ytcb-blocked]')) {
      if (!cover || el !== page.browse) el.removeAttribute('data-ytcb-blocked');
    }
    for (const el of document.querySelectorAll('.ytcb-banner')) {
      if (!cover || el.dataset.key !== key) el.remove();
    }
    if (!page) return;
    const actions = page.header.querySelector('yt-flexible-actions-view-model');
    if (actions) headerButton(actions, null, page.ch);
    if (!cover) return;
    page.browse.setAttribute('data-ytcb-blocked', '');
    if (!document.querySelector('.ytcb-banner')) {
      const ch = page.ch;
      page.header.after(h('div', { class: 'ytcb-banner', 'data-key': key },
        blockIcon(),
        h('div', { class: 'ytcb-banner-text' },
          h('div', { class: 'ytcb-wall-title' }, `You blocked ${describe(ch)}`),
          h('div', { class: 'ytcb-wall-text' }, 'Their videos, Shorts, posts and comments are hidden across YouTube.')),
        h('div', { class: 'ytcb-wall-actions' },
          button('View channel', () => { allowedChannels.add(key); refresh(); }),
          button('Unblock', () => unblock(ch)))));
    }
  }

  // ---- Buttons and menus ---------------------------------------------------
  function headerButton(parent, after, ch, extraClass) {
    let b = parent.querySelector(':scope > .ytcb-header-btn');
    if (!b) {
      b = button('', () => {
        const target = b.ytcbChannel;
        if (target) (isBlocked(target) ? unblock(target) : block(target));
      }, `ytcb-header-btn${extraClass ? ` ${extraClass}` : ''}`);
      if (after) after.after(b); else parent.append(b);
    }
    b.ytcbChannel = ch;
    const text = isBlocked(ch) ? 'Unblock' : 'Block';
    if (b.textContent !== text) b.textContent = text;
    const title = `${text} ${describe(ch)}`;
    if (b.title !== title) b.title = title;
  }

  // The ⋮ menu that was opened last, and how to find its channel.
  let opener = null;
  let openerSeq = 0;

  // The ⋮ buttons of cards, comments, the watch page and Shorts, but not the
  // Save, Share or Subscribe buttons that also open popups.
  function isMenuButton(btn) {
    if (btn.closest('ytd-popup-container, #top-level-buttons-computed, #flexible-item-buttons, ytd-subscribe-button-renderer, yt-subscribe-button-view-model')) return false;
    return !!btn.closest('ytd-menu-renderer, #action-menu, #menu-button, [class*="MenuButton"], [class*="menu-button"], [class*="MetadataMenu"]');
  }

  function contextFor(el) {
    const comment = el.closest('ytd-comment-view-model');
    if (comment) {
      const ch = commentChannel(comment);
      return ch && { known: ch, get: async () => ch };
    }
    const item = el.closest(ITEMS);
    if (item) {
      const ch = itemChannel(item);
      const id = itemVideoId(item);
      const known = ch || (id && owners.get(id)) || null;
      if (!known && !id) return null;
      return { known, get: async () => known || ownerOf(id) };
    }
    if (el.closest('ytd-shorts')) {
      const id = shortsId();
      const known = shortsOwner(true);
      return id && { known, get: async () => (await ownerOf(id).catch(() => null)) || known };
    }
    if (el.closest('ytd-watch-metadata')) {
      const ch = watchOwner();
      return ch && { known: ch, get: async () => ch };
    }
    return null;
  }

  document.addEventListener('click', e => {
    // YouTube clicks some menu buttons itself while building the page.
    if (!e.isTrusted || !(e.target instanceof Element) || e.target.closest('.ytcb-menu-item')) return;
    const btn = e.target.closest('button, yt-icon-button, [role="button"]');
    const ctx = btn && isMenuButton(btn) && contextFor(btn);
    opener = ctx ? { ...ctx, seq: ++openerSeq } : null;
    if (opener) setTimeout(syncMenus, 0);
  }, true);

  function closeMenus() {
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, composed: true
    }));
  }

  function syncMenus() {
    const container = document.querySelector('ytd-popup-container');
    if (!container) return;
    for (const dropdown of container.querySelectorAll('tp-yt-iron-dropdown')) {
      const open = dropdown.style.display !== 'none';
      const list = dropdown.querySelector('yt-list-view-model[role="menu"], tp-yt-paper-listbox#items, tp-yt-paper-listbox');
      const old = dropdown.querySelector('.ytcb-menu-item');
      const want = open && list && opener;
      if (old && (!want || old.dataset.seq !== String(opener.seq) || old.parentElement !== list)) old.remove();
      if (!want || list.querySelector(':scope > .ytcb-menu-item')) continue;
      const ctx = opener;
      const unblocking = isBlocked(ctx.known);
      const item = h('button', { class: 'ytcb-menu-item', type: 'button', role: 'menuitem', 'data-seq': String(ctx.seq) },
        blockIcon(), h('span', {}, unblocking ? 'Unblock channel' : 'Block channel'));
      item.addEventListener('click', async e => {
        e.preventDefault();
        e.stopPropagation();
        closeMenus();
        let ch = null;
        try { ch = await ctx.get(); } catch { /* reported below */ }
        if (!ch) { toast("Couldn't find this video's channel"); return; }
        if (isBlocked(ch)) unblock(ch); else block(ch);
      });
      list.append(item);
    }
  }

  // ---- Manager -------------------------------------------------------------
  function openManager() {
    document.querySelector('.ytcb-dialog-backdrop')?.remove();
    const list = h('div', { class: 'ytcb-list' });
    const io = h('textarea', { class: 'ytcb-io', spellcheck: 'false', placeholder: 'Paste an exported list, or @handles and channel links, one per line' });
    const count = h('span');
    const backdrop = h('div', { class: 'ytcb-dialog-backdrop' });
    const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

    const render = () => {
      const entries = Object.values(blocked).sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
      count.textContent = ` (${entries.length})`;
      list.replaceChildren(...(entries.length ? entries.map(entry => h('div', { class: 'ytcb-row' },
        h('a', { href: entry.handle ? `/${entry.handle}` : `/channel/${entry.id}`, class: 'ytcb-row-name', target: '_blank' }, entry.name || entry.handle || entry.id),
        h('span', { class: 'ytcb-row-sub' }, entry.handle && norm(entry.handle) !== norm(entry.name) ? entry.handle : ''),
        button('Unblock', () => { unblock(entry); render(); }))) : [h('div', { class: 'ytcb-empty' }, 'No blocked channels. Use "Block channel" in any ⋮ menu, or Block next to Subscribe.')]));
    };

    const doExport = () => {
      io.value = JSON.stringify(blocked, null, 2);
      io.select();
      navigator.clipboard?.writeText(io.value).then(() => toast('Blocked channels copied'), () => {});
    };

    const doImport = () => {
      const added = importList(io.value);
      if (added < 0) { toast("That doesn't look like a list of channels"); return; }
      io.value = '';
      render();
      toast(`Imported ${added} channel${added === 1 ? '' : 's'}`);
    };

    backdrop.append(h('div', { class: 'ytcb-dialog', role: 'dialog', 'aria-label': 'Blocked channels' },
      h('div', { class: 'ytcb-dialog-title' }, 'Blocked channels', count),
      list,
      io,
      h('div', { class: 'ytcb-wall-actions' },
        button('Export', doExport), button('Import', doImport), button('Close', close, 'ytcb-primary'))));
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    render();
  }

  // Accepts an exported object, or @handles / channel URLs / IDs separated by
  // whitespace or commas. Returns how many were added, or -1 if unreadable.
  const HANDLE = /^@[\p{L}\p{N}\p{M}._·-]{1,100}$/u;

  function importList(text) {
    text = text.trim();
    if (!text) return -1;
    const found = [];
    try {
      const data = JSON.parse(text);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const entry of Object.values(data)) {
          if (!entry || typeof entry !== 'object') continue;
          const handle = typeof entry.handle === 'string' && HANDLE.test(entry.handle) ? entry.handle : undefined;
          const id = typeof entry.id === 'string' && /^UC[\w-]{22}$/.test(entry.id) ? entry.id : undefined;
          if (handle || id) found.push({ handle, id, name: typeof entry.name === 'string' ? entry.name : undefined, added: entry.added });
        }
      } else if (Array.isArray(data)) {
        text = data.join('\n');
      }
    } catch { /* plain text */ }
    if (!found.length) {
      for (const token of text.split(/[\s,]+/)) {
        const t = token.replace(/^["'{[]+|["':}\],]+$/g, '');
        const ch = t.startsWith('@') ? channelFromHref(`/${t}`) : /^UC[\w-]{22}$/.test(t) ? { id: t } : channelFromHref(t);
        if (ch && (!ch.handle || HANDLE.test(ch.handle))) found.push(ch);
      }
    }
    if (!found.length) return -1;
    const next = { ...blocked };
    let added = 0;
    for (const ch of found) {
      const key = keyOf(ch);
      if (!key || isBlocked(ch) || next[key]) continue;
      const entry = { name: ch.name || ch.handle || ch.id, added: typeof ch.added === 'string' ? ch.added : new Date().toISOString() };
      if (ch.handle) entry.handle = ch.handle;
      if (ch.id) entry.id = ch.id;
      next[key] = entry;
      added++;
    }
    blocked = next;
    commit();
    return added;
  }

  GM_registerMenuCommand('Blocked channels', openManager);

  // ---- UI helpers ----------------------------------------------------------
  // YouTube enforces Trusted Types, so everything is built without innerHTML.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value == null) continue;
      if (name === 'class') el.className = value;
      else el.setAttribute(name, value);
    }
    el.append(...children.flat().filter(c => c != null && c !== ''));
    return el;
  }

  function button(text, onClick, extraClass) {
    const b = h('button', { type: 'button', class: `ytcb-btn${extraClass ? ` ${extraClass}` : ''}` }, text);
    b.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      onClick(e);
    });
    return b;
  }

  function blockIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'ytcb-icon');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM4 12a8 8 0 0 1 12.9-6.32L5.68 16.9A7.95 7.95 0 0 1 4 12zm8 8a7.95 7.95 0 0 1-4.9-1.68L18.32 7.1A8 8 0 0 1 12 20z');
    svg.append(path);
    return svg;
  }

  let toastTimer;
  function toast(text, action, onAction) {
    document.querySelector('.ytcb-toast')?.remove();
    clearTimeout(toastTimer);
    const el = h('div', { class: 'ytcb-toast', role: 'status' }, h('span', {}, text));
    if (action) el.append(button(action, () => { el.remove(); onAction(); }, 'ytcb-toast-action'));
    document.body.append(el);
    toastTimer = setTimeout(() => el.remove(), 6000);
  }

  GM_addStyle(`
    :root {
      --ytcb-text: #0f0f0f; --ytcb-bg: #fff; --ytcb-tonal: rgba(0, 0, 0, .05); --ytcb-tonal-hover: rgba(0, 0, 0, .1);
      --ytcb-line: rgba(0, 0, 0, .1); --ytcb-link: #065fd4; --ytcb-toast: #f1f1f1;
    }
    html[dark] {
      --ytcb-text: #f1f1f1; --ytcb-bg: #212121; --ytcb-tonal: rgba(255, 255, 255, .1); --ytcb-tonal-hover: rgba(255, 255, 255, .2);
      --ytcb-line: rgba(255, 255, 255, .1); --ytcb-link: #3ea6ff; --ytcb-toast: #212121;
    }
    [data-ytcb-hidden] { display: none !important; }
    ytd-browse[data-ytcb-blocked] ytd-two-column-browse-results-renderer,
    ytd-browse[data-ytcb-blocked] #tabs-container,
    ytd-browse[data-ytcb-blocked] yt-tab-group-shape { display: none !important; }
    .ytcb-icon { width: 24px; height: 24px; fill: currentColor; flex: none; }
    .ytcb-btn {
      display: inline-flex; align-items: center; justify-content: center; height: 36px; padding: 0 16px;
      border: 0; border-radius: 18px; cursor: pointer; white-space: nowrap; flex: none;
      font: 500 14px/36px Roboto, Arial, sans-serif;
      background: var(--ytcb-tonal); color: var(--ytcb-text);
    }
    .ytcb-btn:hover { background: var(--ytcb-tonal-hover); }
    .ytcb-btn.ytcb-primary { background: var(--ytcb-text); color: var(--ytcb-bg); }
    .ytcb-header-btn { margin-left: 8px; }
    /* Channel header: same size as Subscribe, whose wrapper already adds the gap. */
    .ytcb-shorts-btn { height: 36px; line-height: 36px; padding: 0 14px; margin-left: 8px; align-self: center; background: rgba(255, 255, 255, .2); color: #fff; backdrop-filter: blur(8px); }
    .ytcb-shorts-btn:hover { background: rgba(255, 255, 255, .3); }
    yt-flexible-actions-view-model .ytcb-header-btn { margin: 0; height: 40px; line-height: 40px; border-radius: 20px; align-self: flex-start; }
    .ytcb-menu-item {
      display: flex; align-items: center; gap: 16px; width: 100%; min-height: 36px; padding: 0 36px 0 16px;
      box-sizing: border-box; border: 0; background: none; cursor: pointer; text-align: left;
      color: var(--ytcb-text); font: 400 14px/20px Roboto, Arial, sans-serif;
    }
    /* Older menus (comments) are sized before the item is added. */
    ytd-menu-popup-renderer:has(.ytcb-menu-item) { max-width: none !important; max-height: none !important; }
    .ytcb-menu-item:hover, .ytcb-menu-item:focus-visible { background: var(--ytcb-line); outline: none; }
    .ytcb-wall {
      position: absolute; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
      background: #0f0f0f; color: #fff; font-family: Roboto, Arial, sans-serif; border-radius: inherit;
    }
    .ytcb-wall-box { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 24px; text-align: center; max-width: 420px; }
    .ytcb-wall-box > .ytcb-icon { width: 48px; height: 48px; opacity: .8; }
    .ytcb-wall-title { font-size: 18px; font-weight: 500; line-height: 26px; }
    .ytcb-wall-text { font-size: 14px; line-height: 20px; opacity: .75; }
    .ytcb-wall-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 8px; }
    .ytcb-wall .ytcb-btn { background: rgba(255, 255, 255, .15); color: #fff; }
    .ytcb-wall .ytcb-btn:hover { background: rgba(255, 255, 255, .25); }
    .ytcb-wall .ytcb-btn.ytcb-primary { background: #fff; color: #0f0f0f; }
    .ytcb-banner {
      display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin: 16px 0; padding: 16px 20px; border-radius: 12px;
      background: var(--ytcb-tonal); color: var(--ytcb-text);
      font-family: Roboto, Arial, sans-serif;
    }
    .ytcb-banner-text { flex: 1; min-width: 240px; }
    .ytcb-banner .ytcb-wall-actions { margin: 0; }
    .ytcb-toast {
      position: fixed; left: 24px; bottom: 24px; z-index: 10002; display: flex; align-items: center; gap: 12px;
      max-width: calc(100vw - 48px); box-sizing: border-box; padding: 6px 8px 6px 16px; min-height: 48px; border-radius: 8px;
      background: var(--ytcb-toast); color: var(--ytcb-text); font: 400 14px/20px Roboto, Arial, sans-serif; box-shadow: 0 4px 16px rgba(0, 0, 0, .3);
    }
    .ytcb-toast .ytcb-toast-action { background: none; color: var(--ytcb-link); }
    .ytcb-dialog-backdrop {
      position: fixed; inset: 0; z-index: 10001; display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, .5); font-family: Roboto, Arial, sans-serif;
    }
    .ytcb-dialog {
      display: flex; flex-direction: column; gap: 12px; width: min(520px, calc(100vw - 32px)); max-height: calc(100vh - 64px);
      box-sizing: border-box; padding: 20px 24px; border-radius: 12px;
      background: var(--ytcb-bg); color: var(--ytcb-text);
    }
    .ytcb-dialog-title { font-size: 20px; font-weight: 500; line-height: 28px; }
    .ytcb-list { overflow: auto; min-height: 48px; display: flex; flex-direction: column; }
    .ytcb-row { display: flex; align-items: center; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--ytcb-line); font-size: 14px; }
    .ytcb-row-name { color: inherit; text-decoration: none; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ytcb-row-name:hover { text-decoration: underline; }
    .ytcb-row-sub { flex: 1; opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ytcb-empty { font-size: 14px; opacity: .75; padding: 8px 0; }
    .ytcb-io {
      min-height: 72px; resize: vertical; box-sizing: border-box; padding: 8px; border-radius: 8px; font: 12px/16px monospace;
      border: 1px solid var(--ytcb-line); background: transparent; color: inherit;
    }
    .ytcb-dialog .ytcb-wall-actions { justify-content: flex-end; }
  `);

  // ---- Scanning ------------------------------------------------------------
  function scan() {
    scheduled = false;
    const any = keys.size > 0;
    for (const item of document.querySelectorAll(ITEMS)) setHidden(hideTarget(item), any && itemBlocked(item));
    for (const comment of document.querySelectorAll('ytd-comment-view-model')) {
      setHidden(commentTarget(comment), any && isBlocked(commentChannel(comment)));
    }
    syncWatch();
    syncShorts();
    resumeSkipped();
    syncChannel();
    syncMenus();
  }

  let scheduled = false;
  function schedule() {
    if (!scheduled) { scheduled = true; setTimeout(scan, 150); }
  }

  function refresh() {
    scan();
  }

  // Menus open by changing a dropdown's style, so only the popup container is
  // watched for style changes; the player changes styles constantly.
  const menuObserver = new MutationObserver(syncMenus);
  let watchedPopups = null;
  new MutationObserver(records => {
    if (records.every(r => r.target instanceof Element && r.target.closest('.html5-video-player'))) return;
    const popups = document.querySelector('ytd-popup-container');
    if (popups && popups !== watchedPopups) {
      menuObserver.disconnect();
      menuObserver.observe(popups, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
      watchedPopups = popups;
    }
    schedule();
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'is-active'] });
  addEventListener('yt-navigate-finish', scan);
  schedule();
})();
