// Times the checker's slowest steps on mainnet for one wallet, with the real routing:
// wallet age (4-way search over archive state) and the 30-day outgoing history scan
// (nonce-guided).   node test/time-history.mjs <address>
process.env.CHECKER_CACHE_FILE ??= (await import("node:os")).tmpdir() + `/paid-reviews-timing-${Date.now()}.json`;
const { firstActivityBlock, sentTransfers } = await import("../src/chain.mjs");
const { headBlock, archive, recent } = await import("../src/rpc.mjs");
const snap = () => JSON.stringify({ archive: archive.stats, recent: recent?.stats });
const addr = process.argv[2];
const head = await headBlock();

let t0 = Date.now();
const first = await firstActivityBlock(addr, head);
console.log(snap());
console.log(`wallet age search: first active block ${first}, ${Date.now() - t0} ms`);

const window = Math.ceil((30 * 86_400) / 0.507);
for (const early of [true, false]) {
  t0 = Date.now();
  const coverage = {};
  const ts = await sentTransfers({
    coverage,
    senders: [addr],
    fromBlock: Math.max(first, head - window),
    toBlock: head,
    stop: early ? (xs) => new Set(xs.map((t) => t.to.toLowerCase())).size >= 3 : undefined,
  });
  console.log(`history ${early ? "(stop at 3 recipients)" : "(full 30 days)       "}: ${ts.length} transfers to ${new Set(ts.map((t) => t.to)).size} recipients, ${Date.now() - t0} ms, ${coverage.complete ? "complete" : "capped"} (${coverage.txsExamined} sent txs examined)`);
  console.log(snap());
}
