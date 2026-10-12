// Finds a real pair of ordinary wallets on Arc mainnet where OWNER was the first funder
// of SOCK, for the e2e test. A transfer is a wallet's first funding when the wallet had
// zero balance and zero nonce in the block before it.
//   node test/find-funded-pair.mjs
const ARCHIVE = "https://rpc.mainnet.arc.io";
const RECENT = "https://rpc.blockdaemon.mainnet.arc.io";
const EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => "0x" + n.toString(16);

async function rpc(url, method, params, attempt = 0) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json().catch(() => ({ error: { message: "bad response" } }));
  if (body.error) {
    if (attempt < 8) {
      await sleep(300 * 2 ** attempt);
      return rpc(url, method, params, attempt + 1);
    }
    throw new Error(body.error.message);
  }
  return body.result;
}

const isEoa = (code) => code === "0x" || code.toLowerCase().startsWith("0xef0100");

const head = parseInt(await rpc(ARCHIVE, "eth_blockNumber", []), 16);
const logs = await rpc(RECENT, "eth_getLogs", [
  { fromBlock: hex(head - 6_000), toBlock: hex(head - 2_000), address: EMITTER, topics: [TRANSFER] },
]);
console.error(`scanning ${logs.length} recent transfers`);

const seen = new Set();
let tries = 0;
for (const l of logs.sort(() => Math.random() - 0.5)) {
  if (tries > 400) break;
  const from = "0x" + l.topics[1].slice(26);
  const to = "0x" + l.topics[2].slice(26);
  const block = parseInt(l.blockNumber, 16);
  if (from === to || seen.has(to)) continue;
  seen.add(to);
  tries++;
  // cheap pre-filter: wallets that are still new now
  if (BigInt(await rpc(ARCHIVE, "eth_getTransactionCount", [to, "latest"])) > 5n) continue;
  const [nPrev, balPrev] = await Promise.all([
    rpc(ARCHIVE, "eth_getTransactionCount", [to, hex(block - 1)]),
    rpc(ARCHIVE, "eth_getBalance", [to, hex(block - 1)]),
  ]);
  if (BigInt(nPrev) !== 0n || BigInt(balPrev) !== 0n) continue; // not its first funding
  const [codeFrom, nFrom, codeTo, nTo] = await Promise.all([
    rpc(ARCHIVE, "eth_getCode", [from, "latest"]),
    rpc(ARCHIVE, "eth_getTransactionCount", [from, hex(block)]),
    rpc(ARCHIVE, "eth_getCode", [to, "latest"]),
    rpc(ARCHIVE, "eth_getTransactionCount", [to, "latest"]),
  ]);
  if (!isEoa(codeFrom) || !isEoa(codeTo)) continue;
  if (BigInt(nFrom) > 400n) continue; // the funder must not be a hub
  console.log(JSON.stringify({ owner: from, sock: to, fundedInBlock: block, ownerNonce: Number(BigInt(nFrom)), sockNonce: Number(BigInt(nTo)) }));
  process.exit(0);
}
console.log(`no pair found after ${tries} candidates`);
