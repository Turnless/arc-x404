// Turns a report into a signed ReviewPermit. Signing goes through `cast wallet sign`
// with a Foundry keystore (--account), which prompts for its password in the terminal,
// so the checker's private key never passes through this code.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, hashTypedData, recoverTypedDataAddress } from "viem";
import { CHAIN_ID } from "./config.mjs";
import { GATE_ABI, readContract } from "./chain.mjs";

const TYPES = {
  ReviewPermit: [
    { name: "receiptId", type: "uint256" },
    { name: "payer", type: "address" },
    { name: "agentId", type: "uint256" },
    { name: "trustScore", type: "uint8" },
    { name: "reportHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
};

export function permitTypedData(gate, { receiptId, payer, agentId, trustScore, reportHash, deadline }) {
  return {
    domain: { name: "PaidReviews", version: "1", chainId: CHAIN_ID, verifyingContract: getAddress(gate) },
    types: TYPES,
    primaryType: "ReviewPermit",
    message: {
      receiptId: BigInt(receiptId),
      payer: getAddress(payer),
      agentId: BigInt(agentId),
      trustScore,
      reportHash,
      deadline: BigInt(deadline),
    },
  };
}

/// EIP-712 JSON as cast expects it (numbers as decimal strings, EIP712Domain listed).
function castJson(td) {
  return JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...td.types,
    },
    primaryType: td.primaryType,
    domain: { ...td.domain, chainId: td.domain.chainId },
    message: Object.fromEntries(
      Object.entries(td.message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
    ),
  });
}

function castBin() {
  if (process.env.CAST_BIN) return process.env.CAST_BIN;
  const local = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "cast.exe" : "cast");
  return local;
}

export function signWithKeystore(td, account) {
  const dir = join(tmpdir(), "paid-reviews-checker");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `permit-${Date.now()}.json`);
  writeFileSync(file, castJson(td));
  try {
    const r = spawnSync(castBin(), ["wallet", "sign", "--data", "--from-file", file, "--account", account], {
      stdio: ["inherit", "pipe", "inherit"],
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`cast wallet sign failed (exit ${r.status})`);
    const sig = r.stdout.trim().split(/\s+/).pop();
    if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error("cast returned no signature");
    return sig;
  } finally {
    rmSync(file, { force: true });
  }
}

/// Confirms the signature is what the gate will accept: the digest matches the gate's
/// own permitDigest and the signer is the gate's checker.
export async function verifyAgainstGate(gate, td, signature) {
  const m = td.message;
  const onchain = await readContract(gate, GATE_ABI, "permitDigest", [
    m.receiptId,
    m.payer,
    m.agentId,
    { trustScore: m.trustScore, reportHash: m.reportHash, deadline: m.deadline },
  ]);
  const local = hashTypedData(td);
  if (onchain.toLowerCase() !== local.toLowerCase()) throw new Error("digest mismatch with the gate's permitDigest");
  const signer = await recoverTypedDataAddress({ ...td, signature });
  const checker = await readContract(gate, GATE_ABI, "checker", []);
  if (signer.toLowerCase() !== checker.toLowerCase()) {
    throw new Error(`signed by ${signer}, but the gate's checker is ${checker}`);
  }
  return { digest: local, signer };
}
