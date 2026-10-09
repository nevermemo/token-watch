# Changelog

All notable changes to Token Watch are listed here. The project follows [Semantic Versioning](https://semver.org/).

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
