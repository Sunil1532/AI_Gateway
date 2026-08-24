# AI Cost Optimization & Governance Gateway

A backend proxy that sits between applications and AI model providers. Applications change one line — the base URL — and keep their existing SDK. Every request then passes through authentication, budget enforcement, rate limiting, caching, and model routing, with per-request cost attribution written to MongoDB.

**Node.js · Express 5 · MongoDB · Redis · **

---

## Why

Provider APIs bill per token and report account-level totals. They don't answer "which team spent this", can't cap a runaway retry loop, and charge repeatedly for identical questions. This gateway adds those controls without requiring any application to change how it calls the model.

One finding shaped the whole billing design. A live response from `gemini-3.6-flash`:

```json
"usage": { "prompt_tokens": 8, "completion_tokens": 7, "total_tokens": 676 }
```

8 + 7 ≠ 676. The missing ~660 are **reasoning tokens** — the model thinking internally, billed at output rates but not itemised. Cost tracking built on the two labelled fields, which is how most tutorials do it, **undercounts by 45×**. Any budget enforcement built on those fields is decorative.

This gateway bills on `total_tokens`.

---

## Measured results

Load tested with k6: 5 concurrent users, 2 minutes, live Gemini endpoints.

| Metric | Result |
|---|---|
| Requests completed | 2,924 |
| Failures | 0 |
| Throughput | ~24 req/sec |
| Cached p95 latency | **113 ms** |
| Uncached p95 latency | 29,329 ms |
| Average latency | 73 ms |
| Actual spend | $0.042 |

**A 260× latency difference between cached and uncached responses.** That is the strongest number here and it is real.

### The caveat that matters

The same run reported a 99% savings rate. **That figure is an artifact of the test, not a property of the gateway.**

The prompt pool contained six distinct prompts. Across 2,924 requests, near-total cache hits are arithmetically guaranteed regardless of cache quality. Real traffic would see far lower repeat rates — perhaps 30–40% for a support bot, under 10% for developer tooling.

Any savings percentage from a caching gateway is a function of workload, not of the software. Reported without the prompt distribution, it means nothing. The mix used is documented in `loadtest/baseline.js`.

### Model routing, measured

Identical prompt, "What is the capital of France?":

| | Model | Total tokens |
|---|---|---|
| As requested | `gemini-3.6-flash` | 97 |
| After routing | `gemini-3.1-flash-lite` | 15 |

Savings compound from two sources — a ~3× cheaper rate *and* ~6× fewer tokens, because the expensive model spent ~80 tokens reasoning about a question requiring none.

Routing restraint also works: "Analyze the causes of inflation" consumed 1,087 total tokens on the expensive model and was correctly **not** downgraded by the keyword guard.

---

## How it works

**Forward path** — ordered so the cheapest rejection happens first:

```
client
  └─ verify virtual key        401 if unknown or revoked
     └─ check rate limit       429 if over  (atomic, Lua)
        └─ check budget        429 if over
           └─ normalize/trim   fewer tokens, better cache hits
              └─ choose model  downgrade simple prompts
                 └─ cache      return stored answer, $0
                    └─ provider  only on a miss
```

**Return path** — the client's copy is never delayed by bookkeeping:

```
provider streams chunks
  ├─ forward each chunk to the client immediately
  └─ append to a buffer in parallel
     └─ on [DONE]: extract usage, compute cost,
        write cache, enqueue usage record
```

Trimming runs before routing because routing reads the text; both run before the cache lookup because the key hashes the trimmed messages *and* the resolved model.

---

## Design decisions

| Decision | Reasoning |
|---|---|
| Bill on `total_tokens` | The labelled fields miss reasoning tokens and undercount by up to 45× |
| SHA-256, not bcrypt, for key lookup | Bcrypt salts randomly, so a key could never be *found* by value — only verified against a hash you already have |
| Money as integer micros | `0.1 + 0.2 !== 0.3`; float drift is unacceptable in a spend tracker |
| Lua script for rate limiting | Check-and-increment must be atomic; read-then-write lets concurrent requests both pass a limit only one should |
| Sliding window, not fixed | A fixed window allows 2× the limit across a boundary — exactly the burst being prevented |
| Store `baselineCostMicros` per request | Savings can only be computed at request time; records written without it can never prove value retroactively |
| Store tokens alongside cost | Provider rates change. Tokens are ground truth and cost is recomputable; dollars alone are not |
| Redis fails open | A cache outage should cost speed, not availability |
| The usage queue fails to Mongo | Deliberately inconsistent with the above — losing a billing record costs money, not milliseconds |
| Reconstruct SSE on a cache hit | Returning buffered JSON would break drop-in compatibility, which the whole design rests on |
| Never cache unless `finish_reason === 'stop'` | A truncated answer cached once is served for the full TTL |
| Default to the requested model | A routing bug should cost money, not answer quality |

