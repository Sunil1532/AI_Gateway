const { redis } = require('../redis/client');
const UsageLog = require('../models/usageLog.model');
const VirtualKey = require('../models/virtualKey.model');
const { STREAM } = require('./usageQueue');

const GROUP = 'usage-writers';
const CONSUMER = `worker-${process.pid}`;
const BATCH_SIZE = 50;
const BLOCK_MS = 5000;

async function ensureGroup() {
  try {
    await redis.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM');
  } catch (err) {
    if (!err.message.includes('BUSYGROUP')) throw err;
  }
}

async function processBatch(entries) {
  const records = entries.map(([, fields]) => JSON.parse(fields[1]));

  await UsageLog.insertMany(records, { ordered: false });

  const byKey = new Map();
  for (const r of records) {
    const existing = byKey.get(r.virtualKeyId) || { cost: 0, tokens: 0 };
    existing.cost += r.costMicros || 0;
    existing.tokens += r.totalTokens || 0;
    byKey.set(r.virtualKeyId, existing);
  }

  const ops = [...byKey.entries()].map(([id, totals]) => ({
    updateOne: {
      filter: { _id: id },
      update: {
        $inc: { spentMicros: totals.cost, tokensUsed: totals.tokens },
        $set: { lastUsedAt: new Date() },
      },
    },
  }));

  if (ops.length) await VirtualKey.bulkWrite(ops);
}

async function run() {
  await ensureGroup();
  console.log('Usage worker started');

  while (true) {
    try {
      const result = await redis.xreadgroup(
        'GROUP', GROUP, CONSUMER,
        'COUNT', BATCH_SIZE,
        'BLOCK', BLOCK_MS,
        'STREAMS', STREAM, '>'
      );

      if (!result) continue;

      const [[, entries]] = result;
      if (!entries.length) continue;

      await processBatch(entries);
      await redis.xack(STREAM, GROUP, ...entries.map(([id]) => id));
    } catch (err) {
      console.error('Worker batch failed:', err.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

module.exports = { run };