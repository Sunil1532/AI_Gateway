const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/user.model');
const VirtualKey = require('../models/virtualKey.model');
const UsageLog = require('../models/usageLog.model');
const { generateKey, hashKey } = require('../utils/keys');
const { encrypt } = require('../utils/crypto');

const router = express.Router();

/**
 * POST /admin/keys
 *
 * Onboards a customer. Creates (or reuses) a User, generates a virtual key,
 * and optionally stores the customer's own provider credential encrypted so
 * their requests bill their Gemini account instead of the gateway's.
 *
 * The plaintext virtual key is returned exactly once — only its SHA-256 hash
 * is stored, so it genuinely cannot be recovered afterwards.
 */
router.post('/keys', async (req, res, next) => {
  try {
    const {
      name,
      email,
      keyName,
      budgetUsd,
      period = 'monthly',
      requestsPerMinute = 60,
      providerApiKey,
    } = req.body;

    if (!email || !keyName || budgetUsd === undefined) {
      return res.status(400).json({
        error: 'email, keyName and budgetUsd are required',
      });
    }

    const budgetMicros = Math.round(Number(budgetUsd) * 1_000_000);
    if (!Number.isFinite(budgetMicros) || budgetMicros <= 0) {
      return res.status(400).json({ error: 'budgetUsd must be a positive number' });
    }

    // Upsert the user so onboarding a second key for an existing customer
    // does not trip the unique email index.
    const user = await User.findOneAndUpdate(
      { email: email.toLowerCase() },
      { $setOnInsert: { name: name || email, email: email.toLowerCase(), role: 'member' } },
      { new: true, upsert: true }
    );

    const key = generateKey();

    const doc = {
      userId: user._id,
      name: keyName,
      keyHash: hashKey(key),
      keyPrefix: key.slice(0, 12),
      budgetLimitMicros: budgetMicros,
      period,
      periodStart: new Date(),
      requestsPerMinute: Number(requestsPerMinute),
      status: 'active',
    };

    // Bring-your-own-key is optional. Without it the customer's requests use
    // the gateway's shared provider credential.
    if (providerApiKey) {
      doc.providerApiKeyEncrypted = encrypt(providerApiKey);
      doc.providerKeyLabel = `${providerApiKey.slice(0, 6)}…${providerApiKey.slice(-4)}`;
    }

    const created = await VirtualKey.create(doc);

    res.status(201).json({
      key,
      warning: 'Store this now. It cannot be retrieved again.',
      keyId: created._id,
      keyPrefix: created.keyPrefix,
      user: { id: user._id, email: user.email },
      budgetUsd: budgetMicros / 1_000_000,
      period,
      requestsPerMinute: doc.requestsPerMinute,
      billsToOwnProviderAccount: Boolean(providerApiKey),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/keys
 * Lists keys with budget utilisation. Never returns key material.
 */
router.get('/keys', async (req, res, next) => {
  try {
    const keys = await VirtualKey.find()
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    res.json(
      keys.map((k) => ({
        id: k._id,
        name: k.name,
        prefix: k.keyPrefix,
        owner: k.userId?.email || null,
        status: k.status,
        period: k.period,
        periodStart: k.periodStart,
        requestsPerMinute: k.requestsPerMinute,
        budgetUsd: k.budgetLimitMicros / 1_000_000,
        spentUsd: (k.spentMicros || 0) / 1_000_000,
        utilisation: k.budgetLimitMicros
          ? `${(((k.spentMicros || 0) / k.budgetLimitMicros) * 100).toFixed(1)}%`
          : null,
        tokensUsed: k.tokensUsed || 0,
        lastUsedAt: k.lastUsedAt || null,
        providerKey: k.providerKeyLabel || 'gateway shared key',
      }))
    );
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /admin/keys/:id
 * Adjust budget, rate limit, or status. Provider credential can be rotated
 * here too — the customer sends a new one, the old ciphertext is replaced.
 */
router.patch('/keys/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid key id' });
    }

    const update = {};
    const { budgetUsd, requestsPerMinute, status, providerApiKey } = req.body;

    if (budgetUsd !== undefined) {
      update.budgetLimitMicros = Math.round(Number(budgetUsd) * 1_000_000);
    }
    if (requestsPerMinute !== undefined) {
      update.requestsPerMinute = Number(requestsPerMinute);
    }
    if (status !== undefined) {
      if (!['active', 'revoked', 'suspended'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      update.status = status;
    }
    if (providerApiKey) {
      update.providerApiKeyEncrypted = encrypt(providerApiKey);
      update.providerKeyLabel = `${providerApiKey.slice(0, 6)}…${providerApiKey.slice(-4)}`;
    }

    if (!Object.keys(update).length) {
      return res.status(400).json({ error: 'No updatable fields supplied' });
    }

    const key = await VirtualKey.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!key) return res.status(404).json({ error: 'Key not found' });

    res.json({ id: key._id, name: key.name, status: key.status, updated: Object.keys(update) });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /admin/keys/:id
 * Soft revoke. Usage logs reference this key, so it is never hard-deleted —
 * doing so would orphan the billing history.
 */
router.delete('/keys/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid key id' });
    }

    const key = await VirtualKey.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'revoked' } },
      { new: true }
    );

    if (!key) return res.status(404).json({ error: 'Key not found' });

    res.json({ id: key._id, name: key.name, status: key.status });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/stats
 * Aggregate spend, savings and cache performance. Optional keyId and date
 * filters; without them this scans the whole collection, which is fine at
 * this scale and would need date bounds at production volume.
 */
router.get('/stats', async (req, res, next) => {
  try {
    const match = {};

    if (req.query.keyId && mongoose.isValidObjectId(req.query.keyId)) {
      match.virtualKeyId = new mongoose.Types.ObjectId(req.query.keyId);
    }
    if (req.query.from || req.query.to) {
      match.createdAt = {};
      if (req.query.from) match.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) match.createdAt.$lte = new Date(req.query.to);
    }

    const [stats] = await UsageLog.aggregate([
      ...(Object.keys(match).length ? [{ $match: match }] : []),
      {
        $group: {
          _id: null,
          requests: { $sum: 1 },
          hits: { $sum: { $cond: ['$cacheHit', 1, 0] } },
          downgrades: {
            $sum: { $cond: [{ $ne: ['$requestedModel', '$resolvedModel'] }, 1, 0] },
          },
          spentMicros: { $sum: '$costMicros' },
          baselineMicros: { $sum: '$baselineCostMicros' },
          totalTokens: { $sum: '$totalTokens' },
          avgLatencyMs: { $avg: '$latencyMs' },
        },
      },
    ]);

    if (!stats) return res.json({ requests: 0 });

    const saved = stats.baselineMicros - stats.spentMicros;

    res.json({
      requests: stats.requests,
      cacheHits: stats.hits,
      cacheHitRate: `${((stats.hits / stats.requests) * 100).toFixed(1)}%`,
      modelDowngrades: stats.downgrades,
      totalTokens: stats.totalTokens,
      spent: `$${(stats.spentMicros / 1_000_000).toFixed(6)}`,
      baseline: `$${(stats.baselineMicros / 1_000_000).toFixed(6)}`,
      saved: `$${(saved / 1_000_000).toFixed(6)}`,
      savedPercent: stats.baselineMicros
        ? `${((saved / stats.baselineMicros) * 100).toFixed(1)}%`
        : '0.0%',
      avgLatencyMs: Math.round(stats.avgLatencyMs || 0),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/timeseries?bucket=day
 * Daily (or hourly) buckets of actual vs baseline cost. This is what a spend
 * chart plots — the gap between the two lines is the gateway's value.
 */
router.get('/timeseries', async (req, res, next) => {
  try {
    const unit = req.query.bucket === 'hour' ? 'hour' : 'day';
    const match = {};

    if (req.query.keyId && mongoose.isValidObjectId(req.query.keyId)) {
      match.virtualKeyId = new mongoose.Types.ObjectId(req.query.keyId);
    }
    if (req.query.from) {
      match.createdAt = { $gte: new Date(req.query.from) };
    }

    const rows = await UsageLog.aggregate([
      ...(Object.keys(match).length ? [{ $match: match }] : []),
      {
        $group: {
          _id: { $dateTrunc: { date: '$createdAt', unit } },
          requests: { $sum: 1 },
          hits: { $sum: { $cond: ['$cacheHit', 1, 0] } },
          spentMicros: { $sum: '$costMicros' },
          baselineMicros: { $sum: '$baselineCostMicros' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json(
      rows.map((r) => ({
        bucket: r._id,
        requests: r.requests,
        cacheHits: r.hits,
        spentUsd: r.spentMicros / 1_000_000,
        baselineUsd: r.baselineMicros / 1_000_000,
        savedUsd: (r.baselineMicros - r.spentMicros) / 1_000_000,
      }))
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/requests
 * Paginated request log. Prompt content is deliberately not stored, so this
 * shows metadata only.
 */
router.get('/requests', async (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const match = {};
    if (req.query.keyId && mongoose.isValidObjectId(req.query.keyId)) {
      match.virtualKeyId = new mongoose.Types.ObjectId(req.query.keyId);
    }
    if (req.query.filter === 'cached') match.cacheHit = true;
    if (req.query.filter === 'routed') {
      match.$expr = { $ne: ['$requestedModel', '$resolvedModel'] };
    }

    const [rows, total] = await Promise.all([
      UsageLog.find(match).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      UsageLog.countDocuments(match),
    ]);

    res.json({
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      rows: rows.map((r) => ({
        at: r.createdAt,
        requestedModel: r.requestedModel,
        resolvedModel: r.resolvedModel,
        downgraded: r.requestedModel !== r.resolvedModel,
        cacheHit: r.cacheHit,
        totalTokens: r.totalTokens,
        costUsd: (r.costMicros || 0) / 1_000_000,
        baselineUsd: (r.baselineCostMicros || 0) / 1_000_000,
        latencyMs: r.latencyMs,
        streamCompleted: r.streamCompleted,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;