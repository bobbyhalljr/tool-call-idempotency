# tool-call-idempotency

A tiny exactly-once layer for agent tool calls, in one TypeScript file.
It runs four retry strategies against four network faults and counts every charge that actually committed.
The billing service is a mock. No API key.

## Why it matters

A timeout is not a failure.

It tells you what the client saw. It does not tell you what the server did.
When an agent retries a write after a timeout, the first attempt may already have landed.
That is how you get a second charge, a second email, or a second deployment.

The fix is old: one idempotency key per intent, pinned by the harness, honored by the tool.

## Run it

You need Node.js 18 or newer.

```bash
npm install
npx tsx retry.ts
```

## Example output

This is real output from `npx tsx retry.ts`:

```text
Task: charge acme $49.00 exactly once (MOCK billing, no API key)

Fault: none
  naive retry          charges=1  ok         agent said: completed
  verify then retry    charges=1  ok         agent said: completed
  new key per attempt  charges=1  ok         agent said: completed
  pinned intent key    charges=1  ok         agent said: completed

Fault: lost-ack
  naive retry          charges=2  DUPLICATE  agent said: completed
  verify then retry    charges=1  ok         agent said: completed
  new key per attempt  charges=2  DUPLICATE  agent said: completed
  pinned intent key    charges=1  ok         agent said: completed

Fault: late-commit
  naive retry          charges=2  DUPLICATE  agent said: completed
  verify then retry    charges=2  DUPLICATE  agent said: completed
  new key per attempt  charges=2  DUPLICATE  agent said: completed
  pinned intent key    charges=1  ok         agent said: completed

Fault: redelivery
  naive retry          charges=2  DUPLICATE  agent said: completed
  verify then retry    charges=2  DUPLICATE  agent said: completed
  new key per attempt  charges=1  ok         agent said: completed
  pinned intent key    charges=1  ok         agent said: completed

Duplicates: 7 of 16 runs
Duplicates the agent reported as completed: 7

Key reuse with a different amount:
  idempotency key reused with different parameters
```

Seven duplicates out of sixteen runs. Every one of them reported `completed`.
The pinned intent key is the only strategy that stays at one charge under every fault.

## How it works

```text
Model ──→ "charge acme $49"
             ↓
Harness ──→ intent key = task + tool + args
             ↓
Tool ──→ seen this key? replay : execute
             ↓
Ledger ──→ exactly one charge
```

| File | What it does |
| --- | --- |
| `retry.ts` | The whole demo, in the same order as the post |
| `output.txt` | Real output of `npx tsx retry.ts` |
| `package.json` | `tsx`, `typescript` and `@types/node` as dev dependencies |
| `tsconfig.json` | Strict settings for `npx tsc --noEmit` |

Inside `retry.ts`:

- Types: `ChargeArgs`, `Charge`, `Fault`, `CallResult`
- `Billing`: a MOCK billing service. Same key and same arguments replay the first charge. Same key and different arguments are refused. This follows the behavior Stripe documents for idempotent requests.
- Faults: `lost-ack` (committed, response lost), `late-commit` (lands 90 simulated seconds later), `redelivery` (delivered twice)
- Strategies: `naiveRetry`, `verifyThenRetry`, `newKeyPerAttempt`, `pinnedKey`
- `intentKey`: task id + tool name + a hash of the canonical arguments

What is real and what is mocked:

- `Billing` is a MOCK. No network. No API key.
- The faults are scripted, one per run, on the first call.
- The customer, amount and timings are example inputs.
- The fault types follow the ones studied in "Where Does Exactly-Once Live?" (arXiv 2609.29095, Sep 24, 2026). This repo is not that benchmark.

## Limits

This is a teaching layer.

- A key only works if the service stores it. Not every API accepts one.
- Keys expire. Stripe says keys can be pruned after they are at least 24 hours old.
- `verifyThenRetry` matches on customer and amount. Real code should match on the key or a business ID.
- When there is no key and no reliable read path, the honest result is `unknown`. Escalate.

## Read more

- Dev.to: [A Timeout Is Not a Failure: Build Idempotent Tool Calls for AI Agents in TypeScript](DEV_URL)
- Substack: [A Timeout Is Not a Failure: Build Idempotent Tool Calls for AI Agents in TypeScript](SUBSTACK_URL)
- Sources: [arXiv 2609.29095](https://arxiv.org/abs/2609.29095), [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests), [Amazon Builders' Library: Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)

## License

MIT. See [LICENSE](LICENSE).
