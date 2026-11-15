// Run: npx tsx server/src/pipeline/__checks__/hardening.check.ts   (offline)
import assert from 'node:assert/strict';
import { retryDelay } from '../../http.js';
import { parseKev } from '../enrich.js';
import { isValidNpmName, queryVersions } from '../osv.js';
import { planUpgrades } from '../plan.js';
import { runWithStats } from '../../scanStats.js';
import type { Advisory, Package } from '../../types.js';

// npm names
for (const ok of ['lodash', '@types/node', 'a.b', 'JSONStream', 'x'.repeat(214), '@scope/pkg-name_1', 'socket.io']) assert.ok(isValidNpmName(ok), ok);
for (const bad of ['', ' lodash', '.hidden', '_private', '@scope', '@/x', '@a/b/c', 'a b', 'a/b', 'x'.repeat(215), 'pkg\n', '../etc', 'a@1', '@scope/', 'a?b', 'a#b']) assert.ok(!isValidNpmName(bad), JSON.stringify(bad));
console.log('ok  npm name grammar');

// Invalid names are skipped (never queried) and counted. OFFLINE with only invalid names must not touch any snapshot or network.
{
  process.env.OFFLINE = '1';
  const counts = await runWithStats(async (s) => {
    const out = await queryVersions([{ name: '../../etc', version: '1.0.0' }, { name: 'Has Space', version: '1.0.0' }]);
    assert.deepEqual(out, [[], []]);
    return s;
  });
  assert.equal(counts.invalidPackages, 2);
  delete process.env.OFFLINE;
  console.log('ok  invalid names skipped and counted');
}

// Retry delay: Retry-After honoured, capped at 10 s, jittered backoff otherwise.
assert.equal(retryDelay(0, '3'), 3000);
assert.equal(retryDelay(0, '120'), 10_000);
assert.equal(retryDelay(1, null, () => 0.5), 1000);
assert.ok(retryDelay(0, 'garbage', () => 0) >= 250);
assert.ok(retryDelay(0, new Date(Date.now() + 2000).toUTCString()) <= 2000);
console.log('ok  retry delay');

// KEV catalog validation.
{
  const vulnerabilities = Array.from({ length: 120 }, (_v, i) => ({ cveID: `CVE-2024-${String(1000 + i)}` }));
  const good = parseKev(JSON.stringify({ catalogVersion: '2026.10.23', dateReleased: '2026-10-23T19:30:18Z', vulnerabilities }));
  assert.equal(good?.set.size, 120);
  assert.equal(good?.date, '2026-10-23');
  assert.equal(parseKev(JSON.stringify({ catalogVersion: '2026.10.23', vulnerabilities }))?.date, '2026-10-23');
  assert.equal(parseKev('<html>blocked by proxy</html>'), null);
  assert.equal(parseKev(JSON.stringify({ vulnerabilities: [] })), null);
  assert.equal(parseKev(JSON.stringify({ vulnerabilities: [...vulnerabilities, { cveID: 5 }] })), null);
  console.log('ok  KEV validation');
}

// Malicious packages: uninstall, no upgrade target, no network needed.
{
  const pkg: Package = { name: 'evil-pkg', version: '1.0.0', direct: false, dev: true, path: ['parent', 'evil-pkg'] };
  const adv: Advisory = { id: 'MAL-2025-1', aliases: [], summary: '', details: '', severity: 'UNKNOWN', fixedVersions: ['2.0.0'], references: [] };
  const [plan] = await planUpgrades([{ pkg, advisory: adv }]);
  assert.equal(plan!.to, null);
  assert.equal(plan!.jump, null);
  assert.equal(plan!.command, 'npm uninstall evil-pkg');
  console.log('ok  malicious plan');
}
console.log('ALL HARDENING CHECKS PASSED');
