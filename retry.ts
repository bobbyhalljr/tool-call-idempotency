// retry.ts: a tiny exactly-once layer for agent tool calls.
// Everything is mocked: an in-memory billing service with injected network faults.
// No API key, no network, no real model. Customers, amounts and timings are example inputs.
import { createHash } from "node:crypto";

// Step 1: model the tool call
type ChargeArgs = { customer: string; amountCents: number };
type Charge = { id: string; customer: string; amountCents: number; at: number };

// lost-ack:    the charge commits, the response is lost (client sees a timeout)
// late-commit: the request is still in flight when the client gives up; it lands 90s later
// redelivery:  the transport delivers one request twice; the client sees one success
type Fault = "none" | "lost-ack" | "late-commit" | "redelivery";

type CallResult =
  | { status: "ok"; charge: Charge }
  | { status: "timeout" }
  | { status: "error"; message: string };

// Step 2: a mock billing service that honors idempotency keys
class Billing {
  ledger: Charge[] = [];
  now = 0; // simulated seconds
  private keys = new Map<string, { fingerprint: string; charge: Charge }>();
  private inFlight: { at: number; args: ChargeArgs; key?: string }[] = [];
  private calls = 0;
  private seq = 0;

  constructor(private fault: Fault) {}

  private commit(args: ChargeArgs, key?: string): Charge | string {
    const fingerprint = JSON.stringify(args);
    if (key) {
      const seen = this.keys.get(key);
      if (seen && seen.fingerprint !== fingerprint) {
        return "idempotency key reused with different parameters";
      }
      if (seen) return seen.charge; // replay: same key, same args, same charge
    }
    const charge = { id: `ch_${++this.seq}`, ...args, at: this.now };
    this.ledger.push(charge);
    if (key) this.keys.set(key, { fingerprint, charge });
    return charge;
  }

  advance(seconds: number) {
    this.now += seconds;
    const due = this.inFlight.filter((r) => r.at <= this.now);
    this.inFlight = this.inFlight.filter((r) => r.at > this.now);
    for (const r of due) this.commit(r.args, r.key);
  }

  createCharge(args: ChargeArgs, key?: string): CallResult {
    const first = ++this.calls === 1;
    if (first && this.fault === "lost-ack") {
      this.commit(args, key);
      this.now += 30;
      return { status: "timeout" };
    }
    if (first && this.fault === "late-commit") {
      this.inFlight.push({ at: this.now + 90, args, key });
      this.now += 30;
      return { status: "timeout" };
    }
    const out = this.commit(args, key);
    if (typeof out === "string") return { status: "error", message: out };
    if (first && this.fault === "redelivery") this.commit(args, key);
    return { status: "ok", charge: out };
  }

  listCharges(customer: string): Charge[] {
    return this.ledger.filter((c) => c.customer === customer);
  }
}

// Step 3: three retry strategies that look reasonable
type Strategy = (svc: Billing, args: ChargeArgs, taskId: string) => string;
const MAX_ATTEMPTS = 3;

const naiveRetry: Strategy = (svc, args) => {
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const res = svc.createCharge(args);
    if (res.status === "ok") return "completed";
    svc.advance(1);
  }
  return "failed";
};

const verifyThenRetry: Strategy = (svc, args) => {
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const res = svc.createCharge(args);
    if (res.status === "ok") return "completed";
    svc.advance(1);
    const found = svc
      .listCharges(args.customer)
      .some((c) => c.amountCents === args.amountCents);
    if (found) return "completed";
  }
  return "failed";
};

const newKeyPerAttempt: Strategy = (svc, args, taskId) => {
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const res = svc.createCharge(args, `${taskId}-retry${i}`);
    if (res.status === "ok") return "completed";
    svc.advance(1);
  }
  return "failed";
};

// Step 4: pin one key per intent, in the harness
function canonical(args: ChargeArgs): string {
  return JSON.stringify(Object.fromEntries(Object.entries(args).sort()));
}

function intentKey(taskId: string, tool: string, args: ChargeArgs): string {
  const hash = createHash("sha256").update(canonical(args)).digest("hex");
  return `${taskId}:${tool}:${hash.slice(0, 12)}`;
}

const pinnedKey: Strategy = (svc, args, taskId) => {
  const key = intentKey(taskId, "create_charge", args);
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const res = svc.createCharge(args, key);
    if (res.status === "ok") return "completed";
    if (res.status === "error") return `failed: ${res.message}`;
    svc.advance(1);
  }
  return "unknown: escalate";
};

// Step 5: run every strategy against every fault and count real charges
const strategies: [string, Strategy][] = [
  ["naive retry", naiveRetry],
  ["verify then retry", verifyThenRetry],
  ["new key per attempt", newKeyPerAttempt],
  ["pinned intent key", pinnedKey],
];
const faults: Fault[] = ["none", "lost-ack", "late-commit", "redelivery"];
const args: ChargeArgs = { customer: "acme", amountCents: 4900 };

console.log("Task: charge acme $49.00 exactly once (MOCK billing, no API key)\n");
let duplicates = 0;
let quietDuplicates = 0;
for (const fault of faults) {
  console.log(`Fault: ${fault}`);
  for (const [name, run] of strategies) {
    const svc = new Billing(fault);
    const report = run(svc, args, "task-42");
    svc.advance(3600); // let anything still in flight land
    const charges = svc.listCharges("acme").length;
    const verdict = charges === 1 ? "ok" : "DUPLICATE";
    if (charges > 1) duplicates++;
    if (charges > 1 && report === "completed") quietDuplicates++;
    console.log(
      `  ${name.padEnd(20)} charges=${charges}  ${verdict.padEnd(9)}  agent said: ${report}`,
    );
  }
  console.log("");
}
console.log(`Duplicates: ${duplicates} of ${faults.length * strategies.length} runs`);
console.log(`Duplicates the agent reported as completed: ${quietDuplicates}\n`);

// Same key, different amount: the service refuses instead of guessing.
const svc = new Billing("none");
const key = intentKey("task-42", "create_charge", args);
svc.createCharge(args, key);
const changed = svc.createCharge({ customer: "acme", amountCents: 9900 }, key);
console.log("Key reuse with a different amount:");
console.log(`  ${changed.status === "error" ? changed.message : "accepted"}`);
