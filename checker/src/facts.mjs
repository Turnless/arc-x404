// Gathers the on-chain (and registration-file) facts about one receipt's payer, as of
// the block the payment landed in. Windows are fixed in blocks back from that block and
// nothing is read at "latest", so anyone can rerun this and get the same facts (except
// .well-known fetches, which depend on the web at the time of the check and are
// recorded as evidence).
import { getAddress } from "viem";
import { AGENT_REGISTRY_ID, CHAIN_ID, IDENTITY, REGISTRATION_TYPE_PREFIX, RULES, ZERO } from "./config.mjs";
import {
  GATE_ABI,
  IDENTITY_ABI,
  activeAt,
  agentRecord,
  blockTimestamp,
  fetchText,
  firstActivityBlock,
  funderChain,
  gateEvents,
  hubKind,
  inboundTransfers,
  isEoa,
  loadRegistration,
  lower,
  nonceAt,
  readContract,
  sentTransfers,
  transfers,
} from "./chain.mjs";
import { archive, headBlock } from "./rpc.mjs";

const uniq = (xs) => [...new Map(xs.filter(Boolean).map((x) => [lower(x), getAddress(x)])).values()];
const byValueDesc = (a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : lower(a.from) < lower(b.from) ? -1 : 1);

async function txSender(hash) {
  const tx = await archive.request("eth_getTransactionByHash", [hash]);
  return tx?.from ? getAddress(tx.from) : null;
}

