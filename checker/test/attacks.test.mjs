// Regression tests for the attacks found in the independent review of v4, run against a
// small in-process fake of Arc's JSON-RPC (no network).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ARC_ARCHIVE_RPCS = "http://mock-archive";
process.env.ARC_RECENT_RPCS = "http://mock-recent";
process.env.CHECKER_CACHE_FILE = (await import("node:os")).tmpdir() + `/paid-reviews-attacks-${process.pid}.json`;

const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
const hex = (n) => "0x" + BigInt(n).toString(16);
const low = (a) => a.toLowerCase();

/// Fake chain: nonces from `sentBlocks`, balances derived from the transfer logs (so a
/// transfer moves balances even when no nonce moves, like an ERC-20 transferFrom), eth_call
/// answers from `calls` (by block), HTTP answers from `http`.
const chain = { head: 0, sentBlocks: {}, logs: [], calls: {}, http: {}, code: {} };
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (!url.startsWith("http://mock")) {
    const body = chain.http[url];
    return body == null ? new Response("nope", { status: 404 }) : new Response(body, { status: 200 });
  }
  const { method, params } = JSON.parse(init.body);
  const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  const err = (message, code = -32602) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } }), { status: 200 });
  const blockOf = (p) => (p === "latest" ? chain.head : Number(BigInt(p)));
  switch (method) {
    case "eth_blockNumber":
      return ok(hex(chain.head));
    case "eth_getTransactionCount": {
      const b = blockOf(params[1]);
      return ok(hex((chain.sentBlocks[low(params[0])] || []).filter((x) => x <= b).length));
    }
    case "eth_getBalance": {
      const a = low(params[0]);
      const b = blockOf(params[1]);
      let bal = 0n;
      for (const l of chain.logs) {
        if (l.block > b) continue;
        if (low(l.to) === a) bal += l.value;
        if (low(l.from) === a) bal -= l.value;
      }
      return ok(hex(bal < 0n ? 0n : bal));
    }
    case "eth_getCode":
      return ok(chain.code[low(params[0])] || "0x");
    case "eth_getBlockByNumber":
      return ok({ timestamp: hex(1_700_000_000 + Math.floor(blockOf(params[0]) / 2)) });
    case "eth_getTransactionByHash":
      return ok({ from: chain.logs.find((l) => l.tx === params[0])?.txFrom ?? null });
    case "eth_call": {
      const b = blockOf(params[1]);
      const entry = chain.calls[low(params[0].to + ":" + params[0].data)];
      const v = typeof entry === "function" ? entry(b) : entry;
      return v == null ? err("execution reverted", 3) : ok(v);
    }
    case "eth_getLogs": {
      const f = params[0];
      const lo = Number(BigInt(f.fromBlock));
      const hi = Number(BigInt(f.toBlock));
      if (hi > chain.head) return err("block range extends beyond current head block");
      if (url.includes("recent") && lo < chain.head - 700_000) return err("pruned history unavailable", 4444);
      const match = (t, v) => t == null || (Array.isArray(t) ? t.includes(v) : t === v);
      const [, t1, t2] = f.topics || [];
      return ok(
        chain.logs
          .map((l, i) => ({ ...l, i }))
          .filter((l) => l.block >= lo && l.block <= hi && match(t1, pad(l.from)) && match(t2, pad(l.to)))
          .map((l) => ({
            address: "0xfffffffffffffffffffffffffffffffffffffffe",
            topics: [TOPIC, pad(l.from), pad(l.to)],
            data: hex(l.value),
            blockNumber: hex(l.block),
            logIndex: hex(l.i),
            transactionHash: l.tx,
          })),
      );
    }
    default:
      throw new Error("mock: unhandled " + method);
  }
};

const { inboundTransfers, sentTransfers } = await import("../src/chain.mjs");
const { checkPayerAgent } = await import("../src/facts.mjs");
const viem = await import("viem");
const { IDENTITY } = await import("../src/config.mjs");

let n = 0;
const addr = () => "0x" + (++n).toString(16).padStart(40, "a");
const tx = () => "0x" + (++n).toString(16).padStart(64, "0");

test("review finding 2: money pulled from the owner by transferFrom (no owner nonce) is seen", async () => {
  const OWNER = addr();
  const SOCK = addr();
  const RELAYER = addr();
  chain.head = 20_000_000;
  const payBlock = 19_999_000;
  chain.sentBlocks[low(OWNER)] = [payBlock - 5_000_000]; // the approve happened long ago
  chain.logs.push({ from: OWNER, to: SOCK, value: 10n ** 19n, block: payBlock - 1_000_000, tx: tx(), txFrom: RELAYER });
  const seenBySenderWalk = await sentTransfers({ senders: [OWNER], to: SOCK, fromBlock: payBlock - 1_700_000, toBlock: payBlock });
  const inbound = await inboundTransfers({ addr: SOCK, fromBlock: payBlock - 3_000_000, toBlock: payBlock });
  assert.equal(seenBySenderWalk.length, 0, "the old sender-nonce walk misses it");
  assert.equal(inbound.length, 1, "the inbound scan finds it");
  assert.equal(low(inbound[0].from), low(OWNER), "and names the debited owner");
});

