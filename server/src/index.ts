// Long-running server: check the configuration, apply migrations, listen, and stop cleanly.
// (On Vercel, api/index.mjs imports app.ts directly instead.)
import './env.js';
import './net.js';
import app from './app.js';
import { printDoctor, runDoctor } from './doctor.js';
import { assertStartupConfig, startupWarnings } from './startup.js';
import { accountsEnabled } from './auth/config.js';
import { closeDb, dbEnabled } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { startSweep } from './sweep.js';
import { loadKev } from './pipeline/enrich.js';
import { shutdownWorkers } from './workers/pool.js';

const PORT = Number(process.env.PORT ?? 8787);

try {
  assertStartupConfig();
} catch (e) {
  console.error(`[config] not starting: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
for (const w of startupWarnings()) console.warn(`[config] ${w}`);

if (dbEnabled() && process.env.MIGRATE_ON_START !== '0') {
  try {
    await migrate();
  } catch (e) {
    console.error(`[db] startup migration failed, not starting: ${e instanceof Error ? e.message : String(e)}`);
    console.error('[db] check DATABASE_URL, or set MIGRATE_ON_START=0 and run "npm run migrate -w server" yourself.');
    process.exit(1);
  }
}

const server = app.listen(PORT, () => {
  console.log(`Vulnera API listening on http://localhost:${PORT}${accountsEnabled() ? ' (accounts on)' : ''}`);
  runDoctor().then(printDoctor).catch(() => {});
  loadKev().catch(() => {}); // read (and, once a day, refresh) the CISA KEV catalog before the first scan
  startSweep();
});

// Clean stop for deploys and restarts: stop taking requests, stop the analysis workers, close the database, then exit.
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    const exit = () => process.exit(0);
    shutdownWorkers().then(() => closeDb()).then(exit, exit);
    setTimeout(exit, 5000).unref(); // open streams must not hold the process forever
  });
}
