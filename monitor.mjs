// Monitors one or more floor-plan / availability listing pages for changes.
//
// Each TARGET is a listing page rendered by a headless browser (the data loads
// client-side). Per target we parse the plans into one record per unit
// (name, layout, availability, units, price), diff against that target's last
// committed snapshot, and on any change: send a labeled Discord alert, append a
// labeled entry to history.md, and overwrite that target's snapshot.
//
// Two sources are tracked so we can compare which reflects reality first:
//   - Heatherwood marketing site  (TARGET_URL)          -> snapshots/heatherwood.json
//   - SecureCafe leasing portal   (TARGET_URL_SECURECAFE) -> snapshots/securecafe.json
// A target whose URL env var is unset is simply skipped, so this degrades to a
// single-source monitor if you only configure one.
//
// Config (via GitHub secrets/variables):
//   TARGET_URL             the Heatherwood listing page
//   TARGET_URL_SECURECAFE  the SecureCafe onlineleasing floorplans page
//   DISCORD_WEBHOOK_URL    (required for alerts) Discord webhook to post to
//   MONITOR_NAME           (optional) label for the Heatherwood source

import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const HISTORY_FILE = "history.md";

// ---------------------------------------------------------------------------
// Parsers — one per source, because the two platforms render differently.
// ---------------------------------------------------------------------------

const SPECS_RE = /sq\.?\s*ft\.?/i; // a layout line, e.g. "1 Bed | 1 Bath | 668 sq. ft."

// Heatherwood (marketing SPA): the plan list lives between the "Featured Floor
// Plans" heading and the "View All Floor Plans" button. Each block is:
//   Available | Not Available   <- status (line BEFORE the name)
//   5-45 G                      <- name (line BEFORE the layout line)
//   Studio | 1 Bath | 428 sq. ft.
//   1 Available Units           <- (available only)
//   $3,786+/month               <- (available only)
const HW_START_RE = /featured floor plans/i;
const HW_END_RES = [
  /view all floor plans/i,
  /welcome to our neighborhood/i,
  /all layouts, square footage/i,
];
const HW_PRICE_RE = /\$[\d,.\-]+\+?\s*\/\s*month/i;
const HW_UNITS_RE = /(\d+)\s+Available Units/i;

