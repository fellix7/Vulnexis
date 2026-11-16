// Run with: npx tsx server/src/pipeline/__checks__/plan.check.ts
// Offline: globalThis.fetch is replaced, so OSV and the npm registry are never contacted.
import assert from 'node:assert/strict';
import type { Advisory, Package } from '../../types.js';
import { allowedCommand, candidateFor, planUpgrades } from '../plan.js';

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
};

// Every probed version is reported clean.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/querybatch')) {
    const n = (JSON.parse(String(init?.body)) as { queries: unknown[] }).queries.length;
    return new Response(JSON.stringify({ results: Array.from({ length: n }, () => ({})) }), { status: 200 });
  }
  return new Response(JSON.stringify({ versions: {} }), { status: 200 });
}) as typeof fetch;

const pkg = (name: string, version: string, o: Partial<Package> = {}): Package => ({ name, version, direct: false, dev: false, path: ['parent-a'], ...o });
const adv = (id: string, fixedVersions: string[], extra: Partial<Advisory> = {}): Advisory =>
  ({ id, aliases: [], summary: '', details: '', severity: 'HIGH', fixedVersions, references: [], ...extra }) as Advisory;

await check('(a) two versions of one transitive package: one override, highest version', async () => {
  const plans = await planUpgrades([
    { pkg: pkg('foo-a', '1.0.0'), advisory: adv('A', ['1.2.0']) },
    { pkg: pkg('foo-a', '1.1.0', { path: ['parent-b'] }), advisory: adv('A', ['1.3.0']) },
  ]);
  const cmds = plans.map((p) => p.command).filter(Boolean);
  assert.deepEqual(cmds, ['npm pkg set overrides.foo-a=1.3.0']);
  assert.ok(plans.every((p) => p.to === '1.3.0'));
});

await check('(a) versions spanning majors: no override, parents must be upgraded', async () => {
  const plans = await planUpgrades([
    { pkg: pkg('foo-b', '1.0.0'), advisory: adv('B', ['1.2.0']) },
    { pkg: pkg('foo-b', '2.0.0', { path: ['parent-b'] }), advisory: adv('B', ['2.1.0']) },
  ]);
  assert.ok(plans.every((p) => p.command === null));
  assert.deepEqual(plans.map((p) => p.viaParent).sort(), ['parent-a', 'parent-b']);
  assert.ok(plans.every((p) => p.parentOnly === true), 'marked so the UI offers no override');
});

await check('(b) direct dependency: npm install, never an override (also for a transitive copy of it)', async () => {
  const plans = await planUpgrades([
    { pkg: pkg('foo-c', '1.0.0', { direct: true, path: ['foo-c'] }), advisory: adv('C', ['1.2.0']) },
    { pkg: pkg('foo-c', '1.1.0'), advisory: adv('C', ['1.2.0']) },
    { pkg: pkg('foo-d', '1.0.0', { direct: true, dev: true, path: ['foo-d'] }), advisory: adv('D', ['1.1.0']) },
  ]);
  const c = plans.find((p) => p.name === 'foo-c' && p.from === '1.0.0')!;
  assert.equal(c.command, 'npm install foo-c@1.2.0');
  assert.equal(plans.find((p) => p.name === 'foo-c' && p.from === '1.1.0')!.command, null);
  assert.equal(plans.find((p) => p.name === 'foo-d')!.command, 'npm install -D foo-d@1.1.0');
  assert.ok(plans.every((p) => !p.command?.includes('overrides')));
});

await check('(c) prerelease fixes are skipped unless the current version is a prerelease', () => {
  assert.equal(candidateFor('1.0.0', [adv('E', ['1.1.0-beta.1', '1.1.0'])]), '1.1.0');
  assert.equal(candidateFor('1.0.0', [adv('E', ['2.0.0-rc.1'])]), null);
  assert.equal(candidateFor('1.0.0-beta.1', [adv('E', ['1.0.0-beta.2'])]), '1.0.0-beta.2');
});

await check('(d) invalid installed version: plan with to null and no command, no throw', async () => {
  const plans = await planUpgrades([
    { pkg: pkg('foo-e', 'not-a-version', { direct: true, path: ['foo-e'] }), advisory: adv('F', ['1.0.0']) },
    { pkg: pkg('foo-e', 'also bad'), advisory: adv('F', ['1.0.0']) },
  ]);
  assert.equal(plans.length, 2);
  assert.ok(plans.every((p) => p.to === null && p.command === null && p.jump === null));
});

await check('malicious packages get npm uninstall', async () => {
  const plans = await planUpgrades([{ pkg: pkg('evil-pkg', '1.0.0', { direct: true, path: ['evil-pkg'] }), advisory: adv('MAL-2024-1', [], { id: 'MAL-2024-1' }) }]);
  assert.equal(plans[0]!.command, 'npm uninstall evil-pkg');
});

await check('allow-list: accepts the three shapes, rejects everything else', () => {
  for (const ok of ['npm install a@1.2.3', 'npm install -D @s/a-b@1.2.3-rc.1', 'npm pkg set overrides.a=1.2.3', 'npm uninstall @s/a']) assert.equal(allowedCommand(ok), ok);
  for (const bad of [
    'npm install a@1.2.3; rm -rf /',
    'npm install a@1.2.3 && curl x',
    'npm install $(id)@1.0.0',
    'npm install a@latest',
    'npm pkg set overrides.a=1.0.0 --x',
    'npm uninstall a b',
    'npm uninstall a;id',
    'Add to package.json: "overrides": { "socket.io": "1.0.0" }',
    'npm install a@1.0.0\nid',
    '',
  ]) assert.equal(allowedCommand(bad), null, bad);
  assert.equal(allowedCommand(null), null);
});

console.log(`\n${passed} plan checks passed`);
