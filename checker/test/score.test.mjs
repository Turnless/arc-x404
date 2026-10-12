// Unit tests for the pure scoring rules: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreFacts } from "../src/score.mjs";
import { canonicalJson, reportHash } from "../src/report.mjs";

const DAY = 86_400;
const OWNER = "0x00000000000000000000000000000000000000A1";
const PAYER = "0x00000000000000000000000000000000000000B1";
const EXCHANGE = "0x00000000000000000000000000000000000000E1";
const FRIEND = "0x00000000000000000000000000000000000000F1";
const PAY_TS = 1_800_000_000;

/// An established, independent payer: 10 days old, funded by an exchange hot wallet,
/// paid 3 unrelated parties, no cluster, not an agent itself.
function honest(overrides = {}) {
  return {
    payer: PAYER,
    linked: [OWNER],
    payTimestamp: PAY_TS,
    firstTimestamp: PAY_TS - 10 * DAY,
    firstBlock: 100,
    payerFunders: [{ address: EXCHANGE, hub: "busy-wallet", block: 100 }],
    linkedFunders: [{ account: OWNER, funder: EXCHANGE, hub: "busy-wallet" }],
    moneyFromAgentSide: [],
    independentRecipients: ["0x01", "0x02", "0x03"],
    otherPayersChecked: 2,
    clusterWith: [],
    payerAgent: null,
    ...overrides,
  };
}

const sig = (r, id) => r.signals.find((s) => s.id === id);

test("established independent payer scores 7 and has no hard fails", () => {
  const r = scoreFacts(honest());
  // age 10d -> 1, history 3 -> 2, funding via hub -> 2, not single target 1, no cluster 1
  assert.equal(r.trustScore, 7);
  assert.deepEqual(r.hardFails, []);
  assert.equal(sig(r, "wallet-age").points, 1);
  assert.equal(sig(r, "independent-funding").points, 2);
});

test("a shared exchange hub is not a link", () => {
  const r = scoreFacts(honest());
  assert.equal(sig(r, "independent-funding").pass, true);
});

test("owner-funded sock wallet is a hard fail and scores 0", () => {
  const r = scoreFacts(
    honest({ payerFunders: [{ address: OWNER, hub: null, block: 100 }], firstTimestamp: PAY_TS - 3600 }),
  );
  assert.equal(r.trustScore, 0);
  assert.deepEqual(r.hardFails, ["wallet-age", "independent-funding"], "too new and owner-funded");
  assert.equal(sig(r, "independent-funding").evidence.linkedVia, OWNER);
});

test("sock funded two hops back by the owner is caught", () => {
  const r = scoreFacts(
    honest({
      payerFunders: [
        { address: FRIEND, hub: null, block: 90 },
        { address: OWNER, hub: null, block: 80 },
      ],
    }),
  );
  assert.equal(r.trustScore, 0);
  assert.ok(r.hardFails.includes("independent-funding"));
});

test("payer and owner funded by the same personal wallet is a link", () => {
  const r = scoreFacts(
    honest({
      payerFunders: [{ address: FRIEND, hub: null, block: 90 }],
      linkedFunders: [{ account: OWNER, funder: FRIEND, hub: null }],
    }),
  );
  assert.equal(r.trustScore, 0);
  assert.equal(sig(r, "independent-funding").evidence.sharedFunderWith, OWNER);
});

test("money from the agent side (loop) is a hard fail, whatever the route", () => {
  for (const via of ["sent directly by the agent's side", "transaction sent by the agent's side through 0xC1", "gate withdrawal to the payer"]) {
    const r = scoreFacts(honest({ moneyFromAgentSide: [{ from: OWNER, block: 1, tx: "0x", via }] }));
    assert.equal(r.trustScore, 0);
    assert.deepEqual(r.hardFails, ["no-money-loop"]);
  }
});

test("the payer being on the agent side is a hard fail", () => {
  const r = scoreFacts(honest({ linked: [OWNER, PAYER] }));
  assert.equal(r.trustScore, 0);
  assert.ok(r.hardFails.includes("not-agent-side"));
});

test("a wallet younger than the minimum age cannot review, whatever else it has", () => {
  const r = scoreFacts(honest({ firstTimestamp: PAY_TS - 3600, independentRecipients: [] }));
  assert.equal(r.trustScore, 0);
  assert.deepEqual(r.hardFails, ["wallet-age"]);
  const justUnder = scoreFacts(honest({ firstTimestamp: PAY_TS - 6.99 * DAY }));
  assert.deepEqual(justUnder.hardFails, ["wallet-age"]);
  const atMin = scoreFacts(honest({ firstTimestamp: PAY_TS - 7 * DAY }));
  assert.deepEqual(atMin.hardFails, []);
});

