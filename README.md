# better-web-scripts

Small userscripts for the web.

## YouTube Video Age

Install Tampermonkey, create a new script, paste `youtube-video-age.user.js`, and save. Reload YouTube.

Replaces video card ages with labels such as **1 year 4 months old**. Partial months round up: the day before the first anniversary is `12 months old`; the anniversary is `1 year old`. Month ends and leap days clamp to the last day of the month.

Works with English YouTube card labels on search, home, channel, and related-video layouts. Watches DOM changes and navigation. Retrieves exact upload dates from YouTube watch pages for visible cards, with three concurrent requests and an in-memory cache. If a date is unavailable, the original label stays. No API key or external service. YouTube DOM changes may require selector updates.

To update an existing installation, replace its code with the latest `youtube-video-age.user.js`, save, and reload YouTube. Version 1.1.0 adds GitHub update URLs, embedded-date fallback, and retries after temporary failures.

## YouTube Full Buffer

`youtube-full-buffer.user.js` makes YouTube buffer the whole video ahead as soon as the watch page opens, instead of about a minute at a time. It works with YouTube Max Quality, which switches quality before the buffer fills.

Since 2025 YouTube streams through SABR: the server sends media only about 15–60 s past the reported playback position, and the player caps its own readahead at 20 MiB video, 8 MiB audio, or 120 s. The script raises the player's caps and reports a position near the end of what is buffered. It also raises the readahead target in each response, so the player keeps requesting until the video is fully buffered. It changes only the watch-page player. Live streams, Shorts, hover previews and embeds are left alone, and any request it cannot parse is passed through untouched.

### Setup

Both steps are required. By default Chromium lets a page hold only 12 MiB of audio and 150 MiB of video. When a page goes over that, YouTube's player stops loading and playback can freeze.

1. Install the script in Tampermonkey: <https://raw.githubusercontent.com/krashkanter/better-web-scripts/main/youtube-full-buffer.user.js>
2. Start Brave with these flags:
   ```
   --mse-audio-buffer-size-limit-mb=512 --mse-video-buffer-size-limit-mb=3000
   ```
   Keep both values below 4096. Chromium multiplies them in 32 bits, so 4096 and 8192 wrap around and leave the default limit in place. The script's `LIMITS_MIB` matches these values, so there is nothing to configure in the script. Brave reads flags only when it starts, so every Brave window has to be closed first. To check, open `brave://version`; the flags should appear under **Command Line**.

With these limits the script buffers up to about 2 GiB of video per tab: roughly 1.5–3 hours of 1080p, or 15 minutes of 4K60. Longer videos fill to that point and are topped up as they play. That memory stays in use while the tab is open. To log what the script does, run `localStorage.setItem('ytfb-debug', '1')` in the console on youtube.com.

### Adding the flags (instructions for agents)

Close every Brave process first, and confirm with the user before you do, because it closes their browser. Then add the flags to each launcher that starts Brave, unless they are already there.

**Windows** (shortcuts on the desktop, the Start menu and the taskbar; handles a OneDrive-redirected desktop):

```powershell
$flags = '--mse-audio-buffer-size-limit-mb=512 --mse-video-buffer-size-limit-mb=3000'
$sh = New-Object -ComObject WScript.Shell
$dirs = [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'),
        [Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'),
        "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
Get-ChildItem $dirs -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
  $l = $sh.CreateShortcut($_.FullName)
  if ($l.TargetPath -like '*\brave.exe' -and $l.Arguments -notmatch 'mse-video-buffer-size-limit-mb') {
    $l.Arguments = ($l.Arguments + ' ' + $flags).Trim(); $l.Save(); "updated $($_.FullName)"
  }
}
```

Shortcuts in the Common (all users) folders need an elevated shell. If Brave is not running and a link is opened from another app, it starts without the flags. To cover that case, add the same flags before `--single-argument` in the `HKCU\Software\Classes\BraveHTML*\shell\open\command` registry value. Brave updates may reset that value.

**macOS:** Dock and Finder launches can't take flags. Start Brave with `open -a "Brave Browser" --args --mse-audio-buffer-size-limit-mb=512 --mse-video-buffer-size-limit-mb=3000`, or make an Automator app or a login item that runs this command.

**Linux:** copy `brave-browser.desktop` into `~/.local/share/applications/` and add the flags to each `Exec=` line after the binary. Some packages, such as Arch's, also read one flag per line from `~/.config/brave-flags.conf`.

Afterwards start Brave and check `brave://version` → **Command Line**.

## YouTube Max Quality

`youtube-max-quality.user.js` loads videos at the highest available resolution. Copied unchanged from `open-untrap/userscript/youtube-max-quality.user.js`. Install it in Tampermonkey the same way.

MIT licensed.
