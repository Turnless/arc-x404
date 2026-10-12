// Reads from Arc: contract calls, historical state, native USDC transfers, and the
// facts derived from them (first activity, first funder, hub detection). Immutable
// facts are cached on disk so repeated scoring is fast.
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, pad, parseAbi } from "viem";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAIN_ID, IDENTITY, NATIVE_TRANSFER_EMITTER, RPC, RULES, TRANSFER_TOPIC, ZERO } from "./config.mjs";
import { archive, getLogs, headBlock } from "./rpc.mjs";

export const IDENTITY_ABI = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
]);

export const GATE_ABI = parseAbi([
  "function receipts(uint256) view returns (address payer, uint256 agentId, uint256 amount, bool reviewed)",
  "function checker() view returns (address)",
  "function minTrustScore() view returns (uint8)",
  "function identity() view returns (address)",
  "function permitDigest(uint256 receiptId, address payer, uint256 agentId, (uint8 trustScore, bytes32 reportHash, uint64 deadline) permit) view returns (bytes32)",
  "event Paid(uint256 indexed receiptId, uint256 indexed agentId, address indexed payer, address payee, uint256 amount, bool instant)",
  "event Withdrawn(address indexed account, address indexed to, uint256 amount)",
]);

const hex = (n) => "0x" + BigInt(n).toString(16);
export const lower = (a) => (a ? a.toLowerCase() : a);
const topicAddr = (a) => pad(lower(a), { size: 32 });
const addrFromTopic = (t) => getAddress("0x" + t.slice(26));

// ---------------------------------------------------------------- disk cache for immutable facts

// v2: first-funder records carry the funding transaction's sender ("initiator").
const CACHE_FILE =
  process.env.CHECKER_CACHE_FILE || join(dirname(fileURLToPath(import.meta.url)), "..", "cache", `facts-v3-${CHAIN_ID}.json`);
let cache = null;
function loadCache() {
  if (cache) return cache;
  try {
    cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};
  } catch {
    cache = {};
  }
  return cache;
}
function saveCache() {
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
}
async function cached(key, fn) {
  const c = loadCache();
  if (key in c) return c[key];
  const v = await fn();
  c[key] = v;
  saveCache();
  return v;
}

// ---------------------------------------------------------------- calls and state

export async function readContract(address, abi, functionName, args = [], block = "latest") {
  const data = encodeFunctionData({ abi, functionName, args });
  const tag = block === "latest" ? "latest" : hex(block);
  const result = await archive.request("eth_call", [{ to: address, data }, tag]);
  return decodeFunctionResult({ abi, functionName, data: result });
}

export async function blockTimestamp(block) {
  return cached(`ts:${block}`, async () => {
    const b = await archive.request("eth_getBlockByNumber", [hex(block), false]);
    return Number(BigInt(b.timestamp));
  });
}

// Historical state never changes, so reads are memoised for the life of the process.
const memo = new Map();
function remember(key, fn) {
  if (!memo.has(key)) memo.set(key, fn().catch((e) => (memo.delete(key), Promise.reject(e))));
  return memo.get(key);
}
export function nonceAt(addr, block) {
  if (block < 0) return Promise.resolve(0n);
  return remember(`n:${lower(addr)}:${block}`, async () =>
    BigInt(await archive.request("eth_getTransactionCount", [addr, hex(block)])),
  );
}
export function balanceAt(addr, block) {
  return remember(`b:${lower(addr)}:${block}`, async () =>
    BigInt(await archive.request("eth_getBalance", [addr, hex(block)])),
  );
}
async function codeAt(addr, block = "latest") {
  return archive.request("eth_getCode", [addr, block === "latest" ? "latest" : hex(block)]);
}

/// True if `addr` had a balance or had sent a transaction by `block`.
export async function activeAt(addr, block) {
  if (block < 0) return false;
  const [n, bal] = await Promise.all([nonceAt(addr, block), balanceAt(addr, block)]);
  return n > 0n || bal > 0n;
}

