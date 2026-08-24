const crypto = require('crypto');
const { redis, isAvailable } = require('../redis/client');
const config = require('../config/index');

function isCacheable(body) {
  const temp = body.temperature;
  return temp === undefined || temp === 0;
}

function buildKey(body) {
  const material = JSON.stringify({
    model: body.model,
    messages: body.messages,
    max_tokens: body.max_tokens ?? null,
  });

  const hash = crypto.createHash('sha256').update(material).digest('hex');
  return `cache:${hash}`;
}

async function get(key) {
  if (!isAvailable()) return null;

  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn('Cache read failed:', err.message);
    return null;
  }
}

async function set(key, value) {
  if (!isAvailable()) return;

  try {
    await redis.setex(key, config.redis.cacheTtlSeconds, JSON.stringify(value));
  } catch (err) {
    console.warn('Cache write failed:', err.message);
  }
}

module.exports = { isCacheable, buildKey, get, set };