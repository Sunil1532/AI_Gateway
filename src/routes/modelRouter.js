const config = require('../config/index');

const COMPLEX_PATTERNS = /\b(analyz|prove|explain why|design|architect|debug|derive|compare|evaluate|reason|step by step)/i;

const SIMPLE_LENGTH_LIMIT = 500;
const MAX_SIMPLE_MESSAGES = 2;

function chooseModel(body) {
  const requested = body.model;

  if (body.model_override === false) {
    return { model: requested, downgraded: false, reason: 'client opted out' };
  }

  const messages = body.messages || [];

  const totalChars = messages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
    0
  );

  if (messages.length > MAX_SIMPLE_MESSAGES) {
    return { model: requested, downgraded: false, reason: 'multi-turn conversation' };
  }

  if (totalChars > SIMPLE_LENGTH_LIMIT) {
    return { model: requested, downgraded: false, reason: 'long prompt' };
  }

  const text = messages.map((m) => m.content).join(' ');
  if (COMPLEX_PATTERNS.test(text)) {
    return { model: requested, downgraded: false, reason: 'reasoning keyword' };
  }

  const cheap = config.provider.cheapModel;
  if (!cheap || cheap === requested) {
    return { model: requested, downgraded: false, reason: 'no cheaper option' };
  }

  return { model: cheap, downgraded: true, reason: 'short simple prompt' };
}

module.exports = { chooseModel };