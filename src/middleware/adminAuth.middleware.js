const crypto = require('crypto');
const config = require('../config/index');

function adminAuth(req, res, next) {
  const secret = config.admin.secret;

  if (!secret) {
    return res.status(500).json({ error: 'ADMIN_SECRET is not configured' });
  }

  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!provided) {
    return res.status(401).json({ error: 'Missing admin credentials' });
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(secret);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid admin credentials' });
  }

  next();
}

module.exports = { adminAuth };