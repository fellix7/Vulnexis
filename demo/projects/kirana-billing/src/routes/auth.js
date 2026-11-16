// DEMO ONLY: deliberately vulnerable code for testing Vulnera.
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

const PUBLIC_KEY = process.env.JWT_PUBLIC_KEY || 'demo-key';

// No `algorithms` option: jsonwebtoken 8.5.1 accepts insecure defaults (CVE-2022-23540).
router.get('/me', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = jwt.verify(token, PUBLIC_KEY);
  res.json({ owner: user.name });
});

module.exports = router;
