const VirtualKey = require('../models/virtualKey.model');
const { hashKey } = require('../utils/keys');
const { decrypt } = require('../utils/crypto');

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';

  // 'Bearer' without the trailing space would also match 'Bearertoken'.
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const key = header.slice(7).trim();

  if (!key) {
    return res.status(401).json({ error: 'Missing API key' });
  }

  try {
    const record = await VirtualKey.findOne({ keyHash: hashKey(key) });

    if (!record) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // Revoked is permanent (don't retry); suspended is temporary (retry later).
    // Different status codes so the client knows which.
    if (record.status === 'revoked') {
      return res.status(401).json({ error: 'API key has been revoked' });
    }

    if (record.status === 'suspended') {
      return res.status(429).json({ error: 'API key is suspended' });
    }

    // Bring-your-own-key: if this virtual key carries its own provider
    // credential, decrypt it for the controller. Absent it, the controller
    // falls back to the gateway's shared key.
    if (record.providerApiKeyEncrypted) {
      try {
        req.providerApiKey = decrypt(record.providerApiKeyEncrypted);
      } catch (err) {
        console.error('Provider key decryption failed:', err.message);
        return res.status(500).json({
          error: 'Stored provider credential could not be read',
        });
      }
    }

    req.virtualKey = record;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { authenticate };