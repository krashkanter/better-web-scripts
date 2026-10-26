// ==UserScript==
// @name         YouTube Max Quality
// @namespace    open-untrap
// @version      1.0.0
// @description  Load YouTube videos in the highest available resolution
// @match        *://www.youtube.com/*
// @match        *://m.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  let timer;
  const apply = (n = 0) => {
    clearTimeout(timer);
    const p = document.getElementById('movie_player');
    const best = p?.getAvailableQualityLevels?.().find(q => q !== 'auto');
    if (best) return p.setPlaybackQualityRange(best, best);
    if (n < 20) timer = setTimeout(apply, 250, n + 1);
  };
  for (const e of ['yt-navigate-finish', 'yt-player-updated', 'loadstart']) {
    document.addEventListener(e, () => apply(), true);
  }
})();
