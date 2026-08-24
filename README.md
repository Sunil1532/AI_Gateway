# AI Cost Optimization & Governance Gateway

A backend proxy that sits between applications and AI model providers. Applications change one line — the base URL — and keep their existing SDK. Every request then passes through authentication, budget enforcement, rate limiting, caching, and model routing, with per-request cost attribution written to MongoDB.

**Node.js · Express 5 · MongoDB · Redis ·**

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

# Architecture

## The gateway is two things at once

To the client it is a **server**, speaking the OpenAI chat-completions contract. To the provider it is a **client**, speaking that same contract outbound. Two separate HTTP conversations, and everything the gateway does happens in the gap between them.

```
   Conversation A                        Conversation B
   gateway is the server                 gateway is the client

  ┌────────┐                ┌─────────┐                ┌────────┐
  │ client │ ──── req ────► │ gateway │ ──── req ────► │ Gemini │
  │        │ ◄─── res ───── │         │ ◄─── res ───── │        │
  └────────┘                └─────────┘                └────────┘
     req / res live here           fetch Response lives here
```

Google never sees a virtual key. The client never sees the provider key. This separation is what makes per-team budgets and individual revocation possible on top of a provider that offers neither.

It also dictates the layering: **`req` and `res` never travel inward.** The controller is the last layer that touches them; everything deeper takes plain data and returns plain data. The test is "could this function be called from a cron job?" — if not, it's holding something it shouldn't.

```
route ──► controller ──► provider ──► config
        (holds req/res)  (plain data)
```

Dependencies point one way. Nothing reaches back upward.

## Request lifecycle

**Forward path** — ordered so the cheapest rejection happens first:

```
client
  └─ verify virtual key        401  · one indexed Mongo read
     └─ check rate limit       429  · one Redis Lua call
        └─ check budget        429  · compares denormalised counter
           └─ normalize/trim         · whitespace only
              └─ choose model        · rules engine
                 └─ cache lookup     · SHA-256 of trimmed body + model
                    └─ provider      · only on a miss
```

Every stage above the provider call is a chance to spend nothing. The ordering follows cost: rejecting an over-budget request should cost one Redis read, not a hash plus a cache lookup plus a provider call.

The three transform stages are locked in that order for a specific reason. Trimming alters the text, so routing must read the trimmed version. Routing determines the model, and the cache key hashes **both** the trimmed messages and the resolved model. Reverse any of them and the cache silently degrades — `"hello"` and `"hello  "` would hash differently and miss each other.

**Return path** — where the billing complexity lives:

```
provider streams chunks
  │
  ├─► res.write(chunk)          forwarded immediately, unparsed
  │
  └─► buffer += chunk           accumulated in parallel
        └─ on [DONE]:
             extract usage + finish_reason
             write cache (only if finish_reason === 'stop')
             enqueue usage record → Redis Stream
```

The fork is the central design decision. A streamed response contains no `usage` block until the very end, so the gateway can't be a dumb pipe — but it also can't wait for the stream to finish before forwarding, because that destroys the latency benefit that justifies streaming.

So each chunk goes two places: straight to the client's socket, and onto a buffer. `res.write` happens **before** any parsing, so the client's copy is never delayed by bookkeeping.

## What lives where

| Store | Holds | Why there |
|---|---|---|
| MongoDB | Users, VirtualKeys, UsageLogs | Durable, queryable, survives restart |
| Redis | Cache entries, rate-limit windows, usage queue | Sub-millisecond, expendable |
| Process memory | Config, pricing table, routing rules | Read constantly, never changes |

The rule: if losing it on restart is survivable, Redis. If it's money or identity, Mongo.

This is why **Mongo gates `app.listen` and Redis does not**. A gateway that can't authenticate shouldn't accept traffic. A gateway without a cache should just be slower.

## Streaming internals

Three things about SSE that shape the parser:

**Network chunks are not SSE events.** One TCP chunk may carry two complete events plus half of a third. The parser accumulates into a buffer, splits on the blank-line delimiter, and pushes the trailing fragment back for the next iteration:

```javascript
buffer += decoder.decode(chunk, { stream: true });
const parts = buffer.split('\n\n');
buffer = parts.pop();          // keep the incomplete tail
```

