// DEMO ONLY: deliberately vulnerable code for testing Vulnera.
// Nightly stock sync. Runs as its own container on the private backend network (see docker-compose.yml);
// it takes no requests and only calls the supplier URL from its own config.
const fetch = require('node-fetch');

const SUPPLIER_URL = process.env.SUPPLIER_URL || 'https://supplier.example.in/stock.json';

async function sync() {
  // node-fetch 2.6.0 keeps the Authorization header on cross-host redirects.
  const r = await fetch(SUPPLIER_URL, { headers: { Authorization: `Bearer ${process.env.SUPPLIER_TOKEN}` } });
  const stock = await r.json();
  console.log(`synced ${stock.length} items`);
}

sync();
