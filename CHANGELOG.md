# Changelog

All notable changes to Token Watch are listed here. The project follows [Semantic Versioning](https://semver.org/).

## Unreleased

### Changed

- **`/context-bar` is now `/token-watch`:** `/token-watch [text|file|settings|monitor]`. The old name is gone, with no alias: type `/token-watch` where you typed `/context-bar`. The settings panel is now titled TW Settings.

## 1.3.0 (2026-10-25)

A settings panel: choose what the band shows, and set keep-warm's caps.

### Added

- **Settings panel:** opened by `/context-bar settings` or a `[≡]` button beside the expanded band (☰ on the desktop). It docks beside the transcript where the terminal docks panes, opens inline on its main screen, and sits beside the chat on the desktop.
- **Show in the band:** toggles for 5H, WK, other windows (OTH), CTX and TTL, applied to every view and saved. Hiding CTX takes its legend; hiding TTL takes the timer and keep-warm's buttons, turns keep-warm off and keeps it off while TTL is hidden, a reload included. With every part hidden, the `[≡]` button stays.
- **Keep-warm caps:** minus and plus steppers for this session's TTL, within bounds (1 to 24 pings and hours on the hour; 5 to 100 pings in steps of 5 and 1 to 6 hours on five minutes), and `Reset` to the defaults. Saved; a running keep-warm already past a new cap stops at once. The band and `/context-bar text` follow them.

### Changed

- `/context-bar` takes `settings`.
- The snapshot's keep-warm caps (`maxPings`, `maxMs`) follow the settings panel.

## 1.2.0 (2026-10-25)

The prompt cache gets a row: how long until the API forgets this conversation, and an opt-in keep-warm that refreshes it while you are away.

### Added

- **TTL row:** the prompt cache's time left over its whole time to live, `52:50 / 60:00`, counted from the end of each response, and a keep-warm button. The row sits under the context legend. The TTL is `1h` on a Claude subscription within plan usage, `5m` with an API key, a cloud provider or usage credits, or whatever `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting or `ENABLE_PROMPT_CACHING_1H` say; `/context-bar text` and the snapshot name which. The timer reads `--:--` before the first response and once the countdown runs out. The collapsed views end with the countdown as a button.
- **Keep-warm (opt-in, off by default, per session):**
  - **What it does:** click `Keep Warm` (on the collapsed lines, the timer), and Token Watch sends a tiny request over the conversation, asking for a one-word reply, shortly before the cache would expire: 8 minutes before on the hour, 75 seconds before on five minutes. Only one is ever out at a time.
  - **What it costs:** each ping is a real request against your plan usage, mostly read at the cached rate. While keep-warm is on, the row shows its caps (`Pings: 3/8  Time: 42:05 / 8:00:00`) and, for a minute, the last ping's counts, in a band 90 columns or wider.
  - **When it stops:** when you send a prompt, at the caps (8 pings or 8 hours on the hour, 30 pings or 2 hours on five minutes), after two failed pings in a row, when a ping finds the cache already cold or the countdown runs out first, at compaction, and when the session ends.
- **Refresh Caps:** while keep-warm is on, a `Refresh Caps` button starts its caps over: pings and time on back to zero, failures forgotten, the note cleared. It sends no ping and does not move the schedule; it does nothing, and is not drawn, while keep-warm is off.
- **The buttons are the indicators:** every button is a filled chip, on the terminal and the desktop alike, and the whole chip is clickable. The keep-warm button says what a click would do, or why it can't: `Keep Warm` in grey, `Let Chill` in green while keep-warm is on, `Cache Lost` in red once the countdown runs out, `No Data` in red before the first response. The collapsed timer takes the same colour. In a terminal the keep-warm button keeps one width, so the caps after it stay put.
- **Snapshot:** schema 1 gains a `cache` object (`ttl`, `ttlSource`, `expiresAt`, `warm`, `keepWarm`).
- **`/context-bar text`:** ends with `TTL 47:12 (1h · subscription)` once there is a countdown (`TTL lost` once it runs out), with keep-warm's caps and the last ping while they apply.
- **Strict TypeScript:** a strict `tsconfig.json` (the settings the engine's API types recommend, with `noUncheckedIndexedAccess`); the hooks, types and tests type-check cleanly with `tsc -p .`.

### Changed

- **Right click cycles three views:** expanded, collapsed with bars, collapsed without bars. A left click no longer does anything but press a button. The saved view replaces the old collapsed and bars choices, which are read once and removed.
- The collapsed line keeps 10 cells for the timer, so its detail and meters drop a little earlier as the window narrows.
- **Privacy:** keep-warm is the only thing that spends usage, and only while you have it on. Token Watch now also reads the `promptCacheTtl` setting and three of the prompt cache's environment variables.
- Requires Claude Code 2.1.288 or later, for `$.model.fork` and `$.settings.read`; tested on 2.1.310.

## 1.1.0 (2026-10-09)

Token Watch reaches the VS Code extension: `/context-bar` answers as text where the band can't be drawn, and a usage snapshot file feeds the new companion, [Token Watch for VS Code](https://github.com/nevermemo/token-watch-vscode).

### Added

- **Clicks, as in Token Watch for VS Code:** a right click expands or collapses the band; a left click on the collapsed line turns its bars on or off (the expanded table always keeps them). The bars choice is kept across sessions.
- **`/context-bar` as text:** where nothing draws (the VS Code extension's chat panel, `claude -p`), `/context-bar` answers with the reading as one line, `5H 62% (2h 14m) · WK 31% (3d 4h) · CTX 21% (212k / 1M)`, instead of toggling a band nobody would see. `/context-bar text` asks for that line anywhere.
- **Usage snapshot:** after each reading, Token Watch writes `~/.claude/token-watch/usage.json` (schema 1): the usage windows with their labels and reset times, the context total, window, auto-compact point and categories, the session's id and directory, and a timestamp. It is written again every 30 seconds while the session is alive, so a reader can tell a live session from one that ended; with several sessions open, the most recently active one keeps the file. On by default; the plugin's **Usage snapshot file** option (`/config`) turns it off. `/context-bar file` shows the path and the last write.
- **Companion:** [Token Watch for VS Code](https://github.com/nevermemo/token-watch-vscode) shows the snapshot in the status bar, with a tooltip and a panel that draws the same bars.

### Changed

- A left click no longer collapses the band; a right click does.
- The band's formatting (window names and order, countdowns, token counts, level colours) moved to `hooks/format.ts`, shared by the band, the text reply and the snapshot.
- Readings are taken after each turn even while the band is hidden, so the snapshot stays current.
- The README's privacy section now lists the one file the mod writes and the two environment variables it reads.
- Terminal bars are drawn with `▄` (lower half block) instead of `▆`: every console font has it, so the classic Windows console no longer shows boxes, and at half a line it sits closer to the desktop app's 60% bars.

### Fixed

- In a narrow terminal the collapsed line could shorten `CTX` to `C…`; the label and the percentage now keep their width and the bar gives way.

## 1.0.0 (2026-10-09)

First release.

### The band

- **Expanded view:** an aligned table above the prompt. Each row has a label, a thin bar, a percentage and a dim detail:
  - `5H`: the 5-hour usage window, with its reset countdown.
  - `WK`: the weekly usage window, with its reset countdown.
  - Any other window Claude Code reports: a model's own allowance (`FB`, `OP`, `SN`, `HK`) or a gateway's spend limit (`$$`).
  - `CTX`: the context window, with tokens in use.
- **Context bar:** one colour per category, largest first. The free space is a light track, and the reserve past the auto-compact point is a darker shade. Under the bar, a legend lists every category, largest first, and wraps onto more lines when it doesn't fit.
- **Collapsed view:** a single line that never wraps. As the window narrows, the small usage bars drop first, then the token detail.
- **Same look everywhere:** one layout and palette in the terminal and the desktop app. The bars are thinner than the line, so stacked bars keep a gap between them.
- **Colours:** percentages turn yellow from 50% and red from 80%. Usage bars fill green, yellow or red by the same thresholds.

### Behaviour

- **Click to toggle:** a click anywhere on the band collapses or expands it.
- **`/context-bar`:** shows or hides the band. Both choices are kept across sessions.
- **Restored usage:** a new session shows the last usage seen until its first response brings fresh numbers.
- **Resets:** a window whose reset time has passed shows 0%. A window is dropped only once Claude Code stops reporting it and its reset time has passed.
- **Other mods:** anything another mod draws above the prompt stays, and Token Watch adds its band beneath it.
- **Read-only:** no network requests, no file or environment reads, no access to prompts or tool calls.

### Credits

- **Original sample:** began from the `token-weather` sample mod in Anthropic's [claude-code-playground](https://github.com/anthropics/claude-code-playground) (Apache-2.0), then rewritten and redesigned.
- **Usage rows:** modelled on [usage-band](https://github.com/iamkhalid2/usage-band) by iamkhalid2 (MIT).
