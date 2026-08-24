const { redis, isAvailable } = require('../redis/client');
const UsageLog = require('../models/usageLog.model');
const VirtualKey = require('../models/virtualKey.model');

const STREAM = 'usage:stream';

async function enqueue(record) {
  if (!isAvailable()) {
    return writeDirect(record);
  }

  try {
    await redis.xadd(STREAM, '*', 'data', JSON.stringify(record));
  } catch (err) {
    console.warn('Enqueue failed, writing directly:', err.message);
    await writeDirect(record);
  }
}

async function writeDirect(record) {
  try {
    await UsageLog.create(record);
    await VirtualKey.updateOne(
      { _id: record.virtualKeyId },
      {
        $inc: { spentMicros: record.costMicros, tokensUsed: record.totalTokens },
        $set: { lastUsedAt: new Date() },
      }
    );
  } catch (err) {
    console.error('Direct usage write failed:', err.message);
  }
}

module.exports = { enqueue, STREAM };