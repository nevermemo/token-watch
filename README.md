# Token Watch

**See your Claude Code plan usage and context window at a glance, right above the prompt.**

Token Watch is a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview). It draws a small band above the prompt with your plan usage and your context window. The 5-hour and weekly windows each get a bar and a reset countdown. The context window gets a bar broken down by what fills it. Right-click the band to fold it into a single line. Where Claude Code draws no mod (the VS Code extension's chat panel), `/context-bar` answers with the reading as a line of text, and the companion extension [Token Watch for VS Code](https://github.com/nevermemo/token-watch-vscode) shows it in the status bar.

Expanded:

```text
╭──────────────────────────────────────────────────────────────────╮
│ 5H   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  62%  2h 14m   │
│ WK   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  31%  3d 4h    │
│ CTX  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  21%  212k / 1M│
│      ▄ messages 186k   ▄ tools 12k   ▄ memory 4.9k   ▄ skills 3k │
╰──────────────────────────────────────────────────────────────────╯
```

Collapsed:

```text
 5H ▄▄▄▄▄▄▄▄▄▄ 62%   WK ▄▄▄▄▄▄▄▄▄▄ 31%   CTX ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ 21%  212k / 1M
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

- **The context bar:** has one coloured piece per category (messages, tools, MCP tools, skills, memory files and so on), largest first. A legend under the bar names each colour.
  - The light grey track is free space.
  - The darker end is the reserve past the auto-compact point.
- **Colours:**
  - **Percentages:** plain below 50%, yellow from 50%, red from 80%.
  - **Usage bars:** fill green, yellow or red by the same thresholds.
- **Missing usage rows:** these rows appear only on a subscription plan. With an API key, the band shows the context row alone.

## Using it

- **Right-click the band** to collapse it to one line, or to expand it again.
- **Left-click the collapsed line** to turn its bars off or on: `5H 62%   WK 31%   CTX 21%  212k / 1M`. The expanded table always keeps its bars.
- **Rest the pointer on the collapsed line** for about half a second to peek at the expanded table. It folds back when the pointer leaves, and nothing is saved.
- **`/context-bar`** hides or shows the band. Where the band can't be drawn (the VS Code extension's chat panel, `claude -p`), it answers with the reading as one line instead: `5H 62% (2h 14m) · WK 31% (3d 4h) · CTX 21% (212k / 1M)`.
- **`/context-bar text`** answers with that line anywhere.
- **`/context-bar file`** says where the usage snapshot is and when it was last written.
- **Saved choices:** collapsed or expanded, bars on or off, and shown or hidden are kept across sessions.
- **Narrow windows:** the collapsed line never wraps. As the window narrows, the small usage bars drop first, then the `99k / 1M` detail. The percentages always stay.

## Install

**Requirements:** Claude Code **2.1.287 or later** (`claude --version`). Token Watch draws in **the terminal** and in **the Code tab of the Claude desktop app**. Token Watch for VS Code needs Token Watch 1.1.0 or later.

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

To pin a release, add `"ref": "v1.1.0"` to the `source` object. Administrators can also require the marketplace or the plugin on every machine through managed settings. See [Manage mods for your organization](https://code.claude.com/docs/en/plugins/mods/admin).

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
  "session": { "id": "4d1f…", "cwd": "C:\\Users\\micro\\proj" },
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
  }
}
```

- `windows`: in the band's order, with its labels (`5H`, `WK`, `FB`…), `percentUsed` as reported and `resetsAt` as ISO 8601 or `null`. A window whose `resetsAt` has passed has started over: show it at 0%.
- `context`: `null` until the first breakdown. `categories` are the `/context` rows with their colours; a `free` or `buffer` row's colour is whatever Claude Code reports, so draw those with a track colour. The reserve past the auto-compact point is `window - compactsAt`.
- `session`: the session's id and working directory, or `null` where Claude Code has none.
- The file is rewritten in place, not atomically: a reader that fails to parse it should read again a moment later.

## Privacy and permissions

Token Watch only reads numbers Claude Code already has. It makes **no network requests**, starts **no processes**, and never touches your prompts or tool calls. It writes **one file** on your machine, the [usage snapshot](#the-usage-snapshot), reads nothing but that file's timestamp, and reads two environment variables to find your home directory. The snapshot can be turned off.

You can check this yourself before installing: `claude plugin validate ./token-watch` lists every hook a mod registers and every API it calls. For Token Watch:

- **Hooks:** `session.start`, `session.measure`, `command.run` (for `/context-bar`), `ui.message` (the clicks), and `ui.render` (the band above the prompt).
- **Calls:**
  - `$.session.usage`: the context breakdown and usage windows. Claude Code estimates these locally, without extra API requests.
  - `$.session.surfaces`, `$.session.id`, `$.session.cwd`: where the session draws (so `/context-bar` knows whether to toggle the band or answer as text), and the session's id and directory for the snapshot.
  - `$.clock`: the reset countdowns and the snapshot's 30-second refresh.
  - `$.command.register`: adds `/context-bar`.
  - `$.store`: remembers your choices and the last usage seen.
  - `$.state` and `$.ui.resolve`: share data between the mod's hooks and draw the band.
  - `$.env.get` (`USERPROFILE`, `HOME`): your home directory, for the snapshot's path. Nothing else is read from the environment.
  - `$.fs.write` and `$.fs.stat`: write the snapshot and check its timestamp. No other file is written, and no file is read.

**What it saves:** `$.store` keeps four things in Claude Code's own plugin storage on your machine:
- whether the band is collapsed,
- whether it's hidden,
- whether the collapsed line's bars are off,
- the last usage windows seen (percentages and reset times).

The snapshot file is described [above](#the-usage-snapshot).

## Good to know

- **A new session shows the last usage seen.** Claude Code reports usage only with a response, so a new session starts from the figures saved last time. The first response then refreshes them.
- **A window that has reset shows 0%.** It stays at 0% until the next response brings fresh numbers. A window disappears only when Claude Code stops reporting it and its reset time has passed.
- **Small categories may be a hairline.** The bar's proportions are exact, so a tiny category can be thinner than one cell. The legend always lists it.
- **No cloud credit figure.** Cloud sessions draw on the same 5-hour and weekly windows as the rest of your account, and Claude Code exposes no separate credit balance to mods.

## How it works

| Hook | What it does |
|------|--------------|
| `session.start` | Registers `/context-bar`, restores the saved choices and the last usage seen, takes a first reading, and ticks a clock every 30 seconds for the countdowns. On the same tick it refreshes the usage snapshot while this session is the one that wrote it last. |
| `session.measure` | Takes a new reading after each turn, and whenever a usage window changes, band shown or not, and writes the snapshot when the figures changed. |
| `command.run` (`context-bar`) | Shows or hides the band where it draws; answers with the reading as text where nothing draws, with `text`, or with the snapshot's path with `file`. |
| `ui.render` (`AbovePrompt`) | Draws the band as a client module ([`hooks/band.tsx`](hooks/band.tsx)). The band lays itself out to the available width, reports clicks, and opens the hover peek itself. Other mods drawing above the prompt keep their place; Token Watch adds its band beneath theirs. |
| `ui.message` | Receives the clicks: a right click flips between expanded and collapsed, a left click on the collapsed line turns its bars on or off. |

**Bars on each surface:** on the desktop app, bars are boxes 60% of the line's height. In a terminal they are `▄` blocks. Both are thinner than the line, so stacked bars keep a gap between them.

## Development

```text
token-watch/
├── .claude-plugin/plugin.json        manifest
├── .claude-plugin/marketplace.json   lists this repository as its own marketplace
├── hooks/hooks.json                  points Claude Code at register.tsx
├── hooks/register.tsx                hooks, readings and saved state
├── hooks/band.tsx                    the band: layout, bars, legend, clicks, hover
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
- the usage snapshot: its content, the heartbeat, several sessions, the off switch.

**Seeing your edits:**
- In an open session, `/reload-plugins` reads the plugin straight from its folder.
- A Claude Code restart loads the installed copy instead, so reinstall after editing to update it.

## Credits

- **Original sample:** Token Watch began from the `token-weather` sample mod in Anthropic's [claude-code-playground](https://github.com/anthropics/claude-code-playground) (Apache-2.0). It has since been rewritten and redesigned.
- **Usage rows:** modelled on [usage-band](https://github.com/iamkhalid2/usage-band) by iamkhalid2 (MIT).

Token Watch is an independent project, not affiliated with or endorsed by Anthropic. Claude and Claude Code are Anthropic's names for its products.

## License

[Apache License 2.0](LICENSE).