/// First block at which `addr` had a balance or had sent a transaction, searched up to
/// `upTo`. Null if the address was never active by then. Binary search over archive
/// state: an EOA cannot lose its balance without sending a transaction (which raises
/// its nonce), so "nonce > 0 or balance > 0" only switches from false to true once.
/// `knownActive` / `knownInactive` are blocks the caller already checked, which narrow
/// the search; a wallet not active at Arc's launch is searched only after it.
export async function firstActivityBlock(addr, upTo, { knownActive = null, knownInactive = -1 } = {}) {
  const key = `first:${lower(addr)}`;
  const c = loadCache();
  if (c[key] != null && c[key] <= upTo) return c[key];
  const active = (b) => activeAt(addr, b);
  let hi = upTo;
  if (knownActive != null && knownActive < upTo) hi = knownActive;
  else if (!(await active(upTo))) return null;
  let start = knownInactive + 1;
  if (start <= RULES.launchBlock && RULES.launchBlock < hi && !(await active(RULES.launchBlock))) {
    start = RULES.launchBlock + 1;
  }
  // 4-way search: three probes per round in parallel.
  const lo = await searchFirstTrue(start, hi, active);
  c[key] = lo;
  saveCache();
  return lo;
}

/// Smallest b in [lo, hi] with pred(b) true, given pred(hi) is true and pred only
/// switches from false to true once. Probes three points per round in parallel; the
/// probes always lie in [lo, hi - 1], so every round shrinks the range.
export async function searchFirstTrue(lo, hi, pred) {
  while (lo < hi) {
    const span = hi - lo;
    const probes = [...new Set([1, 2, 3].map((k) => lo + Math.floor((span * k) / 4)))];
    const res = await Promise.all(probes.map(pred));
    const k = res.indexOf(true);
    if (k === -1) lo = probes.at(-1) + 1;
    else {
      if (k > 0) lo = probes[k - 1] + 1;
      hi = probes[k];
    }
  }
  return lo;
}

/// Native USDC transfers. `from` / `to` may each be an address, a list of addresses
/// (any of them) or null (anyone).
export async function transfers({ from = null, to = null, fromBlock, toBlock, stop }) {
  const t = (x) => (x == null ? null : Array.isArray(x) ? x.map(topicAddr) : topicAddr(x));
  const logs = await getLogs(
    { address: NATIVE_TRANSFER_EMITTER, topics: [TRANSFER_TOPIC, t(from), t(to)] },
    fromBlock,
    toBlock,
    stop ? { stop: (raw) => stop(raw.map(decodeTransfer)) } : {},
  );
  return logs.map(decodeTransfer);
}

/// Guided scan for native transfers matching `from` / `to` in [fromBlock, toBlock],
/// newest first. `stateAt(b)` summarises account state at block b as { key, n }: a
/// range whose key did not change cannot hold a matching transfer and is skipped for one
/// state read; n (a transaction count) estimates how busy a range is, and busy ranges
/// are read directly instead of being split. The last few days come straight from the
/// recent endpoint in large ranges. Logs are returned oldest first by (block, logIndex).
async function guidedTransfers({ from = null, to = null, fromBlock, toBlock, stateAt, stop }) {
  if (toBlock < fromBlock) return [];
  const leaf = 10_000;
  const out = [];
  let stopped = false;
  const check = () => {
    if (!stopped && stop && stop(out)) stopped = true;
  };
  async function read(lo, hi, viaRecent) {
    if (viaRecent) out.push(...(await transfers({ from, to, fromBlock: lo, toBlock: hi })));
    else
      for (let t = hi; t >= lo && !stopped; t -= leaf) {
        out.push(...(await transfers({ from, to, fromBlock: Math.max(lo, t - leaf + 1), toBlock: t })));
        check();
      }
    check();
  }
  async function walk(lo, hi, sLo, sHi) {
    if (stopped || sLo.key === sHi.key) return;
    const slices = Math.ceil((hi - lo + 1) / leaf);
    if (slices === 1 || Number(sHi.n - sLo.n) * 2 >= slices) return read(lo, hi, false);
    const mid = lo + Math.ceil(slices / 2) * leaf - 1;
    const sMid = await stateAt(mid);
    await walk(mid + 1, hi, sMid, sHi);
    await walk(lo, mid, sLo, sMid);
  }
  const recentFrom = Math.max(fromBlock, (await headBlock()) - RPC.recentWindow + 1);
  const [sStart, sRecent, sEnd] = await Promise.all([stateAt(fromBlock - 1), stateAt(recentFrom - 1), stateAt(toBlock)]);
  if (RPC.recent.length && recentFrom <= toBlock) {
    if (sEnd.key !== sRecent.key) await read(recentFrom, toBlock, true);
    if (!stopped && recentFrom > fromBlock) await walk(fromBlock, recentFrom - 1, sStart, sRecent);
  } else {
    await walk(fromBlock, toBlock, sStart, sEnd);
  }
  return out.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
}

