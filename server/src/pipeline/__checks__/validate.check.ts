// Run: npx tsx server/src/pipeline/__checks__/validate.check.ts
import assert from 'node:assert/strict';
import { ValidationError, validateScanRequest as v } from '../../validate.js';

const lock = { lockfileVersion: 3, packages: { '': {} } };
const status = (body: unknown) => {
  try {
    v(body);
  } catch (e) {
    assert.ok(e instanceof ValidationError, 'throws ValidationError');
    return e.status;
  }
  return 200;
};
const src = (n: number) => ({ path: 'a.js', content: 'x'.repeat(n) });

// shape
for (const b of [null, undefined, 5, 'x', [], [1]]) assert.equal(status(b), 400, `body ${JSON.stringify(b)}`);
assert.equal(status({}), 400, 'no mode');
assert.equal(status({ sample: false }), 400);
assert.equal(status({ sample: 'yes' }), 400);
assert.equal(status({ sample: true, repoUrl: 'a/b' }), 400, 'two modes');
assert.equal(status({ lockfile: lock, repoUrl: 'a/b' }), 400);
assert.equal(status({ sample: true, lockfile: lock }), 400);

// modes
assert.deepEqual(v({ sample: true, extra: 1 }), { sample: true }, 'unknown keys ignored');
assert.deepEqual(v({ repoUrl: 'a/b' }), { repoUrl: 'a/b' });
assert.equal(status({ repoUrl: '' }), 400);
assert.equal(status({ repoUrl: 5 }), 400);
assert.equal(status({ repoUrl: 'a'.repeat(300) }), 200);
assert.equal(status({ repoUrl: 'a'.repeat(301) }), 413);
assert.equal(status({ lockfile: [] }), 400);
assert.equal(status({ lockfile: 'x' }), 400);
assert.equal(status({ lockfile: { packages: [] } }), 400);
assert.equal(status({ lockfile: { packages: 'x' } }), 400);
assert.equal(status({ lockfile: { lockfileVersion: 1 } }), 200, 'v1 lockfile reaches the parser for its friendly message');

// lockfile limits
const pk = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`node_modules/p${i}`, {}]));
assert.equal(status({ lockfile: { packages: pk(20_000) } }), 200);
assert.equal(status({ lockfile: { packages: pk(20_001) } }), 413);
assert.equal(status({ lockfile: { packages: { ['k'.repeat(1000)]: {} } } }), 200);
assert.equal(status({ lockfile: { packages: { ['k'.repeat(1001)]: {} } } }), 413);

// sources
assert.equal(status({ sample: true, sources: 'x' }), 400);
assert.equal(status({ sample: true, sources: [null] }), 400);
assert.equal(status({ sample: true, sources: [{ path: 'a.js' }] }), 400);
assert.equal(status({ sample: true, sources: [{ path: '', content: '' }] }), 400);
assert.equal(status({ sample: true, sources: [{ path: 'a'.repeat(497) + '.js', content: '' }] }), 200);
assert.equal(status({ sample: true, sources: [{ path: 'a'.repeat(498) + '.js', content: '' }] }), 413);
assert.equal(status({ sample: true, sources: [{ path: 'a\0.js', content: '' }] }), 400);
for (const ext of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']) assert.equal(status({ sample: true, sources: [{ path: `a.${ext}`, content: '' }] }), 200, ext);
for (const p of ['a.py', 'a.json', 'a', 'a.js.txt', 'a.vue']) assert.equal(status({ sample: true, sources: [{ path: p, content: '' }] }), 400, p);
assert.equal(status({ sample: true, sources: Array.from({ length: 300 }, () => src(1)) }), 200);
assert.equal(status({ sample: true, sources: Array.from({ length: 301 }, () => src(1)) }), 413);
assert.equal(status({ sample: true, sources: [src(200_000)] }), 200);
assert.equal(status({ sample: true, sources: [src(200_001)] }), 413);
assert.equal(status({ sample: true, sources: Array.from({ length: 16 }, () => src(200_000)) }), 413, '3.2 MB total');
assert.equal(status({ sample: true, sources: Array.from({ length: 15 }, () => src(200_000)) }), 200, '3.0 MB total');

// contextFiles
const ctx = (n: number, p = 'docker-compose.yml') => ({ path: p, content: 'x'.repeat(n) });
assert.equal(status({ sample: true, contextFiles: [ctx(1, 'README.md'), ctx(1, 'Dockerfile')] }), 200, 'any extension');
assert.equal(status({ sample: true, contextFiles: 'x' }), 400);
assert.equal(status({ sample: true, contextFiles: [{ path: 'a' }] }), 400);
assert.equal(status({ sample: true, contextFiles: [{ path: '', content: '' }] }), 400);
assert.equal(status({ sample: true, contextFiles: [{ path: 'a'.repeat(501), content: '' }] }), 413);
assert.equal(status({ sample: true, contextFiles: [{ path: 'a\0', content: '' }] }), 400);
assert.equal(status({ sample: true, contextFiles: Array.from({ length: 60 }, () => ctx(1)) }), 200);
assert.equal(status({ sample: true, contextFiles: Array.from({ length: 61 }, () => ctx(1)) }), 413);
assert.equal(status({ sample: true, contextFiles: [ctx(256 * 1024)] }), 200);
assert.equal(status({ sample: true, contextFiles: [ctx(256 * 1024 + 1)] }), 413);
assert.equal(status({ sample: true, contextFiles: Array.from({ length: 7 }, () => ctx(256 * 1024)) }), 413, '1.75 MB total');
assert.equal(status({ sample: true, contextFiles: Array.from({ length: 6 }, () => ctx(256 * 1024)) }), 200, '1.5 MB total');

// sourcesTruncated, normalisation, no mutation
assert.equal(status({ sample: true, sourcesTruncated: 'yes' }), 400);
const input = { repoUrl: 'a/b', sourcesTruncated: true, sources: [{ path: 'a.js', content: 'x', evil: 1 }], contextFiles: [{ path: 'Dockerfile', content: 'y' }], junk: 1 };
const snapshot = JSON.stringify(input);
const out = v(input);
assert.deepEqual(out, { repoUrl: 'a/b', sourcesTruncated: true, sources: [{ path: 'a.js', content: 'x' }], contextFiles: [{ path: 'Dockerfile', content: 'y' }] });
assert.notEqual(out.sources, input.sources);
assert.equal(JSON.stringify(input), snapshot, 'input not mutated');

// errors are plain
try { v({ lockfile: { packages: pk(20_001) } }); } catch (e) { assert.match((e as Error).message, /^[A-Z][^{}\n]{5,120}\.$/); }

console.log('validate.check: ok');
