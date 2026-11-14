// DEMO ONLY: deliberately vulnerable code for testing Vulnexis.
// Owner-only pages. server.js mounts this router behind requireOwner, so only a logged-in owner reaches it.
const express = require('express');
const _ = require('lodash');
const router = express.Router();

// Custom receipt footer typed by the shop owner, compiled as a lodash template (CVE-2021-23337).
router.post('/footer', (req, res) => {
  const compiled = _.template(req.body.footerTemplate);
  res.send(compiled({ shop: 'Sharma Kirana Store', upi: 'sharma@upi' }));
});

// Merge the owner's settings into defaults (prototype pollution class).
router.post('/settings', (req, res) => {
  const settings = _.merge({}, { currency: 'INR', gst: true }, req.body);
  res.json(settings);
});

module.exports = router;
