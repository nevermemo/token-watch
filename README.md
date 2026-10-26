# Token Watch

**Plan usage, context window and prompt cache countdown, right above the Claude Code prompt.**

Token Watch is a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview) that draws a small banner above the prompt. It shows:

- your 5-hour and weekly usage, with reset countdowns and burn rates;
- your context window, broken down by what fills it;
- how long until the prompt cache expires, with an opt-in keep-warm that pings or just reminds you.

Right-click the banner to cycle three views. **TW Settings** chooses what the banner shows, sets alerts, keep-warm and burn rates, and can override them per session. **TW Monitor** lists every Claude Code session on your machine with its context and cache. Where the banner can't be drawn, `/token-watch` answers as text, and [Token Watch for VS Code](https://github.com/nevermemo/token-watch-vscode) puts the same reading in the status bar.

**Quick start** (Claude Code 2.1.308 or later):

```bash
claude plugin marketplace add nevermemo/token-watch
```

```bash
claude plugin install token-watch@token-watch
```

Then start a new session, or type `/reload-plugins` in an open one. More ways to install are under [Install](#install).

In these sketches `[ … ]` marks a button; the real banner draws it as a filled chip whose colour is its state. Each bar is filled in proportion and coloured: a fill on a grey track for usage, one colour per category for the context.

Expanded:

```text
╭───────────────────────────────────────────────────────────────────────────────╮
│ 5H   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  62%  2h 14m      28%/h  1h 20m │ [≡]
│ WK   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  31%  3d 4h      0.4%/h  Safe   │ [#]
│ CTX  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  21%  212k / 1M                  │
│      ▄ messages 186k   ▄ tools 12k   ▄ memory 4.9k   ▄ skills 3k              │
│ TTL  52:50 / 60:00  [ Remind Me ]                                             │
╰───────────────────────────────────────────────────────────────────────────────╯
```

Beside the expanded banner, `[≡]` (☰ on the desktop) opens [TW Settings](#tw-settings) and `[#]` (⊞ on the desktop) opens [TW Monitor](#tw-monitor). After a usage window's reset countdown come its burn rate and when it would fill at that rate: a red time, `Safe` in green when it resets first, or `Full`.

Collapsed (one line with bars):

```text
 5H ▄▄▄▄▄▄▄▄▄▄ 62%   WK ▄▄▄▄▄▄▄▄▄▄ 31%   CTX ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ 21%  212k / 1M   [ 47:12 ]
```

Minimal (one line without bars):

```text
 5H 62%   WK 31%   CTX 21%  212k / 1M   [ 47:12 ]
```

## Install

**Requirements:** Claude Code 2.1.308 or later (`claude --version`); tested on 2.1.310. Token Watch draws in **the terminal** and in **the Code tab of the Claude desktop app**. Token Watch for VS Code needs Token Watch 1.1.0 or later.

### Install from GitHub

This repository is its own plugin marketplace: the quick start above adds it as a marketplace and installs Token Watch from it. Inside a session, `/plugin marketplace add nevermemo/token-watch` does the same as the first command.

### Update

```bash
claude plugin marketplace update token-watch
```

```bash
claude plugin update token-watch@token-watch
```

Upgrading from 1.3.0: `/context-bar` is now `/token-watch`, and keep-warm now reminds you by default instead of pinging. See the [changelog](CHANGELOG.md).

### Try it for one session, without installing

Clone it, then, from the same folder, load it for one session:

```bash
git clone https://github.com/nevermemo/token-watch
```

```bash
claude --plugin-dir ./token-watch
```

### Add it to your company's marketplace

To list Token Watch in a marketplace you already run, add an entry to its `plugins` array that points at this repository:

```json
{
  "name": "token-watch",
  "source": { "source": "github", "repo": "nevermemo/token-watch" },
  "description": "Plan usage, the context window and a prompt cache countdown above the Claude Code prompt."
}
```

To pin a release, add `"ref": "v1.4.0"` to the `source` object. Administrators can also require the marketplace or the plugin on every machine through managed settings. See [Manage mods for your organization](https://code.claude.com/docs/en/plugins/mods/admin).

### Uninstall

```bash
claude plugin uninstall token-watch@token-watch
```

## What it shows

| Row | Meaning | On the right |
|-----|---------|--------------|
| `5H` | Your rolling 5-hour usage window | Time until it resets (`2h 14m`), then its burn rate and when it fills |
| `WK` | Your weekly usage window | The same, e.g. `3d 4h  0.4%/h  Safe` |
| `FB`, `OP`, `SN`, `HK` | A model's own allowance, if Claude Code reports one (Fable, Opus, Sonnet, Haiku) | The same |
| `$$` | Your organisation's spend limit, when Claude Code runs through a Claude gateway | The same |
| `CTX` | The context window, broken down the way `/context` breaks it down | Tokens in use, e.g. `212k / 1M` |
| `TTL` | The prompt cache's time to live: how long until the API forgets this conversation's cached prefix, counted from the end of Claude's last response | The time left over the whole TTL, e.g. `52:50 / 60:00`, then the keep-warm button. While pings are on: their caps (`Pings: 0/8  Time: 00:26 / 8:00:00`) and a `Refresh Caps` button, and for a minute after a ping, a reminder or a stop, a dim note. The caps and the note need a banner 90 columns or wider |

- **The context bar:** has one coloured piece per category (messages, tools, MCP tools, skills, memory files and so on), largest first. A legend under the bar names each colour.
  - The grey track is free space.
  - The darker end is the reserve past the auto-compact point.
- **Details lines:** under the legend, the expanded view can add a line each for the MCP servers loaded (`slack 8.2k · github 6.1k`), the memory files by name (`CLAUDE.md 3.4k`), and the skills and agents (`12 of 40, 10k · agents 3, 67`). They're off by default; turn them on in TW Settings under Context → Details.
- **Burn rate:** each usage window's pace over a recent period, by default the last 30 minutes for 5H and 6 hours for the others, once that holds 5 minutes of readings. A gap between readings (usage on another device, say) is spread over the gap. The forecast after it is red when the window would fill before it resets, `Safe` in green when it resets first, and `Full` in red once full. By default both show in the expanded view only.
- **Colours:**
  - **Percentages:** plain below 50%, yellow from 50%, red from 80%.
  - **Usage bars:** fill green, yellow or red by the same thresholds.
- **Without plan limits:** the usage rows appear only on a subscription plan. With an API key, the banner shows the context and TTL rows only, and the TTL defaults to five minutes.
- **Several sessions:** usage is your account's, so a session that has been idle takes the figures another session reported more recently, within 30 seconds. Late or out-of-order figures never replace newer ones.

## Using it

- **Right-click the banner** to cycle its views: the table, one line with bars, one line without.
- **Click the keep-warm button** (on the collapsed lines, the timer `47:12`) to turn keep-warm on, and again to turn it off. By default it reminds you before the cache expires; it can ping instead. See [The prompt cache and keep-warm](#the-prompt-cache-and-keep-warm).
- **Click `Refresh Caps`** (expanded view, 90 columns or wider, pings on) to start keep-warm's caps over.
- **The buttons are the indicators.** Each is a filled chip, on the terminal and the desktop alike, and the whole chip is clickable. The keep-warm button and the collapsed timer share one colour:

  | Colour | Keep-warm button | Collapsed timer | Meaning |
  |--------|------------------|-----------------|---------|
  | Grey | `Remind Me` (Notify) or `Keep Warm` (Pings, Both) | `47:12` | The cache is warm; keep-warm is off |
  | Green | `Reminding` or `Let Chill` | `47:12` | Keep-warm is on |
  | Red | `Cache Lost` | `--:--` | The countdown ran out; the cache is cold |
  | Red | `No Data` | `--:--` | No response yet, so nothing is cached |

  Clicking `Cache Lost` or `No Data` does not start keep-warm. In the expanded view, 90 columns or wider, a short note says why. In a terminal the keep-warm button keeps one width whatever it says, so the caps after it stay put. `Refresh Caps` is always grey.
- **`[≡]`** (☰ on the desktop) opens [TW Settings](#tw-settings); **`[#]`** (⊞) opens [TW Monitor](#tw-monitor). Both sit beside the expanded banner. `[≡]` also stays beside a collapsed line that shows nothing, as the way back, and, marked `[≡●]`, beside any view that hides the TTL while keep-warm runs, so keep-warm is never out of sight.
- **`/token-watch`** hides or shows the banner. Hiding it turns keep-warm off in Pings and Both, so nothing spends out of sight; in Notify, keep-warm stays on. Where the banner can't be drawn (the VS Code extension's chat panel, `claude -p`), `/token-watch` answers with the reading as one line instead: `5H 62% (2h 14m) · WK 31% (3d 4h) · CTX 21% (212k / 1M) · TTL 47:12 (1h · subscription)`. The TTL part reads `TTL lost` once the countdown runs out.
- **`/token-watch text`** answers with that line anywhere. **`/token-watch file`** says where the usage snapshot is and when it was last written. **`/token-watch settings`** and **`/token-watch monitor`** open the two panels.
- **Narrow windows:** as the window narrows, the collapsed line narrows its usage bars, then drops them, then the forecasts, the burn rates and the `212k / 1M` detail, in that order. The percentages and the timer stay. The expanded table drops its burn-rate columns below 70 columns and its reset and token column below 50.

## TW Settings

TW Settings docks beside the transcript in the terminal's fullscreen layout and beside the chat on the desktop; on the terminal's main screen it opens inline. Open it with `[≡]` or `/token-watch settings`. Every change applies at once and is saved.

At the top, choose which settings it shows:

- **Session:** this session's own settings, over the global ones. A row this session overrides has a `[Reset]`, and `[Reset to global]` at the bottom clears them all.
- **Global:** the settings for every session, except where a session has its own. A row this session overrides says `overridden in Session`. `[Reset to defaults]` at the bottom puts them back.
- **Monitor:** [TW Monitor's settings](#tw-monitor-settings), the same in every session.

Each section and row opens and closes with `[▸]` / `[▾]`. On the desktop, checkboxes are ☑ / ☐ and choices ◉ / ○; in a terminal both are ● / ○.

```text
● Session ○ Global ○ Monitor
[▾] Usage
    [▾] 5H
        [▸] Show on banner
        [▸] Burn rate
        [▸] Burn forecast
    [▸] WK
    [▸] OTH
[▸] Context
[▸] Cache time
[Reset to global]
```

- **Usage** (5H, WK, OTH for every other window):
  - **Show on banner:** a checkbox for each view: Minimal (one line without bars), Collapsed (with bars) and Expanded.
  - **Alerts:** a notification the first time a window crosses a level: `[Enable]` sets 99%, and `[-]` / `[+]` step from 50% to 95% in fives, then 99%, then off. Off by default. A usage alert is every session's (set in Global), and only one session sends it each window period.
  - **Burn rate:** which views show it, the period it is averaged over (15 or 30 minutes, or 1 or 2 hours, for 5H; 2, 6, 12 or 24 hours for the others), and its unit (`%/h` or `%/min` for 5H, `%/h` or `%/day` for the others).
  - **Burn forecast:** which views show when the window would fill.
- **Context:** **Show on banner** and **Alerts** as above (a context alert is per session, and comes again after the context falls back under its level, as after a compaction), and **Details**, the details lines described under [What it shows](#what-it-shows).
- **Cache time:** **Show on banner** (hidden in every view, keep-warm turns off and stays off), **Keep-warm**'s mode and reminder (see [below](#the-prompt-cache-and-keep-warm)), and **Limits**, the ping caps for this session's TTL:

  | TTL | Default | Pings | Hours |
  |-----|---------|-------|-------|
  | One hour | 8 pings or 8 hours | 1 to 24 | 1 to 24 |
  | Five minutes | 30 pings or 2 hours | 5 to 100, in steps of 5 | 1 to 6 |

  A running keep-warm already past a new cap stops at once, saying why. Caps apply to pings, not reminders.
- **Clear all data**, at the bottom of the Global view, deletes everything Token Watch has stored: settings (global and every session's), the view and whether the banner is hidden, pins, hidden sessions, titles, the last usage figures and their history, and alert records. It takes 10 presses within 5 seconds, counting down as you press, so one press by mistake does nothing. The snapshot files stay; turn them off in `/config`.

A session's own settings are kept for 30 days after it was last seen, and saved again once a day while it stays open.

## TW Monitor

TW Monitor lists every Claude Code session running on your machine, from the small files each session writes (see [Session files](#session-files)). Open it with `[#]` (⊞ on the desktop) or `/token-watch monitor`. It reads the other sessions every 30 seconds while it is open; `[↻]` (↻ on the desktop) at its top right reads them now.

```text
[▾] Usage                                      [↻]
  5H  ▄▄▄▄▄▄▄▄▄▄ 62%      2h 14m   28%/h
  WK  ▄▄▄▄▄▄▄▄▄▄ 31%      3d 4h    0.4%/h
──────────────────────────────────────────────────
[▾] Sessions
[ ] [▾] › token-watch                          [×]
      CTX ▄▄▄▄▄▄▄▄▄▄ 48%      477k / 1M
      TTL ▄▄▄▄▄▄▄▄▄▄ 49m      (Ping)
[*] [▸] GUST working             TTL 1h 00m    [×]
[ ] [▸] scratch                     TTL Cold   [×]
[▸] Hidden 0
```

- **Usage:** your account's windows once, with their reset countdowns and burn rates; a burn rate is green while the window resets first and red when it would fill first.
- **Sessions:** this session first, marked `›`, then the others by name. Each opens to its context and its cache's countdown; closed, it keeps a one-line summary. The countdown is green while keep-warm is on, grey while it is off, and red with `Cold` or `No data`; keep-warm's mode follows it, `(Ping)`, `(Notify)` or `(Ping + Notify)`. `working` marks a session running a turn.
- **Pins:** `[ ]` / `[*]` before a session (⚐ / ⚑ on the desktop) pins it above the others.
- **Hidden:** `[×]` (× on the desktop) at a session's right moves it to Hidden, closed at first; `[↺]` (↺) there brings it back. Hiding this session hides it from the other sessions' monitors; while Current session is On top, it stays in its own.
- Pins and hidden sessions are shared by every session's monitor; one is dropped once it is 30 days old and its session is no longer running.

### TW Monitor settings

In TW Settings' Monitor view:

- **Usage:** for 5H, WK and OTH, which of Bar, Percentage, Reset timer and Burn rate show. A window with nothing ticked is left out, and the Usage section with it when every window is. By default 5H and WK show everything and OTH nothing.
- **Session lines:** for an expanded session and a collapsed one, which of CTX's Bar, Percentage and Tokens, and TTL's Bar, Timer and Keep-warm, show. A line with nothing ticked is left out. By default an expanded session shows everything and a collapsed one its TTL's timer and keep-warm.
- **Name:** Folder (the project's folder, the default), Title (the session's title in Claude Code) or Folder / title. See [Session titles](#session-titles).
- **Sort:** Name, Context (fullest first), Cache expiry (soonest first) or Last activity (latest first). Pinned sessions always come first.
- **Show:** All, Warm cache (a warm cache, or working) or Recent (answered within 5 minutes to 7 days, 1 day by default). This session is always listed.
- **Current session:** On top (the default: first, and never hidden in its own monitor) or Default (pins, Hidden and Sort apply to it like any other).
- `[Reset to default]`, `[Unpin all sessions]` and `[Unhide all sessions]` sit at the bottom.

### Session titles

Claude Code keeps a session's title in its transcript, `~/.claude/projects/<project>/<session id>.jsonl`. Token Watch reads it only while Name is Title or Folder / title:

- once when a session is listed, and again every 2 minutes while its transcript or title is not there yet;
- for every session listed when you press Title or Folder / title, even if it is already chosen.

It never reads a transcript on a timer otherwise. Only the title is kept, in Token Watch's storage, and the titles are deleted when you choose Folder again. A transcript over 4 MiB, more than the mod API reads at once, is searched with `git grep`, run without a shell, which prints only the title lines; without git, that session goes by its folder. The transcript format is Claude Code's own, not a documented interface, so a future Claude Code could stop titles from being found; the session then shows its folder.

## The prompt cache and keep-warm

Claude Code sends your whole conversation with every request. The API caches that prefix and bills a re-read at the cached rate, for one TTL after the last request:

- **Default:** one hour on a Claude subscription within your plan's usage; five minutes with an API key, a cloud provider or usage credits.
- **Overrides, first match wins:** `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting, `ENABLE_PROMPT_CACHING_1H`.
- **Which one applies:** the `TTL` row shows the TTL as its timer's denominator, `52:50 / 60:00`. `/token-watch text` and the snapshot's `cache.ttlSource` say why: `1h · subscription`, `5m · FORCE_PROMPT_CACHING_5M`, or `1h · confirmed` once a keep-warm ping has proved the hour.

The countdown is an estimate: see [Good to know](#good-to-know).

**Keep-warm** is off by default and never saved. Turn it on with the keep-warm button (on the collapsed lines, the timer) while the cache is warm. What it does depends on its mode, set in TW Settings under Cache time → Keep-warm:

- **Notify** (the default): no pings. One notification before each countdown runs out, 5 minutes before on the hour (2, 5, 10 or 15) and 1 minute before on five minutes (1, 2 or 3), free. It stays on when you type, and arms again after each response.
- **Pings:** Token Watch asks Claude Code to send one tiny request over the conversation (`$.model.fork`: the same prefix plus "Reply with the single word: ok") 8 minutes before the hour would run out, or 75 seconds before five minutes would, and again before each renewed window. Only one is ever out at a time. The API serves it from the cache and renews the entries it read for another TTL.
- **Both:** pings, and one notification before the first ping each time you go idle.

While pings are on, the row shows their caps, `Pings: 0/8  Time: 00:26 / 8:00:00`, and a `Refresh Caps` button. `Refresh Caps` starts the caps over: pings back to 0, time back to 00:00, a ping's failures forgotten and the note cleared, with keep-warm still on. It does not send a ping or move the schedule, so the next ping goes out when it was going to.

**Measured first** (headless sessions, October 2026, Opus 5.5): with the TTL forced to five minutes, a message eight minutes after the last response read nothing from the cache; with one ping at four minutes it read 47k tokens. On the hour, a message at 65 minutes read nothing; with one ping at 55 minutes it read the 33k tokens the ping had read. A ping reads about 70% of the prompt (its request differs from yours in its tail), and your next message writes the rest again, as it would after any turn.

### What keep-warm costs

Notify costs nothing. Every ping is a real request, counted against your plan usage like any other. Per ping, with `r_in` your model's input price and `r_out` its output price:

- cache reads: `cache_read × r_in × 0.1` (0.05 on Opus 5.5, 0.025 on Fable 5.1), about 70% of your prompt;
- cache writes: `cache_creation × r_in × 1.25` (the fork's own tail, about 14k tokens in the measurements, written at the five-minute rate);
- output: a handful of tokens at `r_out`.

The multipliers are the API's published ones ([prompt caching pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing)). The row shows each ping's actual counts for a minute (`ping read 33k · wrote 14k`, 90 columns or wider), and `/token-watch text` keeps the last ping's.

**When it stops:**
- at the caps: by default 8 pings or 8 hours on the hour, 30 pings or 2 hours on five minutes, or what TW Settings sets (pings only);
- when you send a prompt, in Pings and Both (a background notification, schedule or peer message does not count; Notify stays on);
- after two failed pings in a row;
- when a ping finds the cache already lost, so the next would only pay to re-cache;
- when the countdown runs out before a ping could go out, for example after the machine slept;
- when its mode changes, in this session or another, so a reminder never turns into pings;
- when `/token-watch` hides the banner (Pings and Both), or no view shows the TTL row;
- at compaction;
- when the session ends: `/clear`, a resume, a logout or exit.

### Idle compaction

On the one-hour TTL, Claude Code can compact a conversation of 200k tokens or more (the default threshold) about 54 minutes into an idle hour (`idleCompaction`, on by default). Compaction replaces your conversation and stops keep-warm, so on large conversations the two work against each other. To keep warm instead of compacting, set `"idleCompaction": false` (or the **Idle compaction** row in `/config`). The setting needs Claude Code 2.1.290 or later, the `/config` row 2.1.302.

## Where it works

| Where you run Claude Code | Token Watch |
|---------------------------|-------------|
| `claude` in a terminal (including editor terminals and JetBrains) | Shown |
| The Code tab of the Claude desktop app | Shown |
| The VS Code extension's chat panel | Loads, but there is no banner above the prompt to draw in, so `/token-watch` answers with the reading as text. [Token Watch for VS Code](https://github.com/nevermemo/token-watch-vscode) shows it in the status bar. |
| `claude -p`, the Agent SDK | Loads and answers `/token-watch` as text; writes no snapshot or session file while nothing draws the session, since nobody sees it |
| Cloud sessions | Not drawn: cloud sessions don't load plugins installed on your machine, and don't show mod drawings |

## Token Watch for VS Code

The VS Code extension's chat panel has no banner above the prompt, so Token Watch has a companion: [Token Watch for VS Code](https://github.com/nevermemo/token-watch-vscode) puts `5H ████▉░ 82% · 41m    WK ██▏░░░ 35%    CTX █▌░░░░ 26%` in the status bar, with the reset countdowns and the context breakdown in a tooltip and a panel that draws the same bars. It reads the usage snapshot below and nothing else.

To install it, download `token-watch-0.1.0.vsix` from the [releases page](https://github.com/nevermemo/token-watch-vscode/releases), then run `code --install-extension token-watch-0.1.0.vsix`, or use Extensions → ⋯ → Install from VSIX…. It is not yet published to the VS Code Marketplace or Open VSX. Keep Token Watch 1.1.0 or later installed, and open any Claude Code session: the terminal, the desktop app or the chat panel.

## The usage snapshot

After each reading, Token Watch writes one small JSON file, `~/.claude/token-watch/usage.json` (`~` is `USERPROFILE` on Windows and `HOME` elsewhere), and writes it again every 30 seconds while the session is alive. With several sessions open, the most recently active one keeps the file; another takes over once that snapshot is more than 120 seconds old. Token Watch for VS Code treats a snapshot older than 150 seconds as a session that has ended.

**Off:** turn off **Usage snapshot files** in `/config`, or in `/plugin` → token-watch → **Configure options**. That also turns off the [session files](#session-files), and TW Monitor then lists this session alone. `/token-watch file` shows the path and the last write.

**Schema 1** (categories shortened):

```json
{
  "schema": 1,
  "writtenAt": "2026-10-03T12:00:00.000Z",
  "session": { "id": "4d1f…", "cwd": "C:\\Users\\you\\proj" },
  "windows": [
    { "kind": "five_hour", "label": "5H", "percentUsed": 62.4, "resetsAt": "2026-10-03T14:14:00.000Z", "ratePerHour": 28, "fullAt": "2026-10-03T13:20:34.286Z" },
    { "kind": "seven_day", "label": "WK", "percentUsed": 31, "resetsAt": "2026-10-06T16:00:00.000Z", "ratePerHour": 0.4, "fullAt": null }
  ],
  "context": {
    "total": 212200, "window": 1000000, "percent": 21, "compactsAt": 950000,
    "categories": [
      { "label": "messages", "tokens": 186000, "color": "#d97757", "kind": "used" },
      { "label": "free", "tokens": 738000, "color": "inactive", "kind": "free" },
      { "label": "buffer", "tokens": 50000, "color": "inactive", "kind": "buffer" }
    ]
  },
  "cache": { "ttl": "1h", "ttlSource": "subscription", "expiresAt": "2026-10-03T13:00:00.000Z", "warm": true, "keepWarm": { "on": false, "mode": "notify", "pings": 0, "maxPings": 8, "startedAt": null, "maxMs": 28800000, "lastPing": null } }
}
```

- `windows`: in the banner's order, with its labels (`5H`, `WK`, `FB`…), `percentUsed` as reported and `resetsAt` as ISO 8601 or `null`. A window whose `resetsAt` has passed has started over: show it at 0%. `ratePerHour` is the burn rate in points an hour, `null` until there are 5 minutes of readings; `fullAt` is when the window fills at that rate, `null` at no pace or when it resets first.
- `context`: `null` until the first breakdown. `categories` are the `/context` rows with their colours; a `free` or `buffer` row's colour is whatever Claude Code reports, so draw those with a track colour. The reserve past the auto-compact point is `window - compactsAt`.
- `session`: the session's `id` and `cwd`, each `null` where Claude Code has none.
- `cache`: the TTL and where it comes from, when the cache is believed to expire (`null` before the first response and after `/clear`, a resume or a logout), whether it is warm, and keep-warm's state and `mode` (`notify`, `pings` or `both`). `ttlSource` is one of `subscription`, `confirmed`, `API key or cloud`, `over plan limit`, `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `promptCacheTtl` or `ENABLE_PROMPT_CACHING_1H`.
- Schema 1 only gains fields: `cache` came in 1.2.0, `ratePerHour`, `fullAt` and `keepWarm.mode` in 1.4.0.
- The file is rewritten in place, not atomically: a reader that fails to parse it should read again a moment later.

### Session files

Each session also writes `~/.claude/token-watch/sessions/session-N.json`, every 30 seconds while it is alive, for TW Monitor: its id, folder and project root, whether it is working, when it last answered, its context's size, and its cache's TTL, expiry and keep-warm state. Nothing can delete a file through the mod API, so a new session reuses the first slot whose session has ended or gone quiet for 2 minutes; the folder holds as many files as sessions ever ran at once. A session that exits says so in its file. With Usage snapshot files off, none are written.

## Privacy and permissions

Token Watch reads numbers Claude Code already has. It opens **no network connections itself** and never reads your prompts or tool calls, with one opt-in exception: while TW Monitor's Name setting uses titles, it reads session transcripts to find their title lines, and keeps only the titles.

- **What can spend usage:** only keep-warm's pings, which Claude Code sends over your conversation, and only while you have turned keep-warm on in Pings or Both. The default, Notify, sends notifications and no requests.
- **What it writes:** under `~/.claude/token-watch/`, the [usage snapshot](#the-usage-snapshot) and this session's [session file](#session-files); both turn off with **Usage snapshot files**. No other file is written.
- **What it reads:** the session files (for TW Monitor) and the snapshot's own timestamp and session id. Only while TW Monitor's Name setting uses titles, the sessions' transcripts for their titles alone (see [Session titles](#session-titles)).
- **Processes:** none by default. Only for a transcript over 4 MiB, while Name uses titles, it runs `git grep` on that one file, without a shell.
- **Notifications:** keep-warm's reminders (Notify and Both) and the alerts you turn on.
- **Environment and settings:** seven environment variables by name (`USERPROFILE`, `HOME`, `OS` for your home folder; `CLAUDE_CONFIG_DIR` for where transcripts live; `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `ENABLE_PROMPT_CACHING_1H` for the TTL), and one setting, `promptCacheTtl`.

You can check this yourself before installing: `claude plugin validate ./token-watch` lists every hook a mod registers and every API it calls. For Token Watch:

- **Hooks:** `session.start`, `session.measure`, `turn.start` and `turn.complete` (when a main-thread turn begins and ends; the text is not read), `prompt.submit` (only the prompt's origin, to stop keep-warm's pings when you type; the prompt passes through untouched), `session.compact` and `session.end` (compaction and the session ending stop keep-warm), `command.run` (for `/token-watch`), `ui.message` (the banner's clicks), and `ui.render` (the banner, TW Settings and TW Monitor).
- **Calls:**
  - `$.session.usage`: the context breakdown and usage windows. Claude Code estimates these locally, without extra API requests.
  - `$.session.surfaces`, `$.session.id`, `$.session.cwd`, `$.session.root`: where the session draws (so `/token-watch` knows whether to toggle the banner or answer as text, and the files are written only for a session someone sees), and the session's id, directory and project root for the snapshot, its session file and TW Monitor.
  - `$.clock`: the countdowns, the 30-second refresh, keep-warm's timers and Clear all data's window.
  - `$.model.fork`: the keep-warm ping, one small request over your conversation, sent only while keep-warm pings.
  - `$.ui.notify`: keep-warm's reminders and your alerts.
  - `$.settings.read`: the `promptCacheTtl` setting alone, read once at start; no other setting is read.
  - `$.command.register`: adds `/token-watch`.
  - `$.ui.open`, `$.ui.close`, `$.ui.panes`: open TW Settings and TW Monitor, close one a surface can't place, and tell whether TW Monitor is open.
  - `$.store`: remembers your settings and the shared figures (below).
  - `$.state` and `$.ui.resolve`: share data between the mod's hooks and draw the banner and the panels.
  - `$.env.get`: the seven variables above. Nothing else is read from the environment.
  - `$.fs.write`, `$.fs.read`, `$.fs.list`, `$.fs.stat`, `$.fs.exists`: write the snapshot and the session file; read the session files and the snapshot's owner; and, while Name uses titles, find and read transcripts.
  - `$.process.run`: `git grep` on a transcript over 4 MiB, while Name uses titles.

**What it saves:** `$.store` keeps, in Claude Code's own plugin storage on your machine:
- the view and whether the banner is hidden;
- the global settings, and each session's own (dropped 30 days after the session was last seen);
- the last usage windows seen, when they were reported, and their burn-rate samples for the last 24 hours;
- which usage alerts were sent this window period;
- the pinned and hidden sessions, and the titles read while Name uses them.

Keep-warm is never saved. 1.3.0's saved choices are read into the new settings the first time; Clear all data deletes everything here.

## Good to know

- **A new session shows the last usage seen.** Claude Code reports usage only with a response, so a new session starts from the figures saved last time, or another session's newer ones. The first response then refreshes them.
- **A window that has reset shows 0%.** It stays at 0% until the next response brings fresh numbers, with no burn rate until then. A window disappears only when Claude Code stops reporting it and its reset time has passed.
- **Small categories may be a hairline.** The bar's proportions are exact, so a tiny category can be thinner than one cell. The legend always lists it.
- **No cloud credit figure.** Cloud sessions draw on the same 5-hour and weekly windows as the rest of your account, and Claude Code exposes no separate credit balance to mods.
- **The TTL countdown is an estimate.** The mod API doesn't expose the cache's real expiry, so the banner counts from the end of the last response, as Claude Code's own `/model` warmth check does. The API counts from the start of the request, so the cache expires earlier than the timer shows by however long the response took to stream. On the one-hour TTL, keep-warm's 8-minute lead covers responses up to about 8 minutes. On the five-minute TTL its 75-second lead covers only short responses: after a longer one, the ping can arrive when the cache is already cold, and keep-warm then stops (`stopped: the ping found the cache lost`) rather than paying to re-cache.

## How it works

| Hook | What it does |
|------|--------------|
| `session.start` | Starts a 30-second clock, registers `/token-watch`, restores the saved choices, settings and the last usage seen, reads the TTL controls once and takes a first reading. Each tick refreshes the countdowns, picks up other sessions' settings and newer usage, writes this session's file, and refreshes the usage snapshot while this session wrote it last or the last writer's copy is more than 120 seconds old; while TW Monitor is open it also reads the other sessions' files. |
| `session.measure` | Takes a new reading after each turn and whenever a usage window changes, shares newer usage with the other sessions, adds burn-rate samples, sends any alert due, and writes the snapshot when the figures changed. |
| `turn.start`, `turn.complete` | Marks a main-thread turn running, so no ping or reminder goes out; a response restarts the TTL countdown and arms the next one. A subagent's turns are not followed. |
| `prompt.submit` | A prompt from you turns keep-warm's pings off; background deliveries do not; the text passes through unread. |
| `session.compact`, `session.end` | Compaction stops keep-warm and restarts the countdown (a precompute changes nothing). The session ending stops keep-warm and marks its session file ended; after `/clear`, a resume or a logout the cache is forgotten and a fresh reading taken. |
| `command.run` (`token-watch`) | Shows or hides the banner where it draws; answers with the reading as text where nothing draws, with `text`, or with the snapshot's path with `file`; opens TW Settings with `settings` and TW Monitor with `monitor`. |
| `ui.render` (`AbovePrompt`) | Draws the banner as a client module ([`hooks/band.tsx`](hooks/band.tsx)). The banner lays itself out to the available width and reports clicks. Other mods drawing above the prompt keep their place; Token Watch adds its banner beneath theirs. It draws the `[≡]` and `[#]` buttons itself, outside the client module: Claude Code doesn't count a press inside a client module as yours, and opens a pane you didn't ask for only on a terminal 144 columns wide. |
| `ui.render` (`Pane`) | Draws TW Settings and TW Monitor. |
| `ui.message` | Receives the banner's clicks: a right click moves to the next view, the timer or the keep-warm button toggles keep-warm, `Refresh Caps` starts its caps over. |

**Bars on each surface:** on the desktop app, bars are boxes 60% of the line's height. In a terminal they are `▄` blocks. Both are thinner than the line, so stacked bars keep a gap between them.

## Development

```text
token-watch/
├── .claude-plugin/plugin.json        manifest
├── .claude-plugin/marketplace.json   lists this repository as its own marketplace
├── .claude-plugin/icon.png           the plugin's icon
├── hooks/hooks.json                  points Claude Code at register.tsx
├── hooks/register.tsx                hooks, readings, keep-warm, TW Settings, TW Monitor and saved state
├── hooks/band.tsx                    the banner: layout, bars, legend, clicks
├── hooks/settings.ts                 the settings tree: defaults, checks, global and per-session merge
├── hooks/burn.ts                     burn rates: the samples, the pace and when a window fills
├── hooks/cache.ts                    the TTL rules and keep-warm's policy: constants and pure functions
├── hooks/format.ts                   names, order, countdowns and token counts, shared by the banner, the text reply and the snapshot
├── types/index.d.ts                  shared types and state declarations
├── tests/token-watch.test.tsx        tests for the terminal and desktop surfaces
├── tsconfig.json                     strict TypeScript settings for hooks, types and tests
├── CHANGELOG.md                      release notes
└── LICENSE                           Apache License 2.0
```

Run these from the `token-watch` folder:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

To type-check, load the mod once with `claude --plugin-dir .` (Claude Code then writes its API types to `.claude-plugin/types/`, which git ignores), then run TypeScript 5.4 or later:

```bash
npx -p typescript tsc -p .
```

**What the tests cover:** both surfaces, expanded and collapsed. They also cover:
- the three views, the saved view and the 1.1 keys' migration, narrow widths, extra usage windows, sessions without plan limits, restoring saved usage, windows that reset, sharing the banner with another mod;
- the text reply where nothing draws, and `claude -p` runs;
- the usage snapshot and the session files: their content, the heartbeat, several sessions, slots reused and contested, the off switch, the home folder on each platform;
- the TTL row and keep-warm, with a mocked clock and a stubbed fork: the buttons' chips, labels and colours, the schedule, the caps, every stop condition, a ping held open or never answering, failures during a retry, subagent turns, precompute, every way a session ends, the TTL's precedence, the three modes and their reminders, a mode changed elsewhere, the banner hidden;
- TW Settings: the three views, per-session overrides and their resets, settings changed by another session, every row's controls and bounds, Clear all data's ten presses;
- burn rates: the pace and forecast, `Safe` and `Full`, a reset, a gap between readings, late and out-of-order figures, the units;
- alerts, the context's details lines, and usage shared between sessions;
- TW Monitor: the sections and their settings, pins, Hidden, sort, filters, the current session, names from transcripts (including `git grep` for large ones, `CLAUDE_CONFIG_DIR` and a missing transcript), the refresh, and files that don't read as session files.

**Seeing your edits:**
- In an open session, `/reload-plugins` reads the plugin straight from its folder.
- A Claude Code restart loads the installed copy instead, so reinstall after editing to update it.

## Credits

- **Original sample:** Token Watch began from the `token-weather` sample mod in Anthropic's [claude-code-playground](https://github.com/anthropics/claude-code-playground) (Apache-2.0). It has since been rewritten and redesigned.
- **Usage rows:** modelled on [usage-band](https://github.com/iamkhalid2/usage-band) by iamkhalid2 (MIT).

Token Watch is an independent project, not affiliated with or endorsed by Anthropic. Claude and Claude Code are Anthropic's names for its products.

## License

Copyright 2026 Kadir Mert Okumus. Licensed under the [Apache License 2.0](LICENSE).
