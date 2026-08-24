const config = require('../config/index');

async function callGemini(payload, signal, apiKey) {
  const key = apiKey || config.provider.apiKey;

  const body = {
    ...payload,
    stream: true,
    stream_options: { include_usage: true },
  };

  return fetch(`${config.provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal,
  });
}

module.exports = { callGemini };