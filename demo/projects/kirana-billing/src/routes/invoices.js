// DEMO ONLY: deliberately vulnerable code for testing Vulnera.
const express = require('express');
const router = express.Router();

// GST invoice page, shared with customers by link. The whole query string is spread into the ejs options
// object: a request can set settings[view options][outputFunctionName] (CVE-2022-29078).
router.get('/:id', (req, res) => {
  res.render('invoice', { ...req.query, id: req.params.id, gstRate: 18 });
});

module.exports = router;
