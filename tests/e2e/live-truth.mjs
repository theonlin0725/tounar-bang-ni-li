import fs from 'node:fs';

// Versions are explicit: current lists were independently re-sampled when their
// frozen 2026-10-25 contents changed. Never rewrite truth during a test run.
export function loadLiveTruth(site) {
  const date = ['netease','meituan','shixiseng','greenhouse','smartrecruiters'].includes(site) ? '20261026' : '20261025';
  return JSON.parse(fs.readFileSync(new URL(`../fixtures/live/${site}-${date}.json`,import.meta.url)));
}
