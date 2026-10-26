// ==UserScript==
// @name         YouTube Video Age
// @namespace    better-web-scripts
// @version      1.1.0
// @description  Show YouTube video ages in years and months using exact upload dates.
// @downloadURL  https://raw.githubusercontent.com/krashkanter/better-web-scripts/main/youtube-video-age.user.js
// @updateURL    https://raw.githubusercontent.com/krashkanter/better-web-scripts/main/youtube-video-age.user.js
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  // Calendar dates, independent of the timezone in the upload timestamp.
  function dateOnly(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
    return match ? new Date(+match[1], +match[2] - 1, +match[3]) : null;
  }

  function anniversary(date, months) {
    const result = new Date(date.getFullYear(), date.getMonth() + months, 1);
    const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(date.getDate(), lastDay));
    return result;
  }

  function formatAge(upload, now = new Date()) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (upload > today) return null;
    let years = today.getFullYear() - upload.getFullYear();
    if (anniversary(upload, years * 12) > today) years--;
    let months = 0;
    // Round partial months up; never roll the year over before its anniversary.
    while (months < 12 && anniversary(upload, years * 12 + months) < today) months++;
    const parts = [];
    if (years) parts.push(`${years} year${years === 1 ? '' : 's'}`);
    if (months) parts.push(`${months} month${months === 1 ? '' : 's'}`);
    return parts.length ? `${parts.join(' ')} old` : 'Uploaded today';
  }

  const cards = 'ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, yt-lockup-view-model';
  const labels = '#metadata-line .inline-metadata-item, .yt-content-metadata-view-model__metadata-text';
  const dates = new Map();
  const pending = new Set();
  const retryAfter = new Map();
  const queue = [];
  let running = 0;
  let scheduled = false;

  function videoId(card) {
    const link = card.querySelector('a[href*="/watch?"]');
    return link ? new URL(link.href, location.origin).searchParams.get('v') : null;
  }

  function dateFromHTML(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const meta = doc.querySelector('meta[itemprop="uploadDate"], meta[itemprop="datePublished"]');
    // Watch responses can put the exact date only in the embedded player JSON.
    const embedded = /"(?:uploadDate|publishDate|datePublished)"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"\\]*)"/.exec(html);
    return dateOnly(meta?.content) || dateOnly(embedded?.[1]);
  }

  async function loadDate(id) {
    const response = await fetch(`/watch?v=${encodeURIComponent(id)}&hl=en`, {
      credentials: 'same-origin', signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('Upload date unavailable');
    const date = dateFromHTML(await response.text());
    if (!date) throw new Error('Upload date unavailable');
    return date;
  }

  function pump() {
    while (running < 3 && queue.length) {
      const id = queue.shift();
      running++;
      loadDate(id).then(date => {
        dates.set(id, date);
        retryAfter.delete(id);
      }).catch(() => {
        // A temporary failure must not disable a video for the entire session.
        retryAfter.set(id, Date.now() + 5 * 60000);
      }).finally(() => {
        pending.delete(id);
        running--;
        schedule();
        pump();
      });
    }
  }

  function scan() {
    scheduled = false;
    for (const card of document.querySelectorAll(cards)) {
      const rect = card.getBoundingClientRect();
      if (!rect.width || rect.bottom < 0 || rect.top > innerHeight) continue;
      const id = videoId(card);
      if (!id || !/^[\w-]{11}$/.test(id)) continue;
      const targets = [...card.querySelectorAll(labels)].filter(el =>
        /\bago\b/.test(el.textContent) || el.dataset.videoAgeId);
      if (!targets.length) continue;
      // Recycled cards must not keep the previous video's age while loading.
      for (const el of targets) {
        if (el.dataset.videoAgeId && el.dataset.videoAgeId !== id) {
          if (el.textContent === el.dataset.videoAgeText) el.textContent = el.dataset.videoAgeOriginal;
          delete el.dataset.videoAgeId;
          el.removeAttribute('title');
        }
      }
      if (!dates.has(id)) {
        if (!pending.has(id) && !(retryAfter.get(id) > Date.now())) {
          pending.add(id);
          queue.push(id);
        }
        continue;
      }
      const date = dates.get(id);
      const text = date && formatAge(date);
      if (!text) continue;
      for (const el of targets) {
        if (el.textContent === text && el.dataset.videoAgeId === id) continue;
        if (el.textContent !== el.dataset.videoAgeText) el.dataset.videoAgeOriginal = el.textContent;
        el.dataset.videoAgeId = id;
        el.dataset.videoAgeText = text;
        el.textContent = text;
        el.title = `Uploaded ${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      }
    }
    pump();
  }

  function schedule() {
    if (!scheduled) { scheduled = true; setTimeout(scan, 150); }
  }

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  addEventListener('scroll', schedule, { passive: true, capture: true });
  addEventListener('resize', schedule);
  addEventListener('yt-navigate-finish', schedule);
  setInterval(schedule, 60000);
  schedule();
})();