export async function gatherFacts({ gate, deployBlock, receiptId, payerAgentId = null, log = () => {} }) {
  const bpd = RULES.blocksPerDay;
  const timings = {};
  let tPhase = Date.now();
  const phase = (name) => {
    timings[name] = Date.now() - tPhase;
    tPhase = Date.now();
  };
  gate = getAddress(gate);
  const rid = BigInt(receiptId);
  const [payerRaw, agentIdBig, amount, reviewed] = await readContract(gate, GATE_ABI, "receipts", [rid]);
  if (lower(payerRaw) === ZERO) throw new Error(`receipt ${receiptId} does not exist on ${gate}`);
  const payer = getAddress(payerRaw);
  const agentId = Number(agentIdBig);

  const head = await headBlock();
  const events = await gateEvents(gate, deployBlock, head);
  const paid = events.find((e) => e.eventName === "Paid" && e.args.receiptId === rid);
  if (!paid) throw new Error(`no Paid event for receipt ${receiptId} since block ${deployBlock}`);
  const payBlock = paid.block;
  const payTimestamp = await blockTimestamp(payBlock);
  const upToPay = events.filter((e) => e.block <= payBlock);
  log(`receipt ${receiptId}: payer ${payer}, agent ${agentId}, paid in block ${payBlock}`);

  // The agent's side at payment time: owner, payment wallet, and the payee.
  const atPay = await agentRecord(agentId, payBlock);
  const linked = uniq([atPay.owner, atPay.wallet, paid.args.payee]);
  const linkedSet = new Set(linked.map(lower));

  phase("receipt and gate events");
  // Established wallet (fast path): active for fastPathWeeks weeks and sending
  // transactions in every one of those weeks. Read from the nonce at fixed blocks, so it
  // is reproducible; steady activity over weeks cannot be bought quickly.
  const weekBlocks = 7 * bpd;
  const weeks = RULES.fastPathWeeks;
  const weeklyNonces = await Promise.all(
    Array.from({ length: weeks + 1 }, (_, k) => nonceAt(payer, payBlock - k * weekBlocks)),
  );
  const activeWeeksAgo = await activeAt(payer, payBlock - weeks * weekBlocks);
  const established = activeWeeksAgo && weeklyNonces.slice(0, weeks).every((n, k) => n > weeklyNonces[k + 1]);
  const ageHints = established ? { knownActive: payBlock - weeks * weekBlocks } : {};

  // Wallet age and funding chain.
  const firstBlock = await firstActivityBlock(payer, payBlock, ageHints);
  const firstTimestamp = await blockTimestamp(firstBlock);
  const payerFunders = await funderChain(payer, payBlock, RULES.funderHops, ageHints);
  const payerFunderIds = new Set(payerFunders.map((f) => f.identity).filter(Boolean).map(lower));
  const linkedFunders = await Promise.all(
    linked.map(async (a) => {
      const [f] = await funderChain(a, payBlock, 1);
      // funder = the personal wallet behind the funding, or null for a hub / unknown
      return { account: a, funder: f?.identity ?? null, hub: f && !f.identity ? f.hub : null };
    }),
  );
  log(`  first active in block ${firstBlock}; funders: ${payerFunders.map((f) => f.address + (f.hub ? `(${f.hub})` : "")).join(" <- ") || "unknown"}`);

  phase("age and funding");
  // Money from the agent's side: every transfer into the payer in the inbound window,
  // whoever sent it and however (Arc logs the debited account as `from`), plus gate
  // withdrawals and gate payments that reached the payer.
  // Established wallets: the last fastPathInboundDays days only (cheap, recent endpoint).
  const inboundFrom = Math.max(
    firstBlock,
    payBlock - (established ? RULES.fastPathInboundDays : RULES.inboundDays) * bpd,
  );
  const inbound = await inboundTransfers({ addr: payer, fromBlock: inboundFrom, toBlock: payBlock });
  const bySender = new Map();
  for (const t of inbound) {
    const k = lower(t.from);
    const e = bySender.get(k) ?? { from: t.from, total: 0n, largest: t, count: 0 };
    e.total += t.value;
    e.count++;
    if (t.value > e.largest.value) e.largest = t;
    bySender.set(k, e);
  }
  const senders = [...bySender.values()].sort(byValueDesc);
  const moneyFromAgentSide = [];
  const verdicts = await Promise.all(
    senders.map(async (s) => {
      if (linkedSet.has(lower(s.from))) return "sent directly by the agent's side";
      const sender = await txSender(s.largest.tx);
      if (sender && linkedSet.has(lower(sender))) return `transaction sent by the agent's side through ${s.from}`;
      return null;
    }),
  );
  const toTrace = [];
  for (let i = 0; i < senders.length && toTrace.length < RULES.inboundSendersTraced; i++) {
    if (!verdicts[i] && !(await hubKind(senders[i].from, senders[i].largest.block))) toTrace.push(i);
  }
  await Promise.all(
    toTrace.map(async (i) => {
      const [f] = await funderChain(senders[i].from, payBlock, 1);
      if (f && ((f.identity && linkedSet.has(lower(f.identity))) || (f.initiator && linkedSet.has(lower(f.initiator))))) {
        verdicts[i] = `sender ${senders[i].from} was first funded by the agent's side`;
      }
    }),
  );
  senders.forEach((s, i) => {
    if (verdicts[i]) moneyFromAgentSide.push({ from: s.from, total: s.total.toString(), tx: s.largest.tx, block: s.largest.block, via: verdicts[i] });
  });
  for (const e of upToPay) {
    if (e.eventName === "Withdrawn" && linkedSet.has(lower(e.args.account)) && lower(e.args.to) === lower(payer)) {
      moneyFromAgentSide.push({ from: e.args.account, tx: e.tx, block: e.block, via: "gate withdrawal to the payer" });
    }
    if (e.eventName === "Paid" && linkedSet.has(lower(e.args.payer)) && lower(e.args.payee) === lower(payer)) {
      moneyFromAgentSide.push({ from: e.args.payer, tx: e.tx, block: e.block, via: "gate payment to the payer" });
    }
  }

  phase("money from the agent's side");
  // Independent history: recipients of real payments (at least recipientMinValue) in the
  // window, newest first, not on the agent's side, not the gate, not the payer's funders.
  const windowFrom = Math.max(firstBlock, payBlock - RULES.historyDays * bpd);
  const excluded = new Set([...linked, gate, payer, ZERO].map(lower).concat([...payerFunderIds]));
  const minValue = BigInt(RULES.recipientMinValue);
  const candidatesOf = (ts) => {
    const seen = new Set();
    const out = [];
    for (const t of [...ts].sort((x, y) => y.block - x.block || y.logIndex - x.logIndex)) {
      const k = lower(t.to);
      if (t.value < minValue || excluded.has(k) || seen.has(k)) continue;
      seen.add(k);
      out.push(getAddress(t.to));
    }
    return out;
  };
  const enough = (ts) => candidatesOf(ts).length >= RULES.recipientCandidates;
  const outgoing = (await isEoa(payer, payBlock))
    ? await sentTransfers({ senders: [payer], fromBlock: windowFrom, toBlock: payBlock, stop: enough })
    : await transfers({ from: payer, fromBlock: windowFrom, toBlock: payBlock, stop: enough });
  const viaGate = upToPay
    .filter((e) => e.eventName === "Paid" && lower(e.args.payer) === lower(payer) && e.block >= windowFrom)
    .map((e) => ({ to: e.args.payee, value: e.args.amount, block: e.block, logIndex: Number.MAX_SAFE_INTEGER }));
  const candidates = candidatesOf([...outgoing, ...viaGate]).slice(0, RULES.recipientCandidates);
  const need = RULES.historyTiers[0].count;
  const evaluate = async (r) => {
    const check = { address: r, qualifies: false };
    if (!(await activeAt(r, payBlock - RULES.recipientMinAgeDays * bpd))) {
      check.reason = `not active ${RULES.recipientMinAgeDays} days before the payment`;
    } else if (await activeAt(r, firstBlock - 1)) {
      check.qualifies = true;
      check.reason = "existed before the payer";
    } else if (established && ["contract", "busy-wallet"].includes(await hubKind(r, payBlock))) {
      // Fast path: a newer recipient that is an established hub (a contract, or a busy
      // wallet active for hubMinAgeDays, such as an exchange or a service) counts without
      // tracing its funder. Other newer recipients are traced like everyone else's.
      check.qualifies = true;
      check.reason = "newer than the payer, but an established hub";
    } else {
      const [f] = await funderChain(r, payBlock, 1, {
        knownInactive: firstBlock - 1,
        knownActive: payBlock - RULES.recipientMinAgeDays * bpd,
      });
      const id = f?.identity ? lower(f.identity) : null;
      if (!f) check.reason = "first funder unknown";
      else if (id && (id === lower(payer) || linkedSet.has(id) || payerFunderIds.has(id))) {
        check.reason = "first funded by the payer, its funders or the agent's side";
      } else {
        check.qualifies = true;
        check.reason = f.identity ? "independently funded" : `funded by a hub (${f.hub})`;
      }
    }
    return check;
  };
  const evaluated = await Promise.all(candidates.map(evaluate));
  const recipientChecks = [];
  const independentRecipients = [];
  for (const check of evaluated) {
    if (independentRecipients.length >= need) break;
    recipientChecks.push(check);
    if (check.qualifies) independentRecipients.push(check.address);
  }

  phase("history and recipients");
  // Cluster: other payers of the same agent that share this payer's funder, funded this
  // payer, or were funded by it.
  const payerF1 = payerFunders[0]?.identity ? lower(payerFunders[0].identity) : null;
  const others = uniq(
    upToPay
      .filter((e) => e.eventName === "Paid" && Number(e.args.agentId) === agentId && lower(e.args.payer) !== lower(payer))
      .map((e) => e.args.payer),
  ).slice(-RULES.clusterMaxPayers);
  const otherFunders = await Promise.all(others.map(async (o) => (await funderChain(o, payBlock, 1))[0]));
  const clusterWith = [];
  others.forEach((o, i) => {
    const f = otherFunders[i];
    const oF1 = f?.identity ? lower(f.identity) : null;
    if ((payerF1 && oF1 === payerF1) || oF1 === lower(payer) || payerF1 === lower(o)) {
      clusterWith.push({ payer: o, funder: f?.identity ?? null });
    }
  });

  phase("cluster");
  const payerAgent = payerAgentId == null ? null : await checkPayerAgent(payerAgentId, payer, payBlock);
  phase("payer agent");

  return {
    chainId: CHAIN_ID,
    gate,
    receiptId: Number(rid),
    payer,
    agentId,
    amount: amount.toString(),
    reviewed,
    payBlock,
    payTimestamp,
    payTx: paid.tx,
    linked,
    established,
    weeklyNonces: weeklyNonces.map(String),
    firstBlock,
    firstTimestamp,
    payerFunders,
    linkedFunders,
    inboundWindow: { fromBlock: inboundFrom, toBlock: payBlock, transfers: inbound.length, senders: senders.length },
    moneyFromAgentSide,
    historyWindow: { fromBlock: windowFrom, toBlock: payBlock, days: RULES.historyDays },
    recipientChecks,
    independentRecipients,
    otherPayersChecked: others.length,
    clusterWith,
    payerAgent,
    timings,
  };
}

