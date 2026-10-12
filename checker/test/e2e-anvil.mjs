// End-to-end test on a local anvil fork of Arc mainnet. No real keys, no mainnet
// transactions: accounts are impersonated on the fork and the checker key is generated
// in memory for this run only.
//
// Real mainnet wallets play the roles, so the checker works on their real Arc history:
//   OWNER  a real wallet that registers the agent (locally)
//   SOCK   a real wallet whose first funder was OWNER  -> must be rejected
//   HONEST a real wallet with no link to OWNER          -> scored on its real history
//
// The checker reads history straight from Arc's real endpoints with its normal routing
// (as it would in production). Only reads that concern the fork go to anvil: the
// locally deployed gate, the IdentityRegistry (the agent is registered locally), the
// head block, and blocks the fork created.
//
//   anvil --fork-url https://rpc.mainnet.arc.io --chain-id 5042 --port 8545
//   OWNER=0x.. SOCK=0x.. HONEST=0x.. node test/e2e-anvil.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ANVIL = process.env.ANVIL_URL || "http://127.0.0.1:8545";
process.env.CHECKER_CACHE_FILE = join(tmpdir(), `paid-reviews-e2e-cache-${Date.now()}.json`);

// Route fork-specific JSON-RPC calls from the checker to anvil.
const forkRouting = { gate: null, forkBlock: Infinity };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://") && init?.body) {
    try {
      const { method, params } = JSON.parse(init.body);
      const lowerTo = (params?.[0]?.to ?? params?.[0]?.address ?? "").toLowerCase();
      const blockParam = method === "eth_getBlockByNumber" ? params[0] : params?.[1];
      const blockNum = typeof blockParam === "string" && blockParam.startsWith("0x") ? Number(BigInt(blockParam)) : null;
      const local =
        method === "eth_blockNumber" ||
        lowerTo === IDENTITY_LOWER ||
        (forkRouting.gate && lowerTo === forkRouting.gate) ||
        (method === "eth_getBlockByNumber" && blockNum > forkRouting.forkBlock);
      if (local) return realFetch(ANVIL, init);
      // Wallet state at a fork block equals real state at the fork point (the test's own
      // payments do not affect any check), so read it from the real endpoint there.
      if (blockNum != null && blockNum > forkRouting.forkBlock && ["eth_getBalance", "eth_getTransactionCount", "eth_getCode"].includes(method)) {
        const p = [...params];
        p[1] = "0x" + forkRouting.forkBlock.toString(16);
        return realFetch(url, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), params: p }) });
      }
    } catch {
      // not JSON-RPC: pass through
    }
  }
  return realFetch(url, init);
};
const IDENTITY_LOWER = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";

const {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  parseAbi,
  parseEther,
} = await import("viem");
const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
const { IDENTITY, REPUTATION } = await import("../src/config.mjs");
const { gatherFacts } = await import("../src/facts.mjs");
const { buildReport, reportHash } = await import("../src/report.mjs");
const { permitTypedData, verifyAgainstGate } = await import("../src/sign.mjs");
const { archive, recent } = await import("../src/rpc.mjs");
const callCounts = () => `archive ${archive.stats.calls} calls (${archive.stats.retries} retries), recent ${recent?.stats.calls ?? 0}`;

const HERE = dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(readFileSync(join(HERE, "..", "..", "out", "PaidReviews.sol", "PaidReviews.json"), "utf8"));

const OWNER = getAddress(process.env.OWNER);
const SOCK = getAddress(process.env.SOCK);
const HONEST = getAddress(process.env.HONEST);
const DEPLOYER = getAddress("0x00000000000000000000000000000000DeADBEEF");

const chain = { id: 5042, name: "arc-fork", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [ANVIL] } } };
const transport = http(ANVIL, { timeout: 120_000 });
const pub = createPublicClient({ chain, transport });
const test = createTestClient({ chain, transport, mode: "anvil" });
const wallet = createWalletClient({ chain, transport });

const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);
const gateAbi = artifact.abi;

