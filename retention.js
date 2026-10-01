'use strict';

const repo = require('./repo');
const dates = require('./dates');
const storage = require('./storage');

let lastPurgedMonth = null;
let inFlight = null;

/**
 * Channel retention: keep only the current month's posts, images and roster edits.
 * Idempotent, so it is safe to run opportunistically on each cold start / month rollover
 * (serverless has no long-lived timers).
 */
async function ensureCurrentMonth() {
  const keep = dates.currentMonth();
  if (lastPurgedMonth === keep) return;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const { removed, images } = await repo.purge(keep);
    await storage.deleteImages(images);
    lastPurgedMonth = keep;
    if (removed) {
      console.log(`[retention] cleared ${removed} snapshot(s) from previous months; channel reset for ${keep}`);
    }
  })()
    .catch((err) => console.error('[retention] failed:', err.message))
    .finally(() => { inFlight = null; });

  return inFlight;
}

module.exports = { ensureCurrentMonth };
