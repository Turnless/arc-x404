// Fixed facts about Arc mainnet and the scoring rules. Everything a reader needs to
// reproduce a score is in this file and in chain data at the payment block.

/// ARC_NETWORK=testnet runs the same checker against Arc testnet (for rehearsals).
const NETWORKS = {
  mainnet: {
    chainId: 5042,
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    archive: "https://rpc.mainnet.arc.io,https://rpc.quicknode.mainnet.arc.io",
    recent: "https://rpc.blockdaemon.mainnet.arc.io",
  },
  testnet: {
    chainId: 5042002,
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    archive: "https://rpc.testnet.arc.io",
    recent: "",
  },
};
export const NETWORK_NAME = process.env.ARC_NETWORK || "mainnet";
const NET = NETWORKS[NETWORK_NAME];
if (!NET) throw new Error(`unknown ARC_NETWORK ${NETWORK_NAME}`);
export const CHAIN_ID = NET.chainId;
export const IDENTITY = NET.identity;
export const REPUTATION = NET.reputation;
/// Arc emits an ERC-20 style Transfer(from, to, value) log from this system address for
/// every native USDC transfer (checked on mainnet, including transfers made inside
/// contract calls).
export const NATIVE_TRANSFER_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ZERO = "0x0000000000000000000000000000000000000000";

/// RPC routing, measured on 7 Oct 2026:
///  - archive endpoints serve full state and logs, up to 10,000 blocks per eth_getLogs,
///    and rate-limit bursts (HTTP 429, code -32005);
///  - Blockdaemon serves 100,000 blocks per eth_getLogs without rate errors, but only
///    keeps about 700,000 blocks (about 4 days) of logs and prunes state.
export const RPC = {
  archive: (process.env.ARC_ARCHIVE_RPCS || NET.archive)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  recent: (process.env.ARC_RECENT_RPCS ?? NET.recent)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  archiveLogRange: 10_000,
  recentLogRange: 100_000,
  /// Only blocks newer than head - recentWindow are sent to the recent endpoints.
  recentWindow: 500_000,
  concurrency: 4,
};

/// The scoring rules. Changing anything here changes rulesVersion, which is part of
/// every report (and so of every reportHash).
export const RULES = {
  rulesVersion: "4",
  maxScore: 10,
  /// Windows are fixed in blocks (measured: about 170,000 blocks a day, 0.507 s each),
  /// so a rerun reads exactly the same ranges.
  blocksPerDay: 170_000,
  /// Hard rule: a payer wallet younger than this cannot review.
  minAgeDays: 7,
  /// Established wallets take a faster path: at least this many days old and sending
  /// transactions in each of the last fastPathWeeks weeks before the payment. Steady
  /// activity over weeks cannot be bought quickly, so for these wallets the checker
  /// skips the slowest searches (see facts.mjs).
  fastPathWeeks: 3,
  /// Inbound window for established wallets (the last few days, served cheaply).
  fastPathInboundDays: 4,
  /// Arc mainnet public launch (16 Sep 2026); most wallets were first active after it,
  /// so age searches start here when the wallet was not active yet.
  launchBlock: 21_000_000,
  /// Windows are fixed in blocks back from the payment block, so a rerun reads exactly the
  /// same data whichever endpoints serve it.
  historyDays: 10,
  /// Wallet age tiers, highest first.
  ageTiers: [
    { days: 30, points: 2 },
    { days: 7, points: 1 },
  ],
  /// Independent recipients in the history window: 3+ gives 2 points, 1-2 gives 1.
  historyTiers: [
    { count: 3, points: 2 },
    { count: 1, points: 1 },
  ],
  /// A funder with more than this many sent transactions is treated as a hub (an
  /// exchange, bridge or faucet hot wallet), not as a personal link.
  hubNonce: 500,
  hubMinAgeDays: 7,
  /// How far back the funding chain is followed.
  funderHops: 2,
  /// How many other payers of the same agent are checked for a shared funder.
  clusterMaxPayers: 10,
  /// Inbound window: every transfer into the payer in the last this-many days (its whole
  /// life if younger) is checked for money from the agent's side. The funding chain and
  /// gate events are checked over all time.
  inboundDays: 10,
  /// Inbound senders traced one hop further (their own first funder), largest first.
  inboundSendersTraced: 2,
  /// A history recipient counts only if it received at least this much (native wei) in
  /// one transfer, had been active recipientMinAgeDays before the payment, and either
  /// existed before the payer or was not first funded by the payer or the agent's side.
  recipientMinValue: "10000000000000000",
  recipientMinAgeDays: 7,
  /// History search stops once this many candidate recipients are found, newest first.
  recipientCandidates: 6,
  /// The payer's own agent must have been registered this long before the payment to
  /// earn the identity and domain points.
  payerAgentMinAgeDays: 7,
  /// Fetch timeout for registration files and .well-known files.
  httpTimeoutMs: 6_000,
  httpMaxBytes: 65_536,
  /// Hosts anyone can publish to: a .well-known file there proves nothing about an agent.
  sharedHosts: [
    "raw.githubusercontent.com",
    "gist.githubusercontent.com",
    "ipfs.io",
    "dweb.link",
    "w3s.link",
    "nftstorage.link",
    "cloudflare-ipfs.com",
    "gateway.pinata.cloud",
    "arweave.net",
    "storage.googleapis.com",
    "s3.amazonaws.com",
  ],
};

export const REGISTRATION_TYPE_PREFIX = "https://eips.ethereum.org/EIPS/eip-8004#registration";
export const AGENT_REGISTRY_ID = `eip155:${CHAIN_ID}:${IDENTITY}`.toLowerCase();
