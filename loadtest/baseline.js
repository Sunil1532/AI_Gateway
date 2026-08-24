import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const KEY = __ENV.GW_KEY;
const URL = __ENV.GW_URL || 'http://localhost:3000/v1/chat/completions';

// Custom metrics so the gateway's own behaviour shows up in k6's summary
// rather than only in /admin/stats.
const cacheHits = new Counter('gw_cache_hits');
const cacheMisses = new Counter('gw_cache_misses');
const downgrades = new Counter('gw_model_downgrades');
const hitRate = new Rate('gw_cache_hit_rate');
const hitLatency = new Trend('gw_cached_duration', true);
const missLatency = new Trend('gw_uncached_duration', true);

// ---------------------------------------------------------------------------
// WORKLOAD MIX — this determines your headline savings number.
//
// 15 entries, 6 distinct prompts. Repeat rate is roughly 60%, which is
// deliberately chosen to resemble a support-bot workload where a handful of
// questions dominate. A mix with more repeats produces a better-looking
// number that means less. Document whatever you use.
//
// The mix also spans routing cases:
//   - short factual prompts  -> downgraded to flash-lite
//   - "Analyze..." / "Design..." -> keyword guard keeps them on flash
//   - the long prompt        -> length guard keeps it on flash
// ---------------------------------------------------------------------------
const PROMPTS = [
  // High-frequency (cache should absorb these)
  'What is the capital of France?',
  'What is the capital of France?',
  'What is the capital of France?',
  'What is the capital of France?',
  'What are your opening hours?',
  'What are your opening hours?',
  'What are your opening hours?',

  // Medium-frequency
  'Name three primary colours',
  'Name three primary colours',
  'Translate hello into Spanish',
  'Translate hello into Spanish',

  // Low-frequency, short — should downgrade
  'What year did the Berlin Wall fall?',
  'Who wrote Pride and Prejudice?',

  // Should NOT downgrade — reasoning keyword
  'Analyze the causes of the 2008 financial crisis',

  // Should NOT downgrade — exceeds the length threshold
  'Our team is evaluating whether to migrate our existing monolithic ' +
    'application to a microservices architecture. We currently have around ' +
    'forty engineers split across six product teams, deploy roughly twice a ' +
    'week, and run everything on a single managed Postgres instance with a ' +
    'read replica. Latency is acceptable but deploys are slow and one team ' +
    'blocking another has become common. Given that context, what are the ' +
    'main trade-offs we should be weighing, and what would you want to know ' +
    'before recommending either direction?',
];

export const options = {
  stages: [
    { duration: '30s', target: 5 },   // ramp up
    { duration: '1m', target: 5 },    // steady state — the real measurement
    { duration: '30s', target: 0 },   // ramp down
  ],
  thresholds: {
    // p95 rather than average: the average hides intermittent stalls.
    http_req_duration: ['p(95)<8000'],
    http_req_failed: ['rate<0.05'],
  },
};

export default function () {
  const prompt = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];

  const res = http.post(
    URL,
    JSON.stringify({
      model: 'gemini-3.6-flash',
      messages: [{ role: 'user', content: prompt }],
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`,
      },
      timeout: '60s',
      tags: { name: 'chat_completion' },
    }
  );

  const cached = res.headers['X-Cache'] === 'HIT';
  const routed = res.headers['X-Model-Routed'] === 'downgraded';

  if (res.status === 200) {
    hitRate.add(cached);
    if (cached) {
      cacheHits.add(1);
      hitLatency.add(res.timings.duration);
    } else {
      cacheMisses.add(1);
      missLatency.add(res.timings.duration);
    }
    if (routed) downgrades.add(1);
  }

  check(res, {
    'status is 200': (r) => r.status === 200,
    'body has SSE data': (r) => r.body && r.body.includes('data:'),
    'stream terminated': (r) => r.body && r.body.includes('[DONE]'),
    'not rate limited': (r) => r.status !== 429,
  });
}

export function handleSummary(data) {
  const m = data.metrics;
  const val = (name, field = 'count') =>
    m[name] && m[name].values[field] !== undefined ? m[name].values[field] : 0;

  const hits = val('gw_cache_hits');
  const misses = val('gw_cache_misses');
  const total = hits + misses;

  const lines = [
    '',
    '='.repeat(62),
    ' GATEWAY BEHAVIOUR',
    '='.repeat(62),
    ` Requests completed      ${total}`,
    ` Cache hits              ${hits}  (${total ? ((hits / total) * 100).toFixed(1) : 0}%)`,
    ` Cache misses            ${misses}`,
    ` Model downgrades        ${val('gw_model_downgrades')}`,
    '',
    ` Cached  p95 latency     ${(m.gw_cached_duration?.values['p(95)'] ?? 0).toFixed(0)} ms`,
    ` Uncached p95 latency    ${(m.gw_uncached_duration?.values['p(95)'] ?? 0).toFixed(0)} ms`,
    '',
    ' NOTE: k6 waits for the full response body, so these durations are',
    ' total completion time, NOT time-to-first-byte. The streaming',
    ' advantage is invisible in these numbers.',
    '',
    ' Now open /admin/stats for cost, baseline, and savings.',
    '='.repeat(62),
    '',
  ];

  return {
    stdout: lines.join('\n'),
    'loadtest/summary.json': JSON.stringify(data, null, 2),
  };
}