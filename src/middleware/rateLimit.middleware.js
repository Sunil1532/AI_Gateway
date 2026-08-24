const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redis, isAvailable } = require('../redis/client');

const script = fs.readFileSync(path.join(__dirname, '../redis/rateLimit.lua'), 'utf8');

redis.defineCommand('slidingWindow', { numberOfKeys: 1, lua: script });

const WINDOW_MS = 60_000;

async function rateLimit(req, res, next) {
  if (!isAvailable()) return next();

  const key = `ratelimit:${req.virtualKey._id}`;
  const limit = req.virtualKey.requestsPerMinute || 60;
  const now = Date.now();
  const member = `${now}-${crypto.randomBytes(4).toString('hex')}`;

  try {
    const [allowed, count] = await redis.slidingWindow(
      key, now, WINDOW_MS, limit, member
    );

    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(limit - count, 0));

    if (!allowed) {
      res.setHeader('Retry-After', Math.ceil(WINDOW_MS / 1000));
      return res.status(429).json({
        error: 'Rate limit exceeded',
        limit,
        windowSeconds: WINDOW_MS / 1000,
      });
    }

    next();
  } catch (err) {
    console.warn('Rate limit check failed, allowing request:', err.message);
    next();
  }
}

module.exports = { rateLimit };