function parseHeatherwood(lines) {
  const start = lines.findIndex((l) => HW_START_RE.test(l));
  if (start === -1) return null; // anchor missing -> signal a bad scrape

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (HW_END_RES.some((re) => re.test(lines[i]))) {
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

    const window = section.slice(i + 1, i + 5).join("\n");
    const unitsMatch = window.match(HW_UNITS_RE);
    const priceMatch = window.match(HW_PRICE_RE);

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

// SecureCafe (RentCafe/Yardi leasing portal): plans render after an
// "Apartment #" label, up to the "BEDROOMS" filter / page copy. Each block is:
//   Studio |428 sq.ft.        <- layout (matches SPECS_RE)
//   5-45 G                    <- name (line AFTER the layout)
//   Starting at $3,786.04 /   <- price (available only)
//   Inquire for details
//   View Details              <- available CTA ("Contact" when unavailable)
// The portal does not expose unit counts in the listing, so units is null.
const SC_PRICE_RE = /Starting at\s*\$([\d,]+(?:\.\d+)?)/i;

function parseSecureCafe(lines) {
  const start = lines.findIndex((l) => /^Apartment #$/i.test(l));
  const s = start === -1 ? 0 : start + 1;
  let end = lines.length;
  for (let i = s; i < lines.length; i++) {
    if (/^BEDROOMS$/i.test(lines[i]) || /Apartments in Long Island City/i.test(lines[i])) {
      end = i;
      break;
    }
  }
  const section = lines.slice(s, end);

  const plans = {};
  for (let i = 0; i < section.length; i++) {
    if (!SPECS_RE.test(section[i])) continue;
    const layout = section[i];
    const name = section[i + 1];
    if (!name) continue;
    // Bound the look-ahead to this plan's own block (stop at the next plan's
    // layout line) so a short/unavailable block can't absorb the next plan's
    // price or CTA.
    let wEnd = section.length;
    for (let k = i + 2; k < section.length; k++) {
      if (SPECS_RE.test(section[k])) { wEnd = k; break; }
    }
    const window = section.slice(i + 2, wEnd).join("\n");
    const priceMatch = window.match(SC_PRICE_RE);
    const available = /View Details/i.test(window) || !!priceMatch;

    plans[name] = {
      name,
      layout: layout.replace(/\s*\|\s*/g, " | ").trim(),
      available,
      units: null, // not exposed in the SecureCafe listing
      price: priceMatch ? "$" + priceMatch[1] : null,
    };
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Targets. A target with no URL configured is skipped.
// ---------------------------------------------------------------------------

const TARGETS = [
  {
    key: "heatherwood",
    name: process.env.MONITOR_NAME || "Heatherwood (marketing site)",
    url: process.env.TARGET_URL,
    ready: /featured floor plans/i,
    parse: parseHeatherwood,
    snapshot: "snapshots/heatherwood.json",
  },
  {
    key: "securecafe",
    name: "SecureCafe (leasing portal)",
    url: process.env.TARGET_URL_SECURECAFE,
    ready: /sq\.?\s*ft/i,
    parse: parseSecureCafe,
    snapshot: "snapshots/securecafe.json",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now() {
  return new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

async function scrapeLines(browser, url, readyRe) {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
    if (readyRe) {
      await page
        .waitForFunction(
          (src) => new RegExp(src, "i").test(document.body.innerText),
          readyRe.source,
          { timeout: 30_000 }
        )
        .catch(() => {});
    }
    await page.waitForTimeout(4000);
    const fullText = await page.evaluate(() => document.body.innerText);
    return fullText.split("\n").map((l) => l.replace(/\s+/g, " ").trim());
  } finally {
    await page.close();
  }
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
          (p.available
            ? ` · ${p.units != null ? p.units + " available · " : ""}${p.price ?? "price n/a"}`
            : " · Not available")
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
          ? `✅ **${name}** is now AVAILABLE (${n.layout})` +
              `${n.units != null ? ` · ${n.units} unit(s)` : ""} · ${n.price ?? "price n/a"}`
          : `⛔ **${name}** is no longer available`
      );
    else if (
      n.available &&
      typeof o.units === "number" &&
      typeof n.units === "number" &&
      o.units !== n.units
    )
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

function appendHistory(sourceName, changes) {
  appendFileSync(
    HISTORY_FILE,
    `\n## ${now()} — ${sourceName}\n\n${changes.map((c) => `- ${c}`).join("\n")}\n`
  );
}

// Run one target end-to-end. Returns true on success, false on a bad scrape.
async function checkTarget(browser, t) {
  console.log(`\n=== ${t.name} (${t.key}) ===`);
  const lines = await scrapeLines(browser, t.url, t.ready);
  const current = t.parse(lines);

  if (!current || Object.keys(current).length === 0) {
    console.error(`[${t.key}] Parsed 0 floor plans — bad scrape, NOT updating snapshot.`);
    return false; // don't wipe the baseline or false-alert
  }
  console.log(`[${t.key}] Parsed ${Object.keys(current).length} floor plans.`);

  if (!existsSync(t.snapshot)) {
    writeFileSync(t.snapshot, JSON.stringify(current, null, 2) + "\n");
    console.log(`[${t.key}] First run — baseline saved, no change alert.`);
    await sendDiscord(
      `✅ **${t.name}** monitor is live — tracking ${Object.keys(current).length} floor plans.\n${t.url}`
    );
    return true;
  }

  const previous = JSON.parse(readFileSync(t.snapshot, "utf8"));
  const changes = diffPlans(previous, current);

  if (changes.length === 0) {
    console.log(`[${t.key}] No change.`);
    return true;
  }

  console.log(`[${t.key}] Change detected:\n${changes.join("\n")}`);
  await sendDiscord(
    `🏢 **${t.name} floor plans changed** (${now()})\n${t.url}\n\n` +
      changes.map((c) => `• ${c}`).join("\n")
  );
  appendHistory(t.name, changes);
  writeFileSync(t.snapshot, JSON.stringify(current, null, 2) + "\n");
  return true;
}

async function main() {
  const active = TARGETS.filter((t) => t.url);
  if (active.length === 0) {
    console.error("No targets configured. Set TARGET_URL and/or TARGET_URL_SECURECAFE.");
    process.exit(1);
  }

  const browser = await chromium.launch();
  let hadError = false;
  try {
    for (const t of active) {
      try {
        const ok = await checkTarget(browser, t);
        if (!ok) hadError = true;
      } catch (err) {
        hadError = true;
        console.error(`[${t.key}] check failed:`, err.message);
      }
    }
  } finally {
    await browser.close();
  }

  // Fail loudly if any target scraped badly, but only after trying them all so
  // one broken source never blocks the other.
  if (hadError) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
