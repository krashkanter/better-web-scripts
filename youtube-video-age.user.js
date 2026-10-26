// ==UserScript==
// @name         YouTube Video Age
// @namespace    better-web-scripts
// @version      1.0.0
// @description  Show YouTube video ages as years.months using exact upload dates.
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
    return `${years}.${months} ${years === 1 && months === 0 ? 'year' : 'years'} old`;
  }

  const cards = 'ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, yt-lockup-view-model';
  const labels = '#metadata-line .inline-metadata-item, .yt-content-metadata-view-model__metadata-text';
  const dates = new Map();
  const pending = new Set();
  const queue = [];
  let running = 0;
  let scheduled = false;

  function videoId(card) {
    const link = card.querySelector('a[href*="/watch?"]');
    return link ? new URL(link.href, location.origin).searchParams.get('v') : null;
  }

  async function loadDate(id) {
    const response = await fetch(`/watch?v=${encodeURIComponent(id)}&hl=en`, {
      credentials: 'omit', signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('Upload date unavailable');
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    return dateOnly(doc.querySelector('meta[itemprop="uploadDate"], meta[itemprop="datePublished"]')?.content);
  }

  function pump() {
    while (running < 3 && queue.length) {
      const id = queue.shift();
      running++;
      loadDate(id).then(date => dates.set(id, date)).catch(() => {
        dates.set(id, null); // Leave YouTube's label intact on failure; no retry storm.
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
        if (!pending.has(id)) { pending.add(id); queue.push(id); }
        continue;
      }
      const date = dates.get(id);
      const text = date && formatAge(date);
      if (!text) continue;
      for (const el of targets) {
        if (el.textContent === text && el.dataset.videoAgeId === id) continue;
        el.dataset.videoAgeOriginal = el.textContent;
        el.dataset.videoAgeId = id;
        el.dataset.videoAgeText = text;
        el.textContent = text;
        el.title = `Uploaded ${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} · years.months`;
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
