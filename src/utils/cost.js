const config = require('../config/index');

function calculateCost(model, usage) {
  if (!usage) return { costMicros: 0, totalTokens: 0 };

  const rates = config.pricing[model];
  if (!rates) {
    console.warn(`No pricing for model "${model}" — cost recorded as 0`);
    return { costMicros: 0, totalTokens: usage.total_tokens || 0 };
  }

  const promptTokens = usage.prompt_tokens || 0;
  const totalTokens = usage.total_tokens || 0;

  // Reasoning tokens are hidden inside total_tokens and are not reported
  // separately. Everything beyond the prompt is billed at the output rate,
  // since reasoning is generation. See DECISIONS.md.
  const outputTokens = Math.max(totalTokens - promptTokens, 0);

  const costMicros =
    Math.ceil((promptTokens * rates.inputPerMillion) / 1_000_000) +
    Math.ceil((outputTokens * rates.outputPerMillion) / 1_000_000);

  return { costMicros, totalTokens };
}

module.exports = { calculateCost };