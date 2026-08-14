# Floor-plan monitor

Watches a floor-plan / availability listing page and sends a **Discord** alert
(which push-notifies your phone via the Discord mobile app) whenever the floor
plans change — so you're first to know about new plans, availability flips, or
price changes.

- **Free.** Runs on GitHub Actions. Use a **public** repo for unlimited minutes.
- **Frequent.** Each scheduled run loops internally, checking every 5 minutes
  (configurable), because GitHub's cron scheduler is delayed/unreliable.
- **History.** Every detected change is committed (timestamped `git log` + full
  `git diff`) and summarized in [`history.md`](./history.md).

## How it works

The target page is a JavaScript single-page app whose floor-plan data loads
after render, so `monitor.mjs` uses Playwright (headless Chrome) to render it,
parses the "Featured Floor Plans" section into one record per plan (layout,
availability, units, price), and diffs it against `snapshots/floorplan.json`. On
any change (new plan, availability flip, price/unit change, removal) it alerts
Discord, appends to `history.md`, and updates the snapshot.

Nothing site-specific is hardcoded — the page URL and alert label are supplied
via configuration.

## Configuration

Set these in the repo under **Settings → Secrets and variables → Actions**:

| Key | Kind | Required | Purpose |
|---|---|---|---|
| `TARGET_URL` | Secret | ✅ | The listing page URL to watch |
| `DISCORD_WEBHOOK_URL` | Secret | ✅ (for alerts) | Discord webhook to post to |
| `MONITOR_NAME` | Variable | optional | Label shown in alerts (defaults to the URL host) |
| `TZ` | Variable | optional | Timezone for history timestamps, e.g. `America/New_York` (default `UTC`) |

## Setup (one time)

1. **Make the repo public** so Actions minutes are free and unlimited.
2. **Create a Discord webhook** (channel → Edit Channel → Integrations →
   Webhooks → New Webhook → Copy URL). Install the Discord mobile app for phone
   alerts.
3. **Add the secrets/variables** from the table above.
4. **Enable Actions**, then open the workflow → **Run workflow** for the first
   run. It saves a baseline and sends a "monitor is live" message — no change
   alert yet.

## Tuning

Edit `.github/workflows/monitor.yml`:

- `CHECK_INTERVAL_SECONDS` — how often to check within a run (default `300` =
  5 min; can go as low as ~`120`).
- `LOOP_MINUTES` — how long each run loops (default `28`; keep below the cron gap).
- `schedule` cron — the heartbeat that starts each run (default every 30 min).

**Note:** GitHub disables scheduled workflows after **60 days of no repo
activity**. Detected changes commit automatically (which counts as activity); if
the page is static for months, re-enable it from the Actions tab.
