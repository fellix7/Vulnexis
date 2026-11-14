// DEMO ONLY: deliberately vulnerable code for testing Vulnexis.
const express = require('express');
const axios = require('axios');
const router = express.Router();

// Fetch a supplier's price list from a URL the user typed (server-side request forgery class).
router.get('/prices', async (req, res) => {
  const { data } = await axios.get(req.query.url);
  res.json(data);
});

module.exports = router;
