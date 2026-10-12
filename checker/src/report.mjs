// Builds the report that a permit commits to, and its hash. The hash is sha256 over a
// canonical JSON encoding (sorted keys, bigints as decimal strings), so anyone can
// recompute it from the published report file.
import { createHash } from "node:crypto";
import { RULES } from "./config.mjs";
import { scoreFacts } from "./score.mjs";

export function canonicalJson(value) {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

export function reportHash(report) {
  return "0x" + createHash("sha256").update(canonicalJson(report)).digest("hex");
}

export function buildReport(facts, minTrustScore) {
  const s = scoreFacts(facts);
  return {
    kind: "paid-reviews-trust-report",
    rulesVersion: RULES.rulesVersion,
    rules: RULES,
    chainId: facts.chainId,
    gate: facts.gate,
    receiptId: facts.receiptId,
    payer: facts.payer,
    agentId: facts.agentId,
    amount: facts.amount,
    payBlock: facts.payBlock,
    payTx: facts.payTx,
    establishedWalletFastPath: !!facts.established,
    trustScore: s.trustScore,
    maxScore: s.maxScore,
    minTrustScore,
    eligible: s.trustScore >= minTrustScore,
    hardFails: s.hardFails,
    rawPoints: s.rawPoints,
    signals: s.signals,
  };
}