/// Native transfers sent by `senders` (EOAs). An EOA's nonce only moves in blocks where
/// it sent a transaction, so quiet ranges are skipped. Limit: a debit the sender did not
/// send itself (an ERC-20 transferFrom by an approved spender, or EIP-7702 code run by
/// someone else) does not move its nonce and can be missed; for the history signal that
/// only undercounts.
export async function sentTransfers({ senders, to = null, fromBlock, toBlock, stop }) {
  if (senders.length === 0) return [];
  const stateAt = async (b) => {
    const n = (await Promise.all(senders.map((x) => nonceAt(x, b)))).reduce((acc, v) => acc + v, 0n);
    return { key: String(n), n };
  };
  return guidedTransfers({ from: senders, to, fromBlock, toBlock, stateAt, stop });
}

/// Every native transfer into `addr`, from anyone and by any route (a direct send, a
/// contract call, an ERC-20 transferFrom on the USDC interface, EIP-7702 code): Arc logs
/// all of them with the debited account as `from`. A range where neither the account's
/// nonce nor its balance changed cannot hold an incoming transfer and is skipped.
export async function inboundTransfers({ addr, fromBlock, toBlock }) {
  const stateAt = async (b) => {
    const [n, bal] = await Promise.all([nonceAt(addr, b), balanceAt(addr, b)]);
    return { key: n + ":" + bal, n };
  };
  return guidedTransfers({ to: addr, fromBlock, toBlock, stateAt });
}

/// True for an externally owned account (including EIP-7702 delegated EOAs).
export async function isEoa(addr, block) {
  const code = await codeAt(addr, block);
  return !code || code === "0x" || code.toLowerCase().startsWith("0xef0100");
}

function decodeTransfer(l) {
  return {
    from: addrFromTopic(l.topics[1]),
    to: addrFromTopic(l.topics[2]),
    value: BigInt(l.data),
    block: Number(BigInt(l.blockNumber)),
    logIndex: Number(BigInt(l.logIndex)),
    tx: l.transactionHash,
  };
}

/// Who first sent `addr` native USDC: the sender of the earliest transfer in the block
/// where `addr` first became active. `null` if that block holds no transfer to it.
export async function firstFunder(addr, upTo, hints = {}) {
  const key = `funder:${lower(addr)}`;
  const c = loadCache();
  if (key in c) return c[key];
  const first = await firstActivityBlock(addr, upTo, hints);
  if (first == null) return null;
  const ins = await transfers({ to: addr, fromBlock: first, toBlock: first });
  let funder = null;
  if (ins.length) {
    // The account that sent the funding transaction. It differs from the transfer's
    // sender when the money came through a contract (a forwarder, router or bridge).
    const tx = await archive.request("eth_getTransactionByHash", [ins[0].tx]);
    funder = { address: ins[0].from, block: first, tx: ins[0].tx, initiator: tx?.from ? getAddress(tx.from) : null };
  }
  // Only a found funder is cached: a bad RPC answer must not persist across runs.
  if (funder) {
    c[key] = funder;
    saveCache();
  }
  return funder;
}

