// Monitors a floor-plan / availability listing page for changes.
//
// The target page is a JavaScript single-page app whose floor-plan data loads
// client-side after render, so we drive a headless browser. We parse the
// "Featured Floor Plans" section into one record per plan (name, layout,
// availability, units, price), diff it against the last committed snapshot
// (snapshots/floorplan.json), and on any change: send a Discord alert, append a
// human-readable entry to history.md, and overwrite the snapshot so the next
// run compares against it.
//
// Configuration comes entirely from environment variables (set via GitHub
// secrets/variables) so nothing site-specific lives in the code:
//   TARGET_URL          (required) the listing page to watch
//   DISCORD_WEBHOOK_URL (required for alerts) Discord webhook to post to
//   MONITOR_NAME        (optional) label used in alerts; defaults to the host

import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";

const TARGET_URL = process.env.TARGET_URL;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const MONITOR_NAME =
  process.env.MONITOR_NAME ||
  (TARGET_URL ? safeHost(TARGET_URL) : "Listing monitor");

const SNAPSHOT_FILE = "snapshots/floorplan.json";
const HISTORY_FILE = "history.md";

// The plan list lives between the "Featured Floor Plans" heading and the
// "View All Floor Plans" button; anchoring on those keeps nav/footer/reviews
// out of the parse.
const START_RE = /featured floor plans/i;
const END_RES = [
  /view all floor plans/i,
  /welcome to our neighborhood/i,
  /all layouts, square footage/i,
];
const SPECS_RE = /sq\.?\s*ft\.?/i; // a plan's layout line, e.g. "1 Bed | 1 Bath | 668 sq. ft."
const PRICE_RE = /\$[\d,.\-]+\+?\s*\/\s*month/i;
const UNITS_RE = /(\d+)\s+Available Units/i;

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "Listing monitor";
  }
}

function now() {
  // Uses the TZ environment variable if the workflow sets one; else UTC.
  return new Date().toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

async function scrapeLines() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    });
    await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 90_000 });
    // The SPA hydrates and fetches data after load; best-effort wait for the
    // floor-plan text, then a short settle.
    await page
      .waitForFunction(() => /featured floor plans/i.test(document.body.innerText), {
        timeout: 30_000,
      })
      .catch(() => {});
    await page.waitForTimeout(4000);
    const fullText = await page.evaluate(() => document.body.innerText);
    return fullText.split("\n").map((l) => l.replace(/\s+/g, " ").trim());
  } finally {
    await browser.close();
  }
}

// Parse the featured floor-plan section into { "5-45 G": {name, layout,
// available, units, price}, ... }. Each plan block looks like:
//   Available | Not Available     <- status (line before the name)
//   5-45 G                        <- name (line before the layout line)
//   Studio | 1 Bath | 428 sq. ft. <- layout (matches SPECS_RE)
//   1 Available Units             <- (only when available)
//   $3,786+/month                 <- (only when available)
//   VIEW FLOOR PLAN / CONTACT US
function parsePlans(lines) {
  const start = lines.findIndex((l) => START_RE.test(l));
  if (start === -1) return null; // anchor missing -> signal a bad scrape

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (END_RES.some((re) => re.test(lines[i]))) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end);

  const plans = {};
  for (let i = 1; i < section.length; i++) {
    if (!SPECS_RE.test(section[i])) continue;
    const layout = section[i];
    const name = section[i - 1];
    const status = section[i - 2] || "";
    if (!name) continue;

    // Look a few lines ahead for units + price (present only when available).
    const window = section.slice(i + 1, i + 5).join("\n");
    const unitsMatch = window.match(UNITS_RE);
    const priceMatch = window.match(PRICE_RE);

    plans[name] = {
      name,
      layout,
      available: /^available$/i.test(status.trim()),
      units: unitsMatch ? Number(unitsMatch[1]) : 0,
      price: priceMatch ? priceMatch[0].replace(/\s+/g, "") : null,
    };
  }
  return plans;
}

// Compare two plan maps and return human-readable change descriptions.
function diffPlans(oldPlans, newPlans) {
  const changes = [];
  const oldKeys = new Set(Object.keys(oldPlans));
  const newKeys = new Set(Object.keys(newPlans));

  for (const name of newKeys) {
    if (!oldKeys.has(name)) {
      const p = newPlans[name];
      changes.push(
        `🆕 New floor plan **${name}** — ${p.layout}` +
          (p.available ? ` · ${p.units} available · ${p.price ?? "price n/a"}` : " · Not available")
      );
    }
  }
  for (const name of oldKeys) {
    if (!newKeys.has(name)) changes.push(`❌ Removed floor plan **${name}**`);
  }
  for (const name of newKeys) {
    if (!oldKeys.has(name)) continue;
    const o = oldPlans[name];
    const n = newPlans[name];
    if (o.available !== n.available)
      changes.push(
        n.available
          ? `✅ **${name}** is now AVAILABLE (${n.layout}) · ${n.units} unit(s) · ${n.price ?? "price n/a"}`
          : `⛔ **${name}** is no longer available`
      );
    else if (n.available && o.units !== n.units)
      changes.push(`🔢 **${name}** availability changed: ${o.units} → ${n.units} unit(s)`);
    if (n.available && o.price !== n.price)
      changes.push(`💲 **${name}** price changed: ${o.price ?? "n/a"} → ${n.price ?? "n/a"}`);
    if (o.layout !== n.layout)
      changes.push(`📐 **${name}** layout changed: "${o.layout}" → "${n.layout}"`);
  }
  return changes;
}

async function sendDiscord(content) {
  if (!WEBHOOK) {
    console.log("DISCORD_WEBHOOK_URL not set — skipping notification.");
    return;
  }
  const body = content.length > 1900 ? content.slice(0, 1900) + "\n…(truncated)" : content;
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: body }),
  });
  if (!res.ok) console.error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  else console.log("Discord notification sent.");
}

function appendHistory(changes) {
  appendFileSync(
    HISTORY_FILE,
    `\n## ${now()}\n\n${changes.map((c) => `- ${c}`).join("\n")}\n`
  );
}

async function main() {
  if (!TARGET_URL) {
    console.error("TARGET_URL environment variable is required.");
    process.exit(1);
  }

  const lines = await scrapeLines();
  const current = parsePlans(lines);

  if (!current || Object.keys(current).length === 0) {
    console.error("Parsed 0 floor plans — treating as a bad scrape, NOT updating snapshot.");
    process.exit(1); // fail loudly so a broken scrape can't wipe the baseline or false-alert
  }
  console.log(`Parsed ${Object.keys(current).length} floor plans.`);

  if (!existsSync(SNAPSHOT_FILE)) {
    writeFileSync(SNAPSHOT_FILE, JSON.stringify(current, null, 2) + "\n");
    console.log("First run — baseline snapshot saved, no change alert sent.");
    await sendDiscord(
      `✅ ${MONITOR_NAME} monitor is live — tracking ${Object.keys(current).length} floor plans. ` +
        `You'll be alerted here on any change.`
    );
    return;
  }

  const previous = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8"));
  const changes = diffPlans(previous, current);

  if (changes.length === 0) {
    console.log("No change.");
    return;
  }

  console.log(`Change detected:\n${changes.join("\n")}`);
  const msg =
    `🏢 **${MONITOR_NAME} floor plans changed** (${now()})\n${TARGET_URL}\n\n` +
    changes.map((c) => `• ${c}`).join("\n");
  await sendDiscord(msg);
  appendHistory(changes);
  writeFileSync(SNAPSHOT_FILE, JSON.stringify(current, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
