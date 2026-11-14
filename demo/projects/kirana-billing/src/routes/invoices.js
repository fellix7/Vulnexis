// DEMO ONLY: deliberately vulnerable code for testing Vulnexis.
const express = require('express');
const _ = require('lodash');
const router = express.Router();

// GST invoice page. The whole query string is spread into the ejs options object:
// a request can set settings[view options][outputFunctionName] (CVE-2022-29078).
router.get('/:id', (req, res) => {
  res.render('invoice', { ...req.query, id: req.params.id, gstRate: 18 });
});

// Custom receipt footer typed by the shop owner, compiled as a lodash template (CVE-2021-23337).
router.post('/footer', (req, res) => {
  const compiled = _.template(req.body.footerTemplate);
  res.send(compiled({ shop: 'Sharma Kirana Store', upi: 'sharma@upi' }));
});

// Merge user-supplied settings into defaults (prototype pollution class).
router.post('/settings', (req, res) => {
  const settings = _.merge({}, { currency: 'INR', gst: true }, req.body);
  res.json(settings);
});

module.exports = router;
