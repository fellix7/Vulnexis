// DEMO ONLY: deliberately vulnerable code for testing Vulnexis.
const express = require('express');
const axios = require('axios');
const fetch = require('node-fetch');
const router = express.Router();

// Fetch a supplier's price list from a URL the user typed (server-side request forgery class).
router.get('/prices', async (req, res) => {
  const { data } = await axios.get(req.query.url);
  res.json(data);
});

// Forward the shop's API token to a supplier URL; node-fetch 2.6.0 keeps headers on redirects.
router.get('/stock', async (req, res) => {
  const r = await fetch(req.query.url, { headers: { Authorization: `Bearer ${process.env.SUPPLIER_TOKEN}` } });
  res.json(await r.json());
});

module.exports = router;
