const Redis = require('ioredis');
const config = require('../config/index');

let available = false;

const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 5000),
});

redis.on('ready', () => {
  available = true;
  console.log('Redis connected');
});

redis.on('error', (err) => {
  if (available) console.warn('Redis error:', err.message);
  available = false;
});

redis.on('end', () => {
  available = false;
});

function isAvailable() {
  return available;
}

module.exports = { redis, isAvailable };