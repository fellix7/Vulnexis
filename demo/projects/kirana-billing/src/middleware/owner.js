// DEMO ONLY: deliberately vulnerable code for testing Vulnera.
const jwt = require('jsonwebtoken');

// Lets the request through only with the shop owner's token.
module.exports = function requireOwner(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    req.owner = jwt.verify(token, process.env.JWT_PUBLIC_KEY || 'demo-key', { algorithms: ['RS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'owner login required' });
  }
};
