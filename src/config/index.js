require('dotenv').config();

const config = {
  port: Number(process.env.PORT) || 3000,
  pricing: {
    'gemini-3.6-flash': { inputPerMillion: 750_000, outputPerMillion: 3_750_000 },
    'gemini-3.1-flash-lite': { inputPerMillion: 250_000, outputPerMillion: 1_500_000 },
  },
    security: {
    encryptionKey: process.env.ENCRYPTION_KEY,
  },
    admin: {
    secret: process.env.ADMIN_SECRET,
  },
    redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    cacheTtlSeconds: Number(process.env.CACHE_TTL) || 3600,
  },
  provider: {
    baseUrl: process.env.GEMINI_BASE_URL
      || 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: process.env.GEMINI_API_KEY,
    cheapModel: process.env.CHEAP_MODEL || 'gemini-3.1-flash-lite',
    defaultModel: process.env.DEFAULT_MODEL || 'gemini-3.6-flash',
  },
};

if (!config.provider.apiKey) {
  throw new Error('GEMINI_API_KEY is missing from .env');
  
}
module.exports = config;