async function send(from, request) {
  const hash = await wallet.writeContract({ ...request, account: from, chain });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  return rcpt;
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

// ---------------------------------------------------------------- setup
for (const a of [DEPLOYER, OWNER, SOCK, HONEST]) {
  await test.impersonateAccount({ address: a });
}
// Fund only what the local transactions need. Balance changes on the fork do not
// change the wallets' real (pre-fork) history that the checker reads.
for (const a of [DEPLOYER, OWNER, SOCK, HONEST]) {
  const bal = await pub.getBalance({ address: a });
  await test.setBalance({ address: a, value: bal + parseEther("10") });
}
// Some real Arc EOAs carry EIP-7702 delegations; clear code so impersonated sends work.
for (const a of [OWNER, SOCK, HONEST]) await test.setCode({ address: a, bytecode: "0x" });

const checker = privateKeyToAccount(generatePrivateKey());
const deployHash = await wallet.deployContract({
  abi: gateAbi,
  bytecode: artifact.bytecode.object,
  args: [IDENTITY, REPUTATION, 10n ** 16n, checker.address, 7],
  account: DEPLOYER,
  chain,
});
const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
const gate = deployRcpt.contractAddress;
const deployBlock = Number(deployRcpt.blockNumber);
forkRouting.gate = gate.toLowerCase();
forkRouting.forkBlock = deployBlock - 1; // the deploy is the fork's first local transaction
console.log(`gate ${gate} deployed in block ${deployBlock} (fork of Arc mainnet)`);

const regRcpt = await send(OWNER, {
  address: IDENTITY,
  abi: identityAbi,
  functionName: "register",
  args: ['data:application/json,{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1","name":"e2e agent"}'],
});
const reg = regRcpt.logs
  .filter((l) => l.address.toLowerCase() === IDENTITY.toLowerCase())
  .map((l) => {
    try {
      return decodeEventLog({ abi: identityAbi, data: l.data, topics: l.topics });
    } catch {
      return null;
    }
  })
  .find((e) => e && e.eventName === "Transfer");
const agentId = reg.args.tokenId;
console.log(`agent ${agentId} registered by OWNER ${OWNER}`);

// ---------------------------------------------------------------- payments
const pay = async (from) => {
  const r = await send(from, { address: gate, abi: gateAbi, functionName: "pay", args: [agentId], value: 10n ** 16n });
  const ev = r.logs.map((l) => {
    try {
      return decodeEventLog({ abi: gateAbi, data: l.data, topics: l.topics });
    } catch {
      return null;
    }
  }).find((e) => e && e.eventName === "Paid");
  return ev.args;
};
const sockPaid = await pay(SOCK);
const honestPaid = await pay(HONEST);
check("Instant payout reached the owner", sockPaid.instant === true && honestPaid.instant === true);

// ---------------------------------------------------------------- checker
async function scoreAndSign(receiptId) {
  const t0 = Date.now();
  const facts = await gatherFacts({ gate, deployBlock, receiptId });
  const report = buildReport(facts, 7);
  const hash = reportHash(report);
  const ms = Date.now() - t0;
  const now = Number((await pub.getBlock()).timestamp);
  const td = permitTypedData(gate, {
    receiptId,
    payer: report.payer,
    agentId: report.agentId,
    trustScore: report.trustScore,
    reportHash: hash,
    deadline: now + 3600,
  });
  const signature = await checker.signTypedData(td);
  await verifyAgainstGate(gate, td, signature);
  console.log(`       phases (ms): ${JSON.stringify(facts.timings)}`);
  return { report, hash, td, signature, ms };
}

const summary = (r) =>
  r.signals.map((s) => `${s.id}=${s.hard ? (s.pass ? "pass" : "FAIL") : s.points}`).join(" ");

const sock = await scoreAndSign(sockPaid.receiptId);
console.log(`SOCK   score ${sock.report.trustScore}/10 in ${sock.ms} ms: ${summary(sock.report)}`);
console.log(`       ${callCounts()}`);
check("checker links the sock to the owner (hard fail, score 0)", sock.report.trustScore === 0 && sock.report.hardFails.includes("independent-funding"));

const honest = await scoreAndSign(honestPaid.receiptId);
console.log(`HONEST score ${honest.report.trustScore}/10 in ${honest.ms} ms: ${summary(honest.report)}`);
console.log(`       ${callCounts()}`);
check("honest payer has no hard fail", honest.report.hardFails.length === 0);

// ---------------------------------------------------------------- reviews on the gate
async function tryReview(from, rid, s) {
  try {
    await pub.simulateContract({
      address: gate,
      abi: gateAbi,
      functionName: "review",
      args: [rid, 90n, "e2e", "", "0x" + "0".repeat(64), { trustScore: s.td.message.trustScore, reportHash: s.hash, deadline: s.td.message.deadline }, s.signature],
      account: from,
    });
    await send(from, {
      address: gate,
      abi: gateAbi,
      functionName: "review",
      args: [rid, 90n, "e2e", "", "0x" + "0".repeat(64), { trustScore: s.td.message.trustScore, reportHash: s.hash, deadline: s.td.message.deadline }, s.signature],
    });
    return "ok";
  } catch (e) {
    return (e.shortMessage || e.message).split("\n")[0] + " " + (e.cause?.data?.errorName || e.cause?.reason || "");
  }
}

const sockReview = await tryReview(SOCK, sockPaid.receiptId, sock);
check("the gate rejects the sock's review", sockReview !== "ok" && /TrustScoreTooLow/.test(sockReview), sockReview);

const honestReview = await tryReview(HONEST, honestPaid.receiptId, honest);
if (honest.report.eligible) check("the gate accepts the honest review", honestReview === "ok", honestReview);
else check("the gate rejects a below-threshold honest review", /TrustScoreTooLow/.test(honestReview), `score ${honest.report.trustScore}`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
