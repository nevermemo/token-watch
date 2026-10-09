# Token Watch

**See your Claude Code plan usage and context window at a glance, right above the prompt.**

Token Watch is a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview). It draws a small band above the prompt with your plan usage and your context window. The 5-hour and weekly windows each get a bar and a reset countdown. The context window gets a bar broken down by what fills it. Click the band to fold it into a single line.

Expanded:

```text
╭──────────────────────────────────────────────────────────────────╮
│ 5H   ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆  62%  2h 14m   │
│ WK   ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆  31%  3d 4h    │
│ CTX  ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆  21%  212k / 1M│
│      ▆ messages 186k   ▆ tools 12k   ▆ memory 4.9k   ▆ skills 3k │
╰──────────────────────────────────────────────────────────────────╯
```

Collapsed:

```text
 5H ▆▆▆▆▆▆▆▆▆▆ 62%   WK ▆▆▆▆▆▆▆▆▆▆ 31%   CTX ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆ 21%  212k / 1M
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

- **Click anywhere on the band** to collapse it to one line, or to expand it again.
- **`/context-bar`** hides or shows the band.
- **Saved choices:** both settings are kept across sessions.
- **Narrow windows:** the collapsed line never wraps. As the window narrows, the small usage bars drop first, then the `99k / 1M` detail. The percentages always stay.

## Install

**Requirements:** Claude Code **2.1.287 or later** (`claude --version`). Token Watch draws in **the terminal** and in **the Code tab of the Claude desktop app**.

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

To pin a release, add `"ref": "v1.0.0"` to the `source` object. Administrators can also require the marketplace or the plugin on every machine through managed settings. See [Manage mods for your organization](https://code.claude.com/docs/en/plugins/mods/admin).

### Uninstall

```bash
claude plugin uninstall token-watch@token-watch
```

## Where it works

| Where you run Claude Code | Token Watch |
|---------------------------|-------------|
| `claude` in a terminal (including editor terminals and JetBrains) | Shown |
| The Code tab of the Claude desktop app | Shown |
| The VS Code extension's chat panel, `claude -p`, the Agent SDK | Loads but isn't drawn: Claude Code shows no mod drawings there |
| Cloud sessions | Isn't drawn: cloud sessions don't load plugins installed on your machine, and don't show mod drawings |

## Privacy and permissions

Token Watch only reads numbers Claude Code already has. It makes **no network requests**, reads **no files or environment variables**, starts **no processes**, and never touches your prompts or tool calls.

You can check this yourself before installing: `claude plugin validate ./token-watch` lists every hook a mod registers and every API it calls. For Token Watch:

- **Hooks:** `session.start`, `session.measure`, `command.run` (for `/context-bar`), `ui.message` (the click), and `ui.render` (the band above the prompt).
- **Calls:**
  - `$.session.usage`: the context breakdown and usage windows. Claude Code estimates these locally, without extra API requests.
  - `$.clock`: the reset countdowns.
  - `$.command.register`: adds `/context-bar`.
  - `$.store`: remembers your choices and the last usage seen.
  - `$.state` and `$.ui.resolve`: share data between the mod's hooks and draw the band.

**What it saves:** `$.store` keeps four things in Claude Code's own plugin storage on your machine:
- whether the band is collapsed,
- whether it's hidden,
- the last usage percentages,
- their reset times.

## Good to know

- **A new session shows the last usage seen.** Claude Code reports usage only with a response, so a new session starts from the figures saved last time. The first response then refreshes them.
- **A window that has reset shows 0%.** It stays at 0% until the next response brings fresh numbers. A window disappears only when Claude Code stops reporting it and its reset time has passed.
- **Small categories may be a hairline.** The bar's proportions are exact, so a tiny category can be thinner than one cell. The legend always lists it.
- **No cloud credit figure.** Cloud sessions draw on the same 5-hour and weekly windows as the rest of your account, and Claude Code exposes no separate credit balance to mods.

## How it works

| Hook | What it does |
|------|--------------|
| `session.start` | Registers `/context-bar`, restores the saved choices and the last usage seen, takes a first reading, and ticks a clock every 30 seconds for the countdowns. |
| `session.measure` | Takes a new reading after each turn, and whenever a usage window changes. |
| `command.run` (`context-bar`) | Shows or hides the band. |
| `ui.render` (`AbovePrompt`) | Draws the band as a client module ([`hooks/band.tsx`](hooks/band.tsx)). The band lays itself out to the available width and reports clicks. Other mods drawing above the prompt keep their place; Token Watch adds its band beneath theirs. |
| `ui.message` | Receives the click and flips between expanded and collapsed. |

**Bars on each surface:** on the desktop app, bars are boxes 60% of the line's height. In a terminal they are `▆` blocks. Both are thinner than the line, so stacked bars keep a gap between them.

## Development

```text
token-watch/
├── .claude-plugin/plugin.json        manifest
├── .claude-plugin/marketplace.json   lists this repository as its own marketplace
├── hooks/hooks.json                  points Claude Code at register.tsx
├── hooks/register.tsx                hooks, readings and saved state
├── hooks/band.tsx                    the band: layout, bars, legend, clicks
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
- sharing the band with another mod.

**Seeing your edits:**
- In an open session, `/reload-plugins` reads the plugin straight from its folder.
- A Claude Code restart loads the installed copy instead, so reinstall after editing to update it.

## Credits

- **Original sample:** Token Watch began from the `token-weather` sample mod in Anthropic's [claude-code-playground](https://github.com/anthropics/claude-code-playground) (Apache-2.0). It has since been rewritten and redesigned.
- **Usage rows:** modelled on [usage-band](https://github.com/iamkhalid2/usage-band) by iamkhalid2 (MIT).

## License

[Apache License 2.0](LICENSE).
