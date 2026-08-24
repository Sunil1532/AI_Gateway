const { callGemini } = require('../providers/geminiProvider');
const { calculateCost } = require('../utils/cost');
const { trimMessages } = require('../utils/trim');
const { chooseModel } = require('../routes/modelRouter');
const { enqueue } = require('../queue/usageQueue');
const cache = require('../cache/responseCache');

async function chatCompletions(req, res) {
  const startedAt = Date.now();
  const controller = new AbortController();
  let finished = false;

  res.on('close', () => {
    if (!finished) controller.abort();
  });

  // Order matters: trim first (routing reads the trimmed text and the cache
  // key hashes it), then route (the resolved model is part of the cache key),
  // then build the cache key.
  const trimmedMessages = trimMessages(req.body.messages);
  const workingBody = { ...req.body, messages: trimmedMessages };

  const routed = chooseModel(workingBody);
  const outgoingBody = { ...workingBody, model: routed.model };

  const requestedModel = req.body.model;

  const cacheable = cache.isCacheable(outgoingBody);
  const cacheKey = cacheable ? cache.buildKey(outgoingBody) : null;

  try {
    if (cacheKey) {
      const hit = await cache.get(cacheKey);

      if (hit) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Model-Routed', routed.downgraded ? 'downgraded' : 'as-requested');
        res.flushHeaders();

        const chunk = {
          id: `cached-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: hit.model,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: hit.content },
              finish_reason: 'stop',
            },
          ],
        };

        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write('data: [DONE]\n\n');

        finished = true;
        res.end();

        // Baseline is always what the client asked for, never what we routed to.
        const baseline = calculateCost(requestedModel, hit.usage);

        // Fire and forget: the user already has their answer.
        enqueue({
          virtualKeyId: req.virtualKey._id,
          userId: req.virtualKey.userId,
          requestedModel,
          resolvedModel: hit.model,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costMicros: 0,
          baselineCostMicros: baseline.costMicros,
          cacheHit: true,
          streamCompleted: true,
          latencyMs: Date.now() - startedAt,
        });

        return;
      }
    }

const upstream = await callGemini(outgoingBody, controller.signal, req.providerApiKey);

    if (!upstream.ok) {
      const detail = await upstream.text();
      return res.status(upstream.status).json({ error: detail });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Model-Routed', routed.downgraded ? 'downgraded' : 'as-requested');
    res.flushHeaders();

    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;
    let modelUsed = null;
    let requestId = null;
    let content = '';
    let finishReason = null;

    for await (const chunk of upstream.body) {
      res.write(chunk);

      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          if (parsed.usage) usage = parsed.usage;
          if (parsed.model) modelUsed = parsed.model;
          if (parsed.id) requestId = parsed.id;

          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) content += delta;

          const finish = parsed.choices?.[0]?.finish_reason;
          if (finish) finishReason = finish;
        } catch {
          // partial or malformed JSON, ignore
        }
      }
    }

    finished = true;
    res.end();

    const resolvedModel = modelUsed || routed.model;

    // Never cache a stream that did not complete cleanly.
    if (cacheKey && finishReason === 'stop' && content) {
      await cache.set(cacheKey, { content, model: resolvedModel, usage });
    }

    const { costMicros, totalTokens } = calculateCost(resolvedModel, usage);
    const baseline = calculateCost(requestedModel, usage);

    // Fire and forget: one Redis append instead of two Mongo round trips.
    enqueue({
      virtualKeyId: req.virtualKey._id,
      userId: req.virtualKey.userId,
      requestId,
      requestedModel,
      resolvedModel,
      promptTokens: usage?.prompt_tokens || 0,
      completionTokens: usage?.completion_tokens || 0,
      totalTokens,
      costMicros,
      baselineCostMicros: baseline.costMicros,
      cacheHit: false,
      streamCompleted: Boolean(usage),
      latencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error(err);
    if (err.name === 'AbortError') return;

    if (res.headersSent) {
      res.end();
    } else {
      res.status(502).json({ error: 'Upstream request failed' });
    }
  }
}

module.exports = { chatCompletions };