const isSharedHost = (host) => RULES.sharedHosts.some((h) => host === h || host.endsWith("." + h));

/// Checks an agent the payer claims to be. Identity point: the payer owns it or is its
/// wallet, its registration file is a valid ERC-8004 registration, and it was registered
/// at least payerAgentMinAgeDays before the payment. Domain point: one of its HTTPS
/// endpoint domains, not a shared host, publishes /.well-known/agent-registration.json
/// listing this agentId and registry.
export async function checkPayerAgent(agentId, payer, block) {
  const out = {
    agentId: Number(agentId),
    controls: false,
    validRegistration: false,
    agedRegistration: false,
    modelClaim: null,
    domains: [],
  };
  try {
    const rec = await agentRecord(agentId, block);
    out.owner = rec.owner;
    out.wallet = rec.wallet;
    out.controls = lower(rec.owner) === lower(payer) || lower(rec.wallet) === lower(payer);
    const earlier = block - RULES.payerAgentMinAgeDays * RULES.blocksPerDay;
    out.agedRegistration = await readContract(IDENTITY, IDENTITY_ABI, "ownerOf", [BigInt(agentId)], earlier)
      .then(() => true)
      .catch(() => false);
    const uri = await readContract(IDENTITY, IDENTITY_ABI, "tokenURI", [BigInt(agentId)], block);
    out.uriScheme = uri.split(":")[0];
    const reg = await loadRegistration(uri);
    out.name = typeof reg.name === "string" ? reg.name.slice(0, 80) : null;
    out.validRegistration =
      typeof reg.type === "string" && reg.type.startsWith(REGISTRATION_TYPE_PREFIX) && !!out.name?.trim();
    const claim = reg.model ?? reg.llm ?? null;
    out.modelClaim = typeof claim === "string" ? claim.slice(0, 80) : null;

    const urls = [
      ...(Array.isArray(reg.services) ? reg.services : []),
      ...(Array.isArray(reg.endpoints) ? reg.endpoints : []),
    ]
      .map((s) => s?.endpoint ?? s?.url)
      .filter((u) => typeof u === "string" && u.startsWith("https://"));
    const hosts = [...new Set(urls.map((u) => new URL(u).host.toLowerCase()))].slice(0, 5);
    for (const host of hosts) {
      const d = { host, verified: false };
      if (isSharedHost(host)) {
        d.how = "shared host, proves nothing";
      } else {
        try {
          const wk = JSON.parse(await fetchText(`https://${host}/.well-known/agent-registration.json`));
          const regs = Array.isArray(wk.registrations) ? wk.registrations : [];
          d.verified = regs.some(
            (r) => String(r.agentId) === String(agentId) && String(r.agentRegistry).toLowerCase() === AGENT_REGISTRY_ID,
          );
          d.how = d.verified ? ".well-known lists this agent" : ".well-known does not list this agent";
        } catch (e) {
          d.how = `.well-known not readable: ${String(e.message).slice(0, 60)}`;
        }
      }
      out.domains.push(d);
    }
  } catch (e) {
    out.error = String(e.message).slice(0, 120);
  }
  return out;
}
