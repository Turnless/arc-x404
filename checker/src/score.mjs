// Pure scoring: turns gathered facts into a 0..10 trust score with a per-signal
// breakdown. No I/O, so it is unit-tested directly (test/score.test.mjs).
import { RULES } from "./config.mjs";

const lower = (a) => (a ? a.toLowerCase() : a);
const DAY = 86_400;

/// Signals in the order the project owner listed them. `hard: true` signals are pass /
/// fail; failing any of them makes the whole score 0.
export function scoreFacts(f, rules = RULES) {
  const signals = [];
  const add = (s) => signals.push({ hard: false, pass: true, ...s });
  const linked = new Set(f.linked.map(lower));

  // Hard: the payer is not on the agent's side (the contract also blocks this).
  add({
    id: "not-agent-side",
    label: "Payer is not the agent's owner, wallet or payee",
    hard: true,
    max: 0,
    points: 0,
    pass: !linked.has(lower(f.payer)),
    evidence: { linked: f.linked },
  });

  // 1. The payer's own agent identity: agentId, wallet, owner, name, metadata.
  const pa = f.payerAgent;
  const identityOk = !!(pa && pa.controls && pa.validRegistration && pa.agedRegistration);
  add({
    id: "payer-agent-identity",
    label: `Payer is an ERC-8004 agent it controls, with a valid registration at least ${rules.payerAgentMinAgeDays} days old`,
    max: 1,
    points: identityOk ? 1 : 0,
    evidence: pa
      ? {
          agentId: pa.agentId,
          controls: pa.controls,
          validRegistration: pa.validRegistration,
          agedRegistration: !!pa.agedRegistration,
          name: pa.name ?? null,
        }
      : "no payer agent given",
  });

  // 2. Claimed model or code: cannot be proven from public data, so it never scores.
  add({
    id: "model-claim",
    label: "Claimed model or code (recorded, cannot be verified, never scored)",
    max: 0,
    points: 0,
    evidence: { claim: pa?.modelClaim ?? null },
  });

  // 3. Domain proven via /.well-known/agent-registration.json (ERC-8004).
  const domainOk = identityOk && (pa.domains || []).some((d) => d.verified);
  add({
    id: "domain-verified",
    label: "A non-shared endpoint domain proves control of the payer's agent (.well-known)",
    max: 1,
    points: domainOk ? 1 : 0,
    evidence: pa ? pa.domains : "no payer agent given",
  });

  // 4. Age (also covers "fresh wallet").
  const ageDays = (f.payTimestamp - f.firstTimestamp) / DAY;
  const ageTier = rules.ageTiers.find((t) => ageDays >= t.days);
  add({
    id: "wallet-age",
    label: `Wallet age: at least ${rules.minAgeDays} days to review (${rules.ageTiers.map((t) => `${t.days}+ days: ${t.points}`).join(", ")})`,
    hard: true,
    max: rules.ageTiers[0].points,
    points: ageTier ? ageTier.points : 0,
    pass: ageDays >= rules.minAgeDays,
    evidence: { firstBlock: f.firstBlock, ageDays: Math.round(ageDays * 100) / 100 },
  });

  // 5. History of payments with independent other parties.
  const nIndep = f.independentRecipients.length;
  const histTier = rules.historyTiers.find((t) => nIndep >= t.count);
  add({
    id: "independent-history",
    label: `Paid established, independent parties in the last ${rules.historyDays} days (${rules.historyTiers.map((t) => `${t.count}+: ${t.points}`).join(", ")})`,
    max: rules.historyTiers[0].points,
    points: histTier ? histTier.points : 0,
    evidence: { count: nIndep, recipients: f.independentRecipients, checks: f.recipientChecks ?? [], window: f.historyWindow ?? null },
  });

  // 6. Funding link (hard) and independent funding (points). A funding step is linked
  // if the agent's side sent the money directly, or sent the transaction that pushed it
  // through a contract (initiator). identity = the personal wallet behind the step.
  const identityOf = (x) => x.identity ?? (!x.hub ? x.address : null);
  const viaLinked = f.payerFunders.find(
    (x) => linked.has(lower(x.address)) || (x.initiator && linked.has(lower(x.initiator))),
  );
  const payerF1 = f.payerFunders[0] && identityOf(f.payerFunders[0]) ? lower(identityOf(f.payerFunders[0])) : null;
  const shared = payerF1 && f.linkedFunders.find((lf) => lf.funder && !lf.hub && lower(lf.funder) === payerF1);
  const fundingLinked = !!(viaLinked || shared);
  add({
    id: "independent-funding",
    label: `Not funded by the agent's side, up to ${rules.funderHops} hops back (2 if independent, 0 if unknown)`,
    hard: true,
    max: 2,
    points: fundingLinked || f.payerFunders.length === 0 ? 0 : 2,
    pass: !fundingLinked,
    evidence: {
      funders: f.payerFunders.map((x) => ({
        address: x.address,
        hub: x.hub,
        initiator: x.initiator ?? null,
        identity: identityOf(x),
        block: x.block,
      })),
      linkedVia: viaLinked ? (linked.has(lower(viaLinked.address)) ? viaLinked.address : viaLinked.initiator) : null,
      sharedFunderWith: shared ? shared.account : null,
    },
  });

  // 6b. Money loop: money that came to the payer from the agent's side.
  const loop = f.moneyFromAgentSide.length > 0;
  add({
    id: "no-money-loop",
    label: `No money from the agent's side into the payer (any route, last ${rules.inboundDays} days; gate events all time)`,
    hard: true,
    max: 0,
    points: 0,
    pass: !loop,
    evidence: { found: f.moneyFromAgentSide.slice(0, 5), window: f.inboundWindow ?? null },
  });

  // 7. Single target: the payer's money went somewhere other than this agent.
  add({
    id: "not-single-target",
    label: "Payer has paid someone other than this agent",
    max: 1,
    points: nIndep >= 1 ? 1 : 0,
    evidence: { independentRecipients: nIndep },
  });

  // 8. Cluster: other payers of this agent share the payer's funder or fund each other.
  add({
    id: "no-cluster",
    label: "No other payer of this agent shares the payer's funder",
    max: 1,
    points: f.clusterWith.length === 0 ? 1 : 0,
    evidence: { otherPayersChecked: f.otherPayersChecked, clusterWith: f.clusterWith },
  });

  const hardFails = signals.filter((s) => s.hard && !s.pass).map((s) => s.id);
  const raw = signals.reduce((a, s) => a + s.points, 0);
  const trustScore = hardFails.length ? 0 : Math.min(raw, rules.maxScore);
  return { signals, hardFails, rawPoints: raw, trustScore, maxScore: rules.maxScore };
}
