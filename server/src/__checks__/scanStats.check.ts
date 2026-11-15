// Run: npx tsx server/src/__checks__/scanStats.check.ts
import assert from 'node:assert/strict';
import { runWithStats, stats } from '../scanStats.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Two interleaved scans, each doing awaited increments, see only their own counts.
const scan = (n: number, delay: number) =>
  runWithStats(async () => {
    for (let i = 0; i < n; i++) {
      await tick(delay);
      stats().unverifiedByNetwork++;
      await Promise.resolve();
      stats().invalidPackages += 2;
    }
    await tick(delay);
    return { ...stats() };
  });

const [a, b] = await Promise.all([scan(3, 3), scan(5, 2)]);
assert.equal(a.unverifiedByNetwork, 3);
assert.equal(a.invalidPackages, 6);
assert.equal(b.unverifiedByNetwork, 5);
assert.equal(b.invalidPackages, 10);
console.log('ok  interleaved scans keep separate counts');
console.log('ALL SCANSTATS CHECKS PASSED');
