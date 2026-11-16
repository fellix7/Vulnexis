// Vercel entry: one function runs the whole Express app (API, sign-in and the web app's routes).
// Vercel serves client/dist from its CDN first; every other path is rewritten here (see vercel.json).
// `npm run build` compiles server/dist before Vercel packages this file.

// The function's file system is read-only except /tmp: keep the lookup cache there (it lives as long as the instance).
process.env.CACHE_DIR ||= '/tmp/vulnera-cache';

const { default: app } = await import('../server/dist/app.js');
const { assertStartupConfig, startupWarnings } = await import('../server/dist/startup.js');
const { dbEnabled } = await import('../server/dist/db/pool.js');

assertStartupConfig(); // same fail-closed checks as the long-running server
for (const w of startupWarnings()) console.warn(`[config] ${w}`);
if (dbEnabled() && process.env.MIGRATE_ON_START !== '0') {
  const { migrate } = await import('../server/dist/db/migrate.js');
  await migrate();
}

export default app;
