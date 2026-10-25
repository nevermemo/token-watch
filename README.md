# Token Watch

**See your Claude Code plan usage and context window at a glance, right above the prompt.**

Token Watch is a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview). It draws a small band above the prompt with your plan usage and your context window. The 5-hour and weekly windows each get a bar and a reset countdown. The context window gets a bar broken down by what fills it. The `TTL` row counts down the prompt cache's lifetime and, if you ask, keeps it warm while you step away. Right-click the band to cycle its three views. Where Claude Code draws no mod (the VS Code extension's chat panel), `/context-bar` answers with the reading as a line of text, and the companion extension [Token Watch for VS Code](https://github.com/nevermemo/token-watch-vscode) shows it in the status bar.

Expanded:

```text
╭──────────────────────────────────────────────────────────────────╮
│ 5H   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  62%  2h 14m   │
│ WK   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  31%  3d 4h    │
│ CTX  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  21%  212k / 1M│
│      ▄ messages 186k   ▄ tools 12k   ▄ memory 4.9k   ▄ skills 3k │
│ TTL  52:50 / 60:00  [ Keep warm ]                                │
╰──────────────────────────────────────────────────────────────────╯
```

With keep-warm on, the TTL row adds its caps and a `Refresh caps` button (in a band at least 90 columns wide):

```text
TTL  52:50 / 60:00  [ Keep warm ]  Pings: 0/8  Time: 00:26 / 8:00:00  [ Refresh caps ]
```

Collapsed:

```text
 5H ▄▄▄▄▄▄▄▄▄▄ 62%   WK ▄▄▄▄▄▄▄▄▄▄ 31%   CTX ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ 21%  212k / 1M   ▄▄ [ 47:12 ]
```

Collapsed without bars:

```text
 5H 62%   WK 31%   CTX 21%  212k / 1M   ▄▄ [ 47:12 ]
```

In the real band each bar is filled in proportion and coloured: a coloured fill on a grey track for usage, and one colour per category for the context.

## What it shows

| Row | Meaning | Detail on the right |
|-----|---------|---------------------|
| `5H` | Your rolling 5-hour usage window | Time until it resets, e.g. `2h 14m` |
| `WK` | Your weekly usage window | Time until it resets, e.g. `1d 16h` |
| `FB`, `OP`, `SN`, `HK` | A model's own allowance, if Claude Code reports one (Fable, Opus, Sonnet, Haiku) | Time until it resets |
| `$$` | Your organization's spend limit, when Claude Code runs through a Claude gateway | Time until it resets |
| `CTX` | The context window, broken down the way `/context` breaks it down | Tokens in use, e.g. `99k / 1M` |
| `TTL` | The prompt cache's time to live: how long until the API forgets this conversation's cached prefix, counted from the end of Claude's last response | The time left over the whole TTL, e.g. `52:50 / 60:00`, then a `Keep warm` button. While keep-warm is on: its caps (`Pings: 0/8  Time: 00:26 / 8:00:00`) and a `Refresh caps` button, and for a minute after a ping or a stop, a dim note. The caps and the note need a band at least 90 columns wide |

- **The context bar:** has one coloured piece per category (messages, tools, MCP tools, skills, memory files and so on), largest first. A legend under the bar names each colour.
  - The light grey track is free space.
  - The darker end is the reserve past the auto-compact point.
- **Colours:**
  - **Percentages:** plain below 50%, yellow from 50%, red from 80%.
  - **Usage bars:** fill green, yellow or red by the same thresholds.
- **Missing usage rows:** these rows appear only on a subscription plan. With an API key, the band shows the context row alone.

## Using it

- **Right-click the band** to cycle its views: the table, one line with bars, one line without.
- **Click `Keep warm`** (on the collapsed lines, the timer `47:12`) to keep the prompt cache warm while you are away; see [The prompt cache and keep-warm](#the-prompt-cache-and-keep-warm).
- **Click `Refresh caps`**, shown while keep-warm is on, to start keep-warm's caps over: its pings and time on go back to zero and a ping's failures are forgotten, without a ping or a change to when the next one goes out.
- **Buttons:** a terminal draws a button as `[ label ]`. The desktop app draws a Client's Buttons as plain text, so there each one is drawn as a filled chip: grey, and green for `Keep warm` while it is on.
- **`/context-bar`** hides or shows the band. Where the band can't be drawn (the VS Code extension's chat panel, `claude -p`), it answers with the reading as one line instead: `5H 62% (2h 14m) · WK 31% (3d 4h) · CTX 21% (212k / 1M)`.
- **`/context-bar text`** answers with that line anywhere.
- **`/context-bar file`** says where the usage snapshot is and when it was last written.
- **Saved choices:** the view and shown or hidden are kept across sessions; keep-warm is not.
- **Narrow windows:** the collapsed line never wraps. As the window narrows, the small usage bars drop first, then the `99k / 1M` detail. The percentages and the timer always stay.

## The prompt cache and keep-warm

Claude Code sends your whole conversation with every request; the API caches that prefix and bills a re-read at the cached rate. The cache lasts one TTL after the last request: **one hour** on a Claude subscription within your plan's usage, **five minutes** with an API key, a cloud provider or usage credits, or whatever `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting or `ENABLE_PROMPT_CACHING_1H` say (in that order). The `TTL` row shows the TTL as the denominator of its timer, `52:50 / 60:00`; which one applies and why (`1h · subscription`, `5m · FORCE_PROMPT_CACHING_5M`, or `1h · confirmed` once a keep-warm ping has proved the hour) is in `/context-bar text` and the snapshot's `cache.ttlSource`. The band cannot ask Claude Code for the exact expiry (the mod API does not expose it), so it counts from the end of the last response, as Claude Code's own `/model` warmth check does; the API counts from the start of the last request, so the real expiry is earlier by the length of that response.

**Keep warm** is off by default and never saved. Turn it on by clicking `Keep warm` (on the collapsed lines, the timer) while the cache is warm. Token Watch then asks Claude Code to send one tiny request over the conversation (`$.model.fork`: the same prefix plus "Reply with the single word: ok") 8 minutes before the hour would run out, or 75 seconds before five minutes would, and again before each renewed window. (The lead times are counted from the end of the last response; see the TTL note under Good to know for what that means on the five-minute TTL.) The API serves that request from the cache and renews the entries it read for another TTL.

While keep-warm is on, the row shows its caps, `Pings: 0/8  Time: 00:26 / 8:00:00`, and a **Refresh caps** button. Refresh caps starts the caps over: pings back to 0, time back to 00:00, a ping's failures forgotten and the note cleared, with keep-warm still on. It does not send a ping or move the schedule, so the next ping goes out when it was going to. It does nothing while keep-warm is off, and the button is not drawn then.

Measured in headless sessions (October 2026, Opus 5.5): with the TTL forced to five minutes, a message eight minutes after the last response read nothing from the cache; with one ping at four minutes it read 47k tokens. On the hour, a message at 65 minutes read nothing; with one ping at 55 minutes it read the 33k tokens the ping had read. A ping reads about 70% of the prompt (its request differs from yours in its tail) and your next message re-writes the rest, which it re-writes after any turn.

### What keep-warm costs

Every ping is a real request, counted against your plan usage like any other. Per ping, with `r_in` your model's input price and `r_out` its output price:

- cache reads: `cache_read × r_in × 0.1` (0.05 on Opus 5.5 and Sonnet 5.5, 0.025 on Fable 5.1), about 70% of your prompt;
- cache writes: `cache_creation × r_in × 1.25` (the fork's own tail, about 14k tokens in the measurements, written at the five-minute rate);
- output: a handful of tokens at `r_out`.

The multipliers are the API's published ones (platform.claude.com, prompt caching, Pricing). The row shows each ping's actual counts for a minute (in a band at least 90 columns wide) (`ping read 33k · wrote 14k`), and `/context-bar text` keeps the last ping's. On the hour, keep-warm stops after 8 pings or 8 hours; on five minutes, after 30 pings or 2 hours. It also stops when you send a prompt (a background notification, schedule or peer message does not count), after two failed pings in a row, when a ping finds the cache already cold (so the next would only pay to re-cache), at compaction, and at `/clear`.

### Idle compaction

On the one-hour TTL, Claude Code can compact a conversation of 200k tokens or more about 54 minutes into an idle hour (`idleCompaction`, on by default). Compaction replaces your conversation and stops keep-warm, so on large conversations the two work against each other. To keep warm instead of compacting, set `"idleCompaction": false` (or the **Idle compaction** row in `/config`).

## Install

**Requirements:** Claude Code **2.1.288 or later**: 1.2.0 uses mod API features present in 2.1.288 (`$.model.fork`, `$.settings.read`) and was tested on 2.1.309 (`claude --version`). Token Watch draws in **the terminal** and in **the Code tab of the Claude desktop app**. Token Watch for VS Code needs Token Watch 1.1.0 or later.

### Install from GitHub

This repository is its own plugin marketplace. In your shell, add it, then install Token Watch from it:

```bash
claude plugin marketplace add nevermemo/token-watch
```

```bash
claude plugin install token-watch@token-watch
```

If a Claude Code session is already open, type `/reload-plugins` in it to load the mod. New sessions load it on their own. Inside a session, `/plugin marketplace add nevermemo/token-watch` does the same as the first command.

### Update

```bash
claude plugin marketplace update token-watch
```

```bash
claude plugin update token-watch@token-watch
```

### Try it for one session, without installing

From a clone of this repository:

```bash
claude --plugin-dir ./token-watch
```

### Add it to your company's marketplace

To list Token Watch in a marketplace you already run, add an entry to its `plugins` array that points at this repository:

```json
{
  "name": "token-watch",
  "source": { "source": "github", "repo": "nevermemo/token-watch" },
  "description": "Plan usage and the context window as thin bars above the prompt."
}
```

To pin a release, add `"ref": "v1.2.0"` to the `source` object. Administrators can also require the marketplace or the plugin on every machine through managed settings. See [Manage mods for your organization](https://code.claude.com/docs/en/plugins/mods/admin).

### Uninstall

```bash
claude plugin uninstall token-watch@token-watch
```

## Where it works

| Where you run Claude Code | Token Watch |
|---------------------------|-------------|
| `claude` in a terminal (including editor terminals and JetBrains) | Shown |
| The Code tab of the Claude desktop app | Shown |
| The VS Code extension's chat panel, `claude -p`, the Agent SDK | Loads; nothing is drawn, so `/context-bar` answers with the reading as text. In VS Code, [Token Watch for VS Code](https://github.com/nevermemo/token-watch-vscode) shows it in the status bar. The chat panel runs the Claude Code bundled with the extension, which loads mods from version 2.1.287. |
| Cloud sessions | Isn't drawn: cloud sessions don't load plugins installed on your machine, and don't show mod drawings |

## Token Watch for VS Code

The VS Code extension's chat panel shows no mod drawings, so Token Watch has a companion: [Token Watch for VS Code](https://github.com/nevermemo/token-watch-vscode) puts `5H ████▉░ 82% · 41m    WK ██▏░░░ 35%    CTX █▌░░░░ 26%` in the status bar, with the reset countdowns and the context breakdown in a tooltip and a panel that draws the same bars. It reads the usage snapshot below and nothing else.

To install it, download `token-watch-0.1.0.vsix` from the [releases page](https://github.com/nevermemo/token-watch-vscode/releases), then run `code --install-extension token-watch-0.1.0.vsix`, or use Extensions → ⋯ → Install from VSIX…. It is not yet published to the VS Code Marketplace or Open VSX. Keep Token Watch 1.1.0 or later installed, and open any Claude Code session: the terminal, the desktop app or the chat panel.

## The usage snapshot

After each reading, Token Watch writes one small JSON file, `~/.claude/token-watch/usage.json` (`~` is `USERPROFILE` on Windows, else `HOME`), and writes it again every 30 seconds while the session is alive. With several sessions open, the most recently active one keeps the file; another takes over once that snapshot is more than 120 seconds old. A reader treats a snapshot older than 150 seconds as a session that has ended.

**Off:** turn off **Usage snapshot file** in `/config`, or in `/plugin` → token-watch → **Configure options**. `/context-bar file` shows the path and the last write.

**Schema 1:**

```json
{
  "schema": 1,
  "writtenAt": "2026-10-03T12:00:00.000Z",
  "session": { "id": "4d1f…", "cwd": "C:\\Users\\you\\proj" },
  "windows": [
    { "kind": "five_hour", "label": "5H", "percentUsed": 62.4, "resetsAt": "2026-10-03T14:14:00.000Z" },
    { "kind": "seven_day", "label": "WK", "percentUsed": 31, "resetsAt": "2026-10-06T16:00:00.000Z" }
  ],
  "context": {
    "total": 212200, "window": 1000000, "percent": 21, "compactsAt": 950000,
    "categories": [
      { "label": "messages", "tokens": 186000, "color": "#d97757", "kind": "used" },
      { "label": "free", "tokens": 738000, "color": "inactive", "kind": "free" },
      { "label": "buffer", "tokens": 50000, "color": "inactive", "kind": "buffer" }
    ]
  },
  "cache": { "ttl": "1h", "ttlSource": "subscription", "expiresAt": "2026-10-03T13:00:00.000Z", "warm": true, "keepWarm": { "on": false, "pings": 0, "maxPings": 8, "startedAt": null, "maxMs": 28800000, "lastPing": null } }
}
```

- `windows`: in the band's order, with its labels (`5H`, `WK`, `FB`…), `percentUsed` as reported and `resetsAt` as ISO 8601 or `null`. A window whose `resetsAt` has passed has started over: show it at 0%.
- `context`: `null` until the first breakdown. `categories` are the `/context` rows with their colours; a `free` or `buffer` row's colour is whatever Claude Code reports, so draw those with a track colour. The reserve past the auto-compact point is `window - compactsAt`.
- `session`: the session's id and working directory, or `null` where Claude Code has none.
- `cache`: the TTL and where it comes from, when the cache is believed to expire (`null` before the first response), whether it is warm, and keep-warm's state. Added in 1.2.0; schema 1 only gains fields.
- The file is rewritten in place, not atomically: a reader that fails to parse it should read again a moment later.

## Privacy and permissions

Token Watch reads numbers Claude Code already has. It makes **no network requests of its own**, starts **no processes**, and never reads your prompts or tool calls. One thing it does spends usage: **keep-warm**, which, only while you have turned it on, asks Claude Code to send a small request over your conversation before the prompt cache expires. It writes **one file** on your machine, the [usage snapshot](#the-usage-snapshot), reads nothing but that file's timestamp, reads five environment variables by name, and reads three settings. The snapshot can be turned off.

You can check this yourself before installing: `claude plugin validate ./token-watch` lists every hook a mod registers and every API it calls. For Token Watch:

- **Hooks:** `session.start`, `session.measure`, `turn.start` and `turn.complete` (when a turn begins and ends; the text is not read), `prompt.submit` (only the prompt's origin, to stop keep-warm when you type; the prompt passes through untouched), `session.compact` and `session.end` (compaction and `/clear` stop keep-warm), `command.run` (for `/context-bar`), `ui.message` (the clicks), and `ui.render` (the band).
- **Calls:**
  - `$.session.usage`: the context breakdown and usage windows. Claude Code estimates these locally, without extra API requests.
  - `$.session.surfaces`, `$.session.id`, `$.session.cwd`: where the session draws (so `/context-bar` knows whether to toggle the band or answer as text), and the session's id and directory for the snapshot.
  - `$.clock`: the reset countdowns and the snapshot's 30-second refresh.
  - `$.model.fork`: the keep-warm ping, one small request over your conversation, sent only while keep-warm is on.
  - `$.settings.read`: `promptCacheTtl`, `idleCompaction` and `autoCompactEnabled`, read once at start; nothing else of your settings is kept.
  - `$.clock.after`: the ping's timer.
  - `$.command.register`: adds `/context-bar`.
  - `$.store`: remembers your choices and the last usage seen. `$.store.delete` removes the 1.1 keys once migrated.
  - `$.state` and `$.ui.resolve`: share data between the mod's hooks and draw the band.
  - `$.env.get` (`USERPROFILE`, `HOME`, `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `ENABLE_PROMPT_CACHING_1H`): your home directory and the prompt cache's TTL controls. Nothing else is read from the environment.
  - `$.fs.write` and `$.fs.stat`: write the snapshot and check its timestamp. No other file is written, and no file is read.

**What it saves:** `$.store` keeps three things in Claude Code's own plugin storage on your machine:
- the view (expanded, bars, plain),
- whether it's hidden,
- the last usage windows seen (percentages and reset times).

Keep-warm is never saved.

The snapshot file is described [above](#the-usage-snapshot).

## Good to know

- **A new session shows the last usage seen.** Claude Code reports usage only with a response, so a new session starts from the figures saved last time. The first response then refreshes them.
- **A window that has reset shows 0%.** It stays at 0% until the next response brings fresh numbers. A window disappears only when Claude Code stops reporting it and its reset time has passed.
- **Small categories may be a hairline.** The bar's proportions are exact, so a tiny category can be thinner than one cell. The legend always lists it.
- **No cloud credit figure.** Cloud sessions draw on the same 5-hour and weekly windows as the rest of your account, and Claude Code exposes no separate credit balance to mods.
- **The TTL countdown is an estimate.** It counts from the end of the last response, but the API counts a cache's lifetime from the start of the request, so the cache expires earlier than the timer shows by however long the response took to stream. On the one-hour TTL, keep-warm's 8-minute lead covers responses up to about 8 minutes. On the five-minute TTL its 75-second lead covers only short responses: after a longer one, the ping can arrive when the cache is already cold, and keep-warm then stops (`stopped: cache was cold`) rather than paying to re-cache.

## How it works

| Hook | What it does |
|------|--------------|
| `session.start` | Registers `/context-bar`, restores the saved choices and the last usage seen, takes a first reading, and ticks a clock every 30 seconds for the countdowns. On the same tick it refreshes the usage snapshot while this session is the one that wrote it last. |
| `session.measure` | Takes a new reading after each turn, and whenever a usage window changes, band shown or not, and writes the snapshot when the figures changed. |
| `turn.start`, `turn.complete` | Marks a turn running, so no ping is sent; a response restarts the TTL countdown and arms the next ping. |
| `prompt.submit` | A prompt from you turns keep-warm off; background deliveries do not; the text passes through unread. |
| `session.compact`, `session.end` | Compaction stops keep-warm and restarts the countdown; `/clear` forgets the cache. |
| `command.run` (`context-bar`) | Shows or hides the band where it draws; answers with the reading as text where nothing draws, with `text`, or with the snapshot's path with `file`. |
| `ui.render` (`AbovePrompt`) | Draws the band as a client module ([`hooks/band.tsx`](hooks/band.tsx)). The band lays itself out to the available width and reports clicks. Other mods drawing above the prompt keep their place; Token Watch adds its band beneath theirs. |
| `ui.message` | Receives the clicks: a right click moves to the next view, the timer or `Keep warm` toggles keep-warm, `Refresh caps` starts its caps over. |

**Bars on each surface:** on the desktop app, bars are boxes 60% of the line's height. In a terminal they are `▄` blocks. Both are thinner than the line, so stacked bars keep a gap between them.

## Development

```text
token-watch/
├── .claude-plugin/plugin.json        manifest
├── .claude-plugin/marketplace.json   lists this repository as its own marketplace
├── hooks/hooks.json                  points Claude Code at register.tsx
├── hooks/register.tsx                hooks, readings and saved state
├── hooks/band.tsx                    the band: layout, bars, legend, clicks
├── hooks/cache.ts                    the TTL rules and keep-warm's policy: constants and pure functions
├── hooks/format.ts                   names, order, countdowns and token counts, shared by the band, the text reply and the snapshot
├── types/index.d.ts                  shared types and state declarations
├── tests/context-bar.test.tsx        tests for the terminal and desktop surfaces
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

**What the tests cover:** both surfaces, expanded and collapsed. They also cover:
- narrow widths,
- extra usage windows,
- sessions without plan limits,
- restoring saved usage,
- windows that reset,
- sharing the band with another mod,
- the text reply where nothing draws (the VS Code chat panel, headless),
- the usage snapshot: its content, the heartbeat, several sessions, the off switch,
- the TTL row, its countdown and colours, the buttons and the desktop's chips, Refresh caps, keep-warm's schedule with a mocked clock and a stubbed fork, its caps and every stop condition, the TTL's precedence, the snapshot's cache object.

**Seeing your edits:**
- In an open session, `/reload-plugins` reads the plugin straight from its folder.
- A Claude Code restart loads the installed copy instead, so reinstall after editing to update it.

## Credits

- **Original sample:** Token Watch began from the `token-weather` sample mod in Anthropic's [claude-code-playground](https://github.com/anthropics/claude-code-playground) (Apache-2.0). It has since been rewritten and redesigned.
- **Usage rows:** modelled on [usage-band](https://github.com/iamkhalid2/usage-band) by iamkhalid2 (MIT).

Token Watch is an independent project, not affiliated with or endorsed by Anthropic. Claude and Claude Code are Anthropic's names for its products.

## License

[Apache License 2.0](LICENSE).