test("inbound scan finds transfers in both the recent window and older history", async () => {
  const FROM_A = addr();
  const FROM_B = addr();
  const W = addr();
  chain.head = 20_000_000;
  chain.logs.push({ from: FROM_A, to: W, value: 5n, block: chain.head - 100, tx: tx() });
  chain.logs.push({ from: FROM_B, to: W, value: 7n, block: chain.head - 2_500_000, tx: tx() });
  const got = await inboundTransfers({ addr: W, fromBlock: chain.head - 3_000_000, toBlock: chain.head - 10 });
  assert.deepEqual(got.map((t) => low(t.from)), [low(FROM_B), low(FROM_A)]);
});

test("review finding 1: a shared host and a new registration earn no identity or domain point", async () => {
  const SOCK = addr();
  const abi = viem.parseAbi([
    "function ownerOf(uint256) view returns (address)",
    "function getAgentWallet(uint256) view returns (address)",
    "function tokenURI(uint256) view returns (string)",
  ]);
  const URI = "https://raw.githubusercontent.com/anyone/sock/main/agent.json";
  const key = (fn) => low(IDENTITY + ":" + viem.encodeFunctionData({ abi, functionName: fn, args: [77n] }));
  const payBlock = 19_000_000;
  const registeredAt = payBlock - 1000; // registered minutes before paying
  chain.calls[key("ownerOf")] = (b) => (b >= registeredAt ? viem.encodeFunctionResult({ abi, functionName: "ownerOf", result: SOCK }) : null);
  chain.calls[key("getAgentWallet")] = viem.encodeFunctionResult({ abi, functionName: "getAgentWallet", result: SOCK });
  chain.calls[key("tokenURI")] = viem.encodeFunctionResult({ abi, functionName: "tokenURI", result: URI });
  chain.http[URI] = JSON.stringify({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Totally Independent Buyer",
    services: [{ name: "web", endpoint: "https://raw.githubusercontent.com/anyone/sock/main/x" }],
  });
  const pa = await checkPayerAgent(77, SOCK, payBlock);
  assert.equal(pa.controls, true);
  assert.equal(pa.validRegistration, true);
  assert.equal(pa.agedRegistration, false, "registered too recently");
  assert.equal(pa.domains[0].verified, false, "a shared host proves nothing");
});

test("review finding 4: the newest candidate recipients are the same whichever endpoint served them", async () => {
  // Payer sends to 8 recipients spread over 2.4M blocks; the checker keeps the newest 6.
  const P = addr();
  const recips = Array.from({ length: 8 }, addr);
  const payBlock = 18_000_000;
  const blocks = recips.map((_, i) => payBlock - 50_000 - i * 300_000);
  chain.sentBlocks[low(P)] = [...blocks].sort((a, b) => a - b);
  recips.forEach((r, i) => chain.logs.push({ from: P, to: r, value: 10n ** 17n, block: blocks[i], tx: tx() }));
  const newest = (ts) => [...new Set([...ts].sort((x, y) => y.block - x.block || y.logIndex - x.logIndex).map((t) => low(t.to)))].slice(0, 6);
  const stop = (ts) => new Set(ts.map((t) => t.to)).size >= 6;

  chain.head = payBlock + 5; // the recent endpoint covers the newest 500k blocks
  const a = await sentTransfers({ senders: [P], fromBlock: payBlock - 2_600_000, toBlock: payBlock, stop });
  await new Promise((r) => setTimeout(r, 1_700)); // let the cached head expire
  chain.head = payBlock + 3_000_000; // now everything is old history
  const b = await sentTransfers({ senders: [P], fromBlock: payBlock - 2_600_000, toBlock: payBlock, stop });
  assert.deepEqual(newest(a), newest(b));
  assert.deepEqual(newest(a), recips.slice(0, 6).map(low));
});

test("age search finds the exact first block with launch narrowing and caller hints", async () => {
  const { firstActivityBlock } = await import("../src/chain.mjs");
  chain.head = 24_000_000;
  const cases = [
    { first: 22_345_678, hints: {} }, // after launch: searched from the launch block
    { first: 22_345_679, hints: { knownActive: 23_000_000 } }, // caller knows it was active then
    { first: 5_000_123, hints: {} }, // a pre-launch wallet: searched from genesis
    { first: 23_500_001, hints: { knownInactive: 23_400_000, knownActive: 23_600_000 } },
  ];
  for (const c of cases) {
    const w = addr();
    chain.logs.push({ from: addr(), to: w, value: 1n, block: c.first, tx: tx() });
    assert.equal(await firstActivityBlock(w, chain.head - 10, c.hints), c.first);
  }
});