/// A hub is an address that funds many unrelated wallets: the mint (zero address), a
/// contract (bridge, gateway, exchange contract), or an established busy wallet (an
/// exchange hot wallet). A shared hub is not evidence of a link. Judged at the block of
/// the funding it is asked about, and a busy wallet must also have been active for
/// RULES.hubMinAgeDays by then: pushing a personal wallet past the transaction count
/// just before funding socks does not make it a hub. EIP-7702 delegated EOAs (code
/// 0xef0100...) are treated as wallets.
export async function hubKind(addr, block) {
  if (!addr || lower(addr) === ZERO) return "mint";
  return cached(`hub2:${lower(addr)}:${block}`, async () => {
    const code = await codeAt(addr, block);
    if (code && code !== "0x" && !code.toLowerCase().startsWith("0xef0100")) return "contract";
    const n = await nonceAt(addr, block);
    if (n <= BigInt(RULES.hubNonce)) return null;
    const aged = await activeAt(addr, block - RULES.hubMinAgeDays * RULES.blocksPerDay);
    return aged ? "busy-wallet" : null;
  });
}

/// Follows first funders back `hops` steps. Each step's `identity` is who is really
/// behind the funding: the funder itself if it is a personal wallet, otherwise (money
/// sent through a contract) the personal wallet that sent the funding transaction.
/// The chain stops at a hub (exchange, bridge relayer, mint) or an unknown funder.
export async function funderChain(addr, upTo, hops = RULES.funderHops, hints = {}) {
  const chain = [];
  let cur = addr;
  for (let i = 0; i < hops; i++) {
    const f = await firstFunder(cur, upTo, i === 0 ? hints : {});
    if (!f) break;
    const hub = await hubKind(f.address, f.block);
    let identity = hub ? null : f.address;
    let initiatorHub = null;
    if (hub === "contract" && f.initiator && lower(f.initiator) !== lower(f.address)) {
      initiatorHub = await hubKind(f.initiator, f.block);
      if (!initiatorHub) identity = f.initiator;
    }
    chain.push({ ...f, hub, initiatorHub, identity });
    if (!identity) break;
    cur = identity;
  }
  return chain;
}

// ---------------------------------------------------------------- gate events

export async function gateEvents(gate, deployBlock, toBlock) {
  const logs = await getLogs({ address: gate }, deployBlock, toBlock);
  const out = [];
  for (const l of logs) {
    try {
      const ev = decodeEventLog({ abi: GATE_ABI, data: l.data, topics: l.topics });
      out.push({ ...ev, block: Number(BigInt(l.blockNumber)), tx: l.transactionHash });
    } catch {
      // other events (PaidReview, ReviewTrust, ...) are not needed by the checker
    }
  }
  return out;
}

// ---------------------------------------------------------------- agent registration

export async function agentRecord(agentId, block) {
  const [owner, wallet] = await Promise.all([
    readContract(IDENTITY, IDENTITY_ABI, "ownerOf", [BigInt(agentId)], block),
    readContract(IDENTITY, IDENTITY_ABI, "getAgentWallet", [BigInt(agentId)], block).catch(() => ZERO),
  ]);
  return { owner: getAddress(owner), wallet: lower(wallet) === ZERO ? null : getAddress(wallet) };
}

/// HTTPS only, no redirects, at most RULES.httpMaxBytes.
export async function fetchText(url) {
  if (!url.startsWith("https://")) throw new Error("https only");
  const res = await fetch(url, { signal: AbortSignal.timeout(RULES.httpTimeoutMs), redirect: "error" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > RULES.httpMaxBytes) throw new Error("response too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > RULES.httpMaxBytes) throw new Error("response too large");
  return buf.toString("utf8");
}

/// Resolves an agentURI (data:, https:, ipfs:) to its JSON.
export async function loadRegistration(uri) {
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    const meta = uri.slice(5, comma);
    const body = uri.slice(comma + 1);
    const text = meta.endsWith(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
    return JSON.parse(text);
  }
  if (uri.startsWith("ipfs://")) return JSON.parse(await fetchText("https://ipfs.io/ipfs/" + uri.slice(7)));
  if (uri.startsWith("https://")) return JSON.parse(await fetchText(uri));
  throw new Error("unsupported agentURI scheme");
}