test("review finding 1: an instant sock with its own agent, a domain and 3 recipients still scores 0", () => {
  const payerAgent = {
    agentId: 9,
    controls: true,
    validRegistration: true,
    agedRegistration: false,
    domains: [{ host: "sock.example", verified: true }],
  };
  const r = scoreFacts(
    honest({ payerAgent, firstTimestamp: PAY_TS - 600, payerFunders: [{ address: EXCHANGE, hub: "busy-wallet", block: 1 }] }),
  );
  assert.equal(r.trustScore, 0);
  assert.ok(r.hardFails.includes("wallet-age"));
  assert.equal(sig(r, "payer-agent-identity").points, 0, "a new agent registration earns nothing");
  assert.equal(sig(r, "domain-verified").points, 0);
});

test("unknown funder earns 0 funding points", () => {
  const r = scoreFacts(honest({ payerFunders: [] }));
  assert.equal(sig(r, "independent-funding").points, 0);
  assert.deepEqual(r.hardFails, []);
  assert.equal(r.trustScore, 5);
});

test("cluster with another payer costs the cluster point", () => {
  const r = scoreFacts(honest({ clusterWith: [{ payer: FRIEND, funder: EXCHANGE }] }));
  assert.equal(sig(r, "no-cluster").points, 0);
  assert.equal(r.trustScore, 6);
});

test("age tiers: 30+ days gives 2, 7+ gives 1", () => {
  assert.equal(sig(scoreFacts(honest({ firstTimestamp: PAY_TS - 31 * DAY })), "wallet-age").points, 2);
  assert.equal(sig(scoreFacts(honest({ firstTimestamp: PAY_TS - 7 * DAY })), "wallet-age").points, 1);
});

test("history tiers: 1-2 recipients give 1 point", () => {
  assert.equal(sig(scoreFacts(honest({ independentRecipients: ["0x01"] })), "independent-history").points, 1);
  assert.equal(sig(scoreFacts(honest({ independentRecipients: ["0x01", "0x02"] })), "independent-history").points, 1);
});

test("a payer agent with a verified domain earns identity and domain points, model claim never scores", () => {
  const payerAgent = {
    agentId: 9,
    controls: true,
    validRegistration: true,
    agedRegistration: true,
    name: "Buyer agent",
    modelClaim: "gpt-x",
    domains: [{ host: "buyer.example", verified: true }],
  };
  const r = scoreFacts(honest({ payerAgent, firstTimestamp: PAY_TS - 31 * DAY }));
  assert.equal(sig(r, "payer-agent-identity").points, 1);
  assert.equal(sig(r, "domain-verified").points, 1);
  assert.equal(sig(r, "model-claim").points, 0);
  assert.equal(r.trustScore, 10, "maximum score");
});

test("domain point needs a valid controlled agent", () => {
  const payerAgent = { agentId: 9, controls: false, validRegistration: true, agedRegistration: true, domains: [{ host: "x", verified: true }] };
  const r = scoreFacts(honest({ payerAgent }));
  assert.equal(sig(r, "payer-agent-identity").points, 0);
  assert.equal(sig(r, "domain-verified").points, 0);
});

test("maximum possible points add up to 10", () => {
  const r = scoreFacts(honest());
  assert.equal(r.signals.reduce((a, s) => a + s.max, 0), 10);
});

test("report hash is canonical: key order does not matter", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3n, c: null }] }), '{"a":[2,{"c":null,"d":"3"}],"b":1}');
  assert.equal(reportHash({ x: 1, y: 2 }), reportHash({ y: 2, x: 1 }));
  assert.notEqual(reportHash({ x: 1 }), reportHash({ x: 2 }));
});

test("money pushed through a forwarder contract by the owner is still a link", () => {
  const FORWARDER = "0x00000000000000000000000000000000000000C1";
  const r = scoreFacts(
    honest({ payerFunders: [{ address: FORWARDER, hub: "contract", initiator: OWNER, identity: OWNER, block: 100 }] }),
  );
  assert.equal(r.trustScore, 0);
  assert.equal(sig(r, "independent-funding").evidence.linkedVia, OWNER);
});

test("a bridge contract run by a busy relayer is not a link", () => {
  const BRIDGE = "0x00000000000000000000000000000000000000C2";
  const RELAYER = "0x00000000000000000000000000000000000000D2";
  const r = scoreFacts(
    honest({ payerFunders: [{ address: BRIDGE, hub: "contract", initiator: RELAYER, initiatorHub: "busy-wallet", identity: null, block: 100 }] }),
  );
  assert.deepEqual(r.hardFails, []);
  assert.equal(sig(r, "independent-funding").points, 2);
});
