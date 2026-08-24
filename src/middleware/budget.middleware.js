const VirtualKey = require('../models/virtualKey.model');

function periodExpired(key) {
  if (key.period === 'lifetime') return false;

  const start = new Date(key.periodStart);
  const now = new Date();

  if (key.period === 'daily') {
    return now - start >= 24 * 60 * 60 * 1000;
  }

  // monthly
  const next = new Date(start);
  next.setMonth(next.getMonth() + 1);
  return now >= next;
}

async function checkBudget(req, res, next) {
  const key = req.virtualKey;

  try {
    if (periodExpired(key)) {
      await VirtualKey.updateOne(
        { _id: key._id },
        { $set: { spentMicros: 0, tokensUsed: 0, periodStart: new Date() } }
      );
      key.spentMicros = 0;
      key.periodStart = new Date();
    }

    if (key.spentMicros >= key.budgetLimitMicros) {
      return res.status(429).json({
        error: 'Budget exceeded',
        spent: key.spentMicros / 1_000_000,
        limit: key.budgetLimitMicros / 1_000_000,
      });
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { checkBudget };