// Run: npx tsx server/src/__checks__/scanStats.check.ts
import assert from 'node:assert/strict';
import { refundableAfterFailure, runWithStats, stats } from '../scanStats.js';

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

// A5: once Gemini has been called, a timeout or 5xx does not give the scan back.
assert.equal(refundableAfterFailure(undefined), true, 'no counters: refund');
const c = await runWithStats(async () => {
  assert.equal(stats().geminiCalls, 0, 'a new scan starts with no Gemini calls');
  assert.equal(refundableAfterFailure(stats()), true, 'failed before any AI call: refunded');
  stats().geminiCalls++;
  return { ...stats() };
});
assert.equal(c.geminiCalls, 1);
assert.equal(refundableAfterFailure(c), false, 'after a Gemini call: not refunded');
assert.equal(refundableAfterFailure({ geminiCalls: 0 }), true);
console.log('ok  refund decision: not after a Gemini call');
console.log('ALL SCANSTATS CHECKS PASSED');