Fuller reasoning in [`DECISIONS.md`](./DECISIONS.md).

---

## Known limitations

Stated deliberately rather than discovered by a reviewer:

- **Budget overshoot is possible.** Cost is only knowable after generation, so the pre-flight check is always against a stale number. A key at $4.99 of a $5 cap can still pass and overspend. Accepted; concurrent requests widen the window.
- **Only `POST /v1/chat/completions` is implemented.** Tools like Cursor and Open WebUI also call `GET /v1/models` and will refuse to configure without it.
- **Streaming is forced.** Clients requesting a non-streamed response receive SSE anyway.
- **Routing rules are proxies, not comprehension.** Character count and an English keyword regex will misroute — "Solve this integral" is short with no trigger word and gets downgraded. `model_override: false` is the escape hatch.
- **Cache stampede is unhandled.** Concurrent misses on the same uncached prompt all reach the provider. Visible in the load test: 14 misses against 6 distinct prompts.
- **Cache keys are not tenant-scoped.** With bring-your-own-key enabled, two customers asking the same question would share a cached answer.
- **The worker runs in-process.** A crash in either takes down the other.
- **No admin UI.** Endpoints only.

---

## Running it

```bash
git clone https://github.com/Sunil1532/AI_Gateway.git
cd AI_Gateway
npm install

docker run -d --name redis -p 6379:6379 redis:7-alpine

cp .env.example .env      # fill in the values
node scripts/seed.js      # prints a virtual key, once

npm run dev
```

`.env` needs a Gemini API key from [Google AI Studio](https://aistudio.google.com), a MongoDB connection string, and two generated secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Using it

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'gw_...',              // the seeded virtual key
});

const stream = await client.chat.completions.create({
  model: 'gemini-3.6-flash',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
  stream: true,
});
```

Response headers expose what the gateway did: `X-Cache: HIT|MISS`, `X-Model-Routed: downgraded|as-requested`, `X-RateLimit-Remaining`.

### Load test

```bash
k6 run -e GW_KEY=gw_... loadtest/baseline.js
```

---

## API

**Gateway** — `POST /v1/chat/completions`, authenticated with a virtual key.

**Admin** — all require `Authorization: Bearer $ADMIN_SECRET`:

| Endpoint | Purpose |
|---|---|
| `POST /admin/keys` | Onboard a customer; returns the key once |
| `GET /admin/keys` | List keys with budget utilisation |
| `PATCH /admin/keys/:id` | Adjust budget, rate limit, status; rotate provider key |
| `DELETE /admin/keys/:id` | Soft revoke — logs reference the key, so never hard-deleted |
| `GET /admin/stats` | Spend, savings, cache hit rate |
| `GET /admin/timeseries` | Daily buckets of actual vs baseline cost |
| `GET /admin/requests` | Paginated request log |

---

## Structure

```
src/
├── server.js                connect Mongo, start worker, listen
├── config/                  env, provider URLs, pricing table
├── routes/                  URL to handler; modelRouter holds routing rules
├── controllers/             orchestrates one request
├── providers/               outbound call, returns the Response unread
├── middleware/              auth, rate limit, budget, admin auth
├── models/                  User, VirtualKey, UsageLog
├── cache/                   key building, get, set
├── redis/                   client with availability flag, Lua script
├── queue/                   Redis Stream producer and batching worker
└── utils/                   key generation, cost, trimming, encryption
```

Dependencies point one way: route → controller → provider → config. `req` and `res` live at the edge; the controller is the last layer that touches them, and everything deeper takes plain data and returns plain data.

---

## Context

Built as a learning project to work through backend fundamentals hands-on: HTTP streaming internals, SSE wire format, Mongoose schema design and indexing, Redis atomicity and race conditions, event-driven decoupling, and load testing.

[LiteLLM](https://github.com/BerriAI/litellm) is the production-grade open-source option in this category and does considerably more. This repository exists to understand how the pieces work, not to compete with it.

Notable bugs worth the time they cost:

- **Express 5 changed `req.on('close')`** — it now fires when the request body finishes reading, not on client disconnect. Using it to trigger `AbortController.abort()` killed every request instantly. Listen on `res` instead.
- **A zombie Node process held port 3000** across restarts, serving stale code through several rounds of correct fixes. When fixes stop having any effect, question whether the code you fixed is the code running.
- **Two files used different require paths** (`../config` vs `../config/index`) that resolved differently, leaving `config.pricing` undefined. The stack trace named the file, line, and missing object — reading it to the end was faster than guessing.
