# Maxpool Claude Quota Bar

Display real-time **5-hour Session** and **Weekly** token usage percentages across multiple Claude accounts managed by [Maxpool](https://github.com) directly in the VS Code status bar.

## Features
- **Live Visual Progress Bars:** Shows exact used percentages (`⚡acc1: ▰▰▱▱▱ 35% (W:48%) | acc2: ▱▱▱▱▱ 1% (W:0%)`).
- **Reset Times:** See when each account's 5-hour session and weekly quota reset next (24-hour clock, local time zone), with a countdown.
- **Active Account Indicator:** Highlights the currently active account with `⚡`.
- **Rich Hover Card:** Hover the status bar item for per-account usage meters, reset times and token totals. The card stays open when you move the mouse into it and has **Refresh now** and **Settings** buttons.
- **Click-to-Refresh:** Click the status bar item anytime to immediately fetch the latest usage stats.
- **Zero External Scripts Required:** Automatically locates `maxpool` across system paths and `nvm` installations.

## Requirements
- [Maxpool](https://github.com) installed and running (`maxpool server`).

## Extension Settings
- `maxpoolQuota.binaryPath`: Custom path to the `maxpool` executable (leave empty for auto-detection).
- `maxpoolQuota.refreshIntervalSeconds`: Auto-refresh interval in seconds (default: `15`).