Skipping that loses tokens at random, and only under load.

**`data: [DONE]` is not valid JSON.** Anything that blindly parses every chunk crashes on the final one, on every single request.

**Headers must be committed before the first byte of body.** Once one byte is written they've physically gone down the wire; Node throws `ERR_HTTP_HEADERS_SENT` on any change. `Content-Length` is deliberately omitted — its absence is what activates chunked transfer encoding, the mechanism that permits a body of unknown length.

## Concurrency

Two places where correctness depends on atomicity, both solved at the database rather than in JavaScript.

**Rate limiting.** The naive version — read count, compare, increment — is broken under concurrency: two requests both read "4 of 5 used", both conclude they're fine, both proceed. The gap between read and write cannot be closed in application code, because those are separate round trips.

The fix is a Lua script. Redis is single-threaded and runs a script to completion without interruption, so check-and-increment cannot interleave:

```lua
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)   -- forget expired
local count = redis.call('ZCARD', key)                 -- count window
if count >= limit then return {0, count} end           -- reject
redis.call('ZADD', key, now, member)                   -- record
redis.call('PEXPIRE', key, window)                     -- self-clean
```

`MULTI`/`EXEC` wouldn't work here — it queues commands but can't branch on an intermediate result, and this needs the count before deciding.

**Spend increments.** Loading a document, adding to `spentMicros`, and saving lets two concurrent requests both read `1000` and both write `1200`, losing one increment. `$inc` is atomic at the database level. The batching worker goes further, summing fifty requests from one key into a single `$inc` rather than fifty.

---

# Edge cases

Every one of these was hit or deliberately designed around.

## Streaming

| Case | Handling |
|---|---|
| Provider errors **before** any chunk | Headers not yet sent, so the provider's status is passed through with a JSON body |
| Provider dies **mid-stream** | Headers long gone — the client already has a 200 and partial text. All that's possible is `res.end()` and a log. **Not cached.** |
| `usage` block never arrives | `streamCompleted: false` on the log; cost recorded as 0 rather than silently guessed |
| `finish_reason` is `length` or `content_filter` | Response is served but **never cached** — a truncated answer cached once is served for the full TTL |
| Multi-byte character split across chunks | `TextDecoder` with `{ stream: true }`; without the flag it decodes to garbage |
| Provider sends unknown fields | Raw bytes forwarded unparsed, so Google's `extra_content` and `thought_signature` survive intact |

## Client behaviour

**Client disconnects mid-stream.** Without handling, the gateway keeps pulling tokens from the provider that nobody will read — and pays for every one. An `AbortController` signal is passed to `fetch` and aborted on the response's `close` event.

This is also where Express 5 bit: `req.on('close')` fires when the **request body** finishes reading, not on client disconnect. Wiring the abort to it killed every request instantly. Listening on `res` is correct.

**Abort is expected, not an error.** The catch block returns silently on `AbortError` rather than logging noise or attempting a response on a dead socket.

## Redis unavailable

Three components, and deliberately not the same answer for all three:

| Component | Behaviour | Why |
|---|---|---|
| Cache | Treat as a miss, call the provider | Losing a cache costs speed, not correctness |
| Rate limiter | Allow the request, log loudly | Failing closed makes Redis a single point of failure for the entire gateway; Mongo budget checks still apply |
| Usage queue | **Write directly to Mongo** | Losing a billing record costs money, not milliseconds |

That last row is inconsistent with the other two on purpose. The client is configured with `enableOfflineQueue: false` so commands reject immediately instead of piling up in memory during an outage — queueing a cache lookup for three minutes and then executing it is actively wrong.

## Rate limiting

**Two requests in the same millisecond.** Sorted-set members must be unique. A bare timestamp as the member means the second `ZADD` overwrites rather than adds, silently undercounting. Members carry a random suffix. This bug only appears under load — exactly when it matters.

**Idle keys accumulating forever.** `PEXPIRE` runs on every call, pushing the key's expiry forward so untouched windows disappear on their own.

**Eviction can delete a rate limiter.** With cache entries and rate-limit windows in one Redis instance under `allkeys-lru`, an eviction sweep can drop a limiter mid-window. Separate instances would fix it; single-instance is the accepted trade-off.

