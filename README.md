# better-web-scripts

Small userscripts for the web.

## YouTube Video Age

Install Tampermonkey, create a new script, paste `youtube-video-age.user.js`, and save. Reload YouTube.

Replaces video card ages with labels such as **1 year 4 months old**. Partial months round up: the day before the first anniversary is `12 months old`; the anniversary is `1 year old`. Month ends and leap days clamp to the last day of the month.

Works with English YouTube card labels on search, home, channel, and related-video layouts. Watches DOM changes and navigation. Retrieves exact upload dates from YouTube watch pages for visible cards, with three concurrent requests and an in-memory cache. If a date is unavailable, the original label stays. No API key or external service. YouTube DOM changes may require selector updates.

To update an existing installation, replace its code with the latest `youtube-video-age.user.js`, save, and reload YouTube. Version 1.1.0 adds GitHub update URLs, embedded-date fallback, and retries after temporary failures.

## YouTube Max Quality

`youtube-max-quality.user.js` loads videos at the highest available resolution. Copied unchanged from `open-untrap/userscript/youtube-max-quality.user.js`. Install it in Tampermonkey the same way.

MIT licensed.
