#!/usr/bin/env node
// PaidReviews trust checker.
//
//   node src/cli.mjs score <receiptId> [--payer-agent <id>] [--sign] [--account arc-checker] [--ttl 3600]
//   node src/cli.mjs watch [--from-block <n>]
//   node src/cli.mjs wallet <address> [--at <block>]
//
// Reads GATE, GATE_DEPLOY_BLOCK and ARC_NETWORK from the environment or ../.env.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

// Minimal .env loader (KEY=VALUE lines); real environment variables win.
const envFile = join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env) && m[2] !== "") process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// Imported after the env is loaded, because config reads ARC_NETWORK.
const { CHAIN_ID, NETWORK_NAME, RULES } = await import("./config.mjs");
const { GATE_ABI, blockTimestamp, firstActivityBlock, funderChain, gateEvents, readContract } = await import("./chain.mjs");
const { gatherFacts } = await import("./facts.mjs");
const { buildReport, reportHash } = await import("./report.mjs");
const { permitTypedData, signWithKeystore, verifyAgainstGate } = await import("./sign.mjs");
const { headBlock } = await import("./rpc.mjs");

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (environment or ../.env)`);
  return v;
}

const replacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

function printReport(report, ms) {
  console.log(`\nReceipt ${report.receiptId}  payer ${report.payer}  agent ${report.agentId}  (${NETWORK_NAME}, ${ms} ms)`);
  for (const s of report.signals) {
    const mark = s.hard ? (s.pass ? "pass" : "FAIL") : `${s.points}/${s.max}`;
    console.log(`  ${mark.padEnd(5)} ${s.label}`);
  }
  console.log(
    `  trust score ${report.trustScore}/${report.maxScore}` +
      (report.hardFails.length ? `  (hard fail: ${report.hardFails.join(", ")})` : "") +
      `  -> ${report.eligible ? "may review" : `may NOT review (needs ${report.minTrustScore})`}`,
  );
}

async function scoreReceipt(receiptId, { payerAgentId, quiet = false } = {}) {
  const gate = need("GATE");
  const deployBlock = Number(need("GATE_DEPLOY_BLOCK"));
  const t0 = Date.now();
  const facts = await gatherFacts({
    gate,
    deployBlock,
    receiptId,
    payerAgentId,
    log: quiet ? () => {} : (m) => console.log(m),
  });
  const minTrust = Number(await readContract(gate, GATE_ABI, "minTrustScore", []));
  const report = buildReport(facts, minTrust);
  const hash = reportHash(report);
  const ms = Date.now() - t0;
  const dir = join(HERE, "..", "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `receipt-${receiptId}.json`), JSON.stringify({ reportHash: hash, report, facts }, replacer, 2));
  return { report, hash, ms, gate };
}

async function cmdScore() {
  const receiptId = args[1];
  if (!receiptId) throw new Error("usage: score <receiptId>");
  const payerAgentId = opt("payer-agent");
  const { report, hash, ms, gate } = await scoreReceipt(receiptId, { payerAgentId });
  printReport(report, ms);
  console.log(`  report hash ${hash}  (checker/reports/receipt-${receiptId}.json)`);
  if (!flag("sign")) return;

  const ttl = Number(opt("ttl", "3600"));
  const deadline = BigInt((await blockTimestamp(await headBlock())) + ttl);
  const td = permitTypedData(gate, {
    receiptId,
    payer: report.payer,
    agentId: report.agentId,
    trustScore: report.trustScore,
    reportHash: hash,
    deadline,
  });
  const account = opt("account", "arc-checker");
  console.log(`\nSigning permit with keystore '${account}' (cast will ask for its password)...`);
  const signature = signWithKeystore(td, account);
  const { digest, signer } = await verifyAgainstGate(gate, td, signature);

  const permitsDir = join(ROOT, "permits");
  mkdirSync(permitsDir, { recursive: true });
  const out = {
    receiptId: Number(receiptId),
    payer: report.payer,
    agentId: report.agentId,
    chainId: CHAIN_ID,
    gate,
    permit: { trustScore: report.trustScore, reportHash: hash, deadline: deadline.toString() },
    signature,
    digest,
    signer,
    eligible: report.eligible,
  };
  writeFileSync(join(permitsDir, `receipt-${receiptId}.json`), JSON.stringify(out, null, 2));
  console.log(`Permit verified against the gate (signer ${signer}) -> permits/receipt-${receiptId}.json`);
  console.log(`\nThe payer can now review with:\n`);
  console.log(
    `cast send ${gate} "review(uint256,int128,string,string,bytes32,(uint8,bytes32,uint64),bytes)" ${receiptId} <score 0-100> "<tag>" "" 0x${"0".repeat(64)} "(${report.trustScore},${hash},${deadline})" ${signature} --account arc-payer --rpc-url $ARC_RPC_URL`,
  );
  if (!report.eligible) console.log(`\n(This permit's score is below ${report.minTrustScore}; the gate will reject it with TrustScoreTooLow.)`);
}

async function cmdWatch() {
  const gate = need("GATE");
  let from = Number(opt("from-block", process.env.GATE_DEPLOY_BLOCK || "0"));
  console.log(`Watching ${gate} on ${NETWORK_NAME} from block ${from} for payments...`);
  const done = new Set();
  for (;;) {
    try {
      const head = await headBlock();
      if (head >= from) {
        const events = await gateEvents(gate, from, head);
        for (const e of events) {
          if (e.eventName !== "Paid") continue;
          const id = e.args.receiptId.toString();
          if (done.has(id)) continue;
          console.log(`\nPayment seen: receipt ${id} in block ${e.block}. Scoring while the agent works...`);
          const { report, hash, ms } = await scoreReceipt(id, { quiet: true });
          done.add(id); // only after success: a failed check is retried on the next poll
          printReport(report, ms);
          console.log(`  report hash ${hash}`);
        }
        from = head + 1;
      }
    } catch (e) {
      console.error(`watch error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function cmdWallet() {
  const addr = args[1];
  if (!addr) throw new Error("usage: wallet <address> [--at <block>]");
  const at = Number(opt("at", String(await headBlock())));
  const t0 = Date.now();
  const first = await firstActivityBlock(addr, at);
  if (first == null) return console.log(`${addr}: never active up to block ${at}`);
  const [tsFirst, tsAt] = await Promise.all([blockTimestamp(first), blockTimestamp(at)]);
  const chain = await funderChain(addr, at);
  console.log(`${addr} (${NETWORK_NAME})`);
  console.log(`  first active: block ${first} (${new Date(tsFirst * 1000).toISOString()}), age ${((tsAt - tsFirst) / 86400).toFixed(2)} days`);
  for (const f of chain) console.log(`  funded by ${f.address}${f.hub ? ` [${f.hub}]` : ""} in block ${f.block} (${f.tx})`);
  if (!chain.length) console.log("  first funder: unknown");
  console.log(`  (${Date.now() - t0} ms, hubNonce ${RULES.hubNonce})`);
}

const commands = { score: cmdScore, watch: cmdWatch, wallet: cmdWallet };
if (!commands[cmd]) {
  console.log("usage: node src/cli.mjs <score|watch|wallet> ...");
  process.exit(1);
}
commands[cmd]().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