## Budgets

**The overshoot is unavoidable, not a bug.** Cost is only knowable after generation, so the pre-flight check always compares against a stale number. A key at $4.99 of a $5 cap passes, then spends another $0.50. Concurrent requests widen the window further — each passes the check before any of them writes back.

Three options were considered: block at a percentage of the cap, allow the overshoot and reconcile, or estimate from input length and clamp `max_tokens`. The second was chosen and documented rather than hidden.

**Period reset happens on access**, not by a scheduled job. A key untouched for two months resets whenever it's next used. Simpler, no cron to maintain; the only cost is that a dormant key's stored spend looks stale until someone touches it.

## Cost calculation

**Unknown model.** A model missing from the pricing table returns zero cost with a loud warning rather than throwing. Throwing would turn a pricing gap into an outage; silence would create a free-spending loophole. The warning is the compromise.

**Rounding.** `Math.ceil` rather than truncation. Integer division would systematically undercharge — trivial per request, real across a hundred thousand.

**Repricing.** Gemini's rates changed mid-project, making every logged cost wrong. They remained *recomputable* because `totalTokens` is stored alongside `costMicros`. Storing dollars alone would have made that history unrecoverable.

## Caching

**Cache stampede.** Concurrent misses on the same uncached prompt all reach the provider, because none has finished writing yet. Visible in the load test: 14 provider calls against 6 distinct prompts. Known, unfixed; the fix is a lock or single-flight.

**Temperature above zero is never cached.** A caller asking for randomness explicitly does not want a stored answer.

**A hit is reconstructed as SSE**, not returned as buffered JSON. The `id` and `created` fields are fabricated and the whole answer arrives as one chunk — acceptable, since it arrives in milliseconds, and it preserves the drop-in compatibility the whole design rests on.

**Cache keys are not tenant-scoped.** With bring-your-own-key enabled, two customers asking the same question would share a cached answer. A correctness bug in a multi-tenant deployment; documented rather than shipped silently.

## Operational

**Duplicate onboarding.** `POST /admin/keys` upserts the user, so issuing a second key to an existing customer doesn't trip the unique email index.

**Revocation is a soft delete.** `UsageLog` records reference the key; hard-deleting would orphan the billing history.

**Admin secret comparison is constant-time.** `===` short-circuits on the first mismatched character, leaking the secret one character at a time through response timing. `crypto.timingSafeEqual` doesn't.

---

# Trade-offs

Each of these bought something and cost something. Both sides stated.

### Bill on `total_tokens`

**Bought:** budgets that reflect what's actually charged, including hidden reasoning tokens.
**Cost:** the split between hidden input and output tokens is unknown, so everything beyond `prompt_tokens` is billed at the output rate. Slightly overcharges in edge cases — the safer direction for a spend cap.

### SHA-256 rather than bcrypt for key lookup

**Bought:** an indexed, O(1) lookup by key value.
**Cost:** no per-key salt. Acceptable because virtual keys are 24 bytes of `crypto.randomBytes`, not user-chosen passwords — there is no dictionary to attack. Bcrypt would make lookup impossible, since a salted hash can only be *verified*, never *found*.

### Denormalised `spentMicros`

**Bought:** one indexed read on the hot path instead of an aggregation over the log collection.
**Cost:** two writes per request, and possible drift between the counter and the sum of logs. A reconciliation job is the mitigation and is not built.

### Money as integer micros

**Bought:** exact arithmetic. `0.1 + 0.2 !== 0.3`, and those errors compound across thousands of charges.
**Cost:** every display path converts. Worth it in a spend tracker.

### Sliding window rather than fixed

**Bought:** no boundary burst. A fixed window permits 60 requests at 11:59:59 and 60 more at 12:00:01 — 120 in two seconds, precisely the runaway loop being prevented.
**Cost:** one sorted-set entry per request per window; memory scales with traffic. A sliding-window *counter* would use less at the cost of precision.

### Fail open on Redis

**Bought:** a cache or limiter outage degrades performance, not availability.
**Cost:** during a Redis outage, rate limits are not enforced. Mongo budget checks still apply, so the exposure is bounded.

### Reconstruct SSE on a cache hit

**Bought:** clients cannot tell a cached response from a live one — drop-in compatibility preserved.
**Cost:** fabricated `id` and `created`, and the answer arrives as a single chunk rather than progressively.

### Async batched usage logging

**Bought:** the request releases after one Redis append rather than two Mongo round trips. Batching turns fifty inserts into one, and fifty `$inc` calls on a shared key into one.
**Cost:** analytics lag reality by up to ~5 seconds, and a worker crash mid-batch has a loss window. Consumer-group acknowledgement bounds it — unacknowledged entries stay claimable. The budget check still reads Mongo synchronously, because that one must not lag.

### Default to the requested model

**Bought:** a routing bug costs money, not answer quality. Money is recoverable; trust isn't.
**Cost:** requests that would have been fine on the cheap model stay expensive whenever any guard trips.

### Routing on character count and keywords

**Bought:** a routing decision with no extra latency and no extra cost.
**Cost:** proxies, not comprehension. "Solve this integral" is short with no trigger word and gets downgraded. 600 characters of pasted boilerplate ending in "say yes or no" stays expensive. The keyword list is English-only. `model_override: false` is the escape hatch.

### Whitespace-only trimming

**Bought:** better cache hit rates, since prompts differing only in formatting now collide correctly.
**Cost:** negligible token savings — input is the cheap side of the bill. History windowing, where the real savings are, was **not** built: dropping older messages means deciding on the caller's behalf what they can forget.

### Worker in-process

**Bought:** one process to run and deploy.
**Cost:** a crash in either the gateway or the worker takes down the other. Splitting them is better isolation and more deployment complexity.

### Shared secret for admin auth

**Bought:** no sessions, no password hashing, no user table.
**Cost:** one credential for one admin. Multiple admins would need real sessions — but the boundary is already in the right place, so that's a swap rather than a rewrite.

---

## Known limitations

- **Only `POST /v1/chat/completions` is implemented.** Tools like Cursor and Open WebUI also call `GET /v1/models` and will refuse to configure without it.
- **Streaming is forced.** Clients requesting a non-streamed response receive SSE anyway.
- **Cache stampede is unhandled.**
- **Cache keys are not tenant-scoped.**
- **No graceful shutdown.** SIGTERM cuts in-flight streams and loses unacknowledged queue entries.
- **`/admin/stats` scans the whole collection.** Fine at this scale; needs date bounds at production volume.
- **No reconciliation job** for denormalised spend.
- **No admin UI.** Endpoints only.
- **Single provider.** Multi-provider routing would make the router meaningfully more valuable.

---

## Running it

```bash
git clone https://github.com/Sunil1532/AI_Gateway.git
cd AI_Gateway
cp .env.example .env      # fill in the values
docker compose up --build
```

Or without Docker:

```bash
npm install
docker run -d --name redis -p 6379:6379 redis:7-alpine
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
| `DELETE /admin/keys/:id` | Soft revoke |
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

---

## Context

Built as a learning project to work through backend fundamentals hands-on: HTTP streaming internals, SSE wire format, Mongoose schema design and indexing, Redis atomicity and race conditions, event-driven decoupling, and load testing.

[LiteLLM](https://github.com/BerriAI/litellm) is the production-grade open-source option in this category and does considerably more. This repository exists to understand how the pieces work, not to compete with it.

Bugs worth the time they cost:

- **Express 5 changed `req.on('close')`** — it now fires when the request body finishes reading, not on client disconnect. Using it to trigger `AbortController.abort()` killed every request instantly. Listen on `res` instead.
- **A zombie Node process held port 3000** across restarts, serving stale code through several rounds of correct fixes. When fixes stop having any effect, question whether the code you fixed is the code running.
- **Two `app.listen` calls** — one standalone, one inside the Mongo callback — meant the pre-Mongo listener bound the port and served every request, so nothing ever persisted. The tell was a second startup line reading `port undefined`.
- **Two files used different require paths** (`../config` vs `../config/index`) that resolved differently, leaving `config.pricing` undefined. The stack trace named the file, the line, and the missing object — reading it to the end was faster than guessing.
