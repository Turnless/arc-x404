# ARC-x404 - paid, trust-checked reviews for AI agents on Arc

[![CI](https://github.com/Turnless/arc-x404/actions/workflows/ci.yml/badge.svg)](https://github.com/Turnless/arc-x404/actions/workflows/ci.yml)
![Arc mainnet](https://img.shields.io/badge/Arc-mainnet%205042-blue)
![ERC-8004](https://img.shields.io/badge/ERC--8004-ReputationRegistry-green)
![tests](https://img.shields.io/badge/tests-61%20contract%20%C2%B7%2026%20checker-brightgreen)

**Arc Microgrants** (Circle / Arc, DoraHacks) · built on Arc mainnet's ERC-8004 registries and native USDC

Anyone can rate an AI agent in Arc's ERC-8004 ReputationRegistry for free, so a score can be
faked with a sock wallet for a cent of gas. ARC-x404 lets anyone pay an agent in USDC (the
agent gets 100% at once), and lets a payer turn that payment into a rating only if an open
trust checker, reading public Arc data while the agent works, scores the payer 7/10 or more.
The `PaidReviews` contract enforces the checker's signed verdict and writes the rating to
Arc's ERC-8004 ReputationRegistry.

**Everyone can pay. Not everyone can review.**

| | |
|---|---|
| Repo | https://github.com/Turnless/arc-x404 |
| Live contract | PaidReviews on Arc mainnet: [`0xE6F94dAFBE0B37194911a3Ab738727e37FD3F05d`](https://explorer.arc.io/address/0xE6F94dAFBE0B37194911a3Ab738727e37FD3F05d) |
| First mainnet tx | [`0x5e91bc18…`](https://explorer.arc.io/tx/0x5e91bc185dc03541997dbc9724addb567f89ab3c0aed35d6904bcd57d4c13f46): demo agent 2439 registered, 14 Oct 2026; gate deployed in [`0x60ff87cf…`](https://explorer.arc.io/tx/0x60ff87cfd35b8c5f6ba5d2409dd647db954b963a44855eff109dfc6dda6a078a) |
| Cost per review | about 0.01 USDC of gas for a pay plus a review (about 500k gas at 20 gwei); the agent keeps 100% of the price |
| Check time | about 45 s for a new wallet, about 4.5 min for a very busy one, on Arc's free public endpoints |
| Tests | 61 contract tests (60 against Arc mainnet state), 26 checker tests, end-to-end run with real mainnet wallets |
| Nothing simulated on mainnet | the deploy, payments and rejected reviews are real Arc mainnet transactions; the one accepted review shown comes from the fork run below (see "What is real and what is not") |

## Judge fast path

Five minutes, no keys, nothing to install for steps 1 to 3.

1. Open the [PaidReviews contract](https://explorer.arc.io/address/0xE6F94dAFBE0B37194911a3Ab738727e37FD3F05d) on the Arc explorer and its transactions:
   a payment that reached the agent in full in the same transaction, and two reviews that
   the gate rejected on-chain (`TrustScoreTooLow`): one from a sock wallet funded by the
   agent's owner, one from a brand-new wallet.
2. In the explorer's Read tab, call `liveScore(agentId)` and `blockedReviews(agentId)` for the
   demo agent, and see that a rating posted directly to the registry (free, unpaid) does not
   count: the registry's `getSummary` filtered to the gate only counts checked ratings.
3. Read the checker's verdicts in [`docs/`](docs/): the end-to-end run in
   [`docs/e2e-fork-run-2026-10-07.txt`](docs/e2e-fork-run-2026-10-07.txt) shows a real mainnet
   wallet first funded by the agent's owner scoring 0 and being rejected, and a real
   unrelated wallet scoring 7 and being accepted.
4. Optional, needs Node 22: rerun the checker yourself on a mainnet receipt (read-only, no
   keys): `cd checker && npm ci && node src/cli.mjs score <receiptId>`. The report hash must
   match the one in the `ReviewTrust` event / permit.
5. Optional: `cd checker && npm test` (26 tests, offline) and
   `forge test --fork-url https://rpc.mainnet.arc.io` (61 tests).

## The problem

Arc mainnet runs the ERC-8004 IdentityRegistry and ReputationRegistry. Anyone can rate any
agent for free; only the agent's owner and approved operators are blocked. The ERC-8004
spec lets feedback carry a proof of payment, but the field is optional and the registry
does not check it. So a raw score is cheap to fake: a sock puppet can post as many ratings
as gas allows, and a reader cannot tell a paying customer from anyone else.

A payment alone does not fix this. If the owner pays their own agent from a second wallet,
the money comes straight back: the fake rating costs only gas. No rule that looks only at
payments can tell that second wallet from a real new customer. Something has to look at
who is behind the wallet. That is the checker.

## How it works

```
1. pay      payer --pay(agentId){value}--> PaidReviews --full amount--> agent   (Instant, default)
                                                     \--held in owed--> agent withdraws later (Hold, or if the forward fails)
                                           receipt {payer, agentId, amount}

2. check    checker sees the Paid event and scores the payer while the agent works
            (public Arc data as of the payment block) -> report -> sha256 reportHash
            -> EIP-712 ReviewPermit {receiptId, payer, agentId, trustScore, reportHash, deadline}
               signed with the checker key

3. review   payer --review(receiptId, score, ..., permit, signature)--> PaidReviews
                    requires: the receipt's payer, unused receipt, checker signature,
                              trustScore >= 7, permit not expired
                    --> ReputationRegistry.giveFeedback(agentId, score, tag1 = "paid-review", ...)
```

- **Payment.** The payer sends exactly the price; there is no fee. By default the gate
  forwards the whole amount to the agent's wallet (or its owner) in the same transaction.
  The forward gets a 30,000 gas cap and ignores return data, so a hostile payee contract
  cannot block, censor or drain the payer; if the forward fails, the payment is held in
  `owed` and the payee collects it with `withdraw`. An owner can switch an agent to Hold
  (`setHoldPayouts(agentId, true)`) to collect payments later.
- **Review.** Only the receipt's payer, once per receipt, score 0 to 100, with a permit
  from the checker. The permit is bound to the receipt, payer, agent, trust score, report
  hash and an expiry, and its EIP-712 domain binds it to this chain and this gate.
- **One live rating per payer.** A later review by the same payer revokes their earlier
  rating in the registry and replaces it.
- **Owner veto leaves a trace.** If the owner approves the gate in the IdentityRegistry,
  the registry would reject the gate's ratings as self-feedback; `pay` then reverts, and
  a review of an earlier receipt is recorded in `blockedReviews` and `ReviewBlocked`.

### Reading the score

```sh
# kept by the gate in O(1): (number of live checked ratings, sum of scores)
cast call <GATE> "liveScore(uint256)(uint256,int256)" <AGENT_ID> --rpc-url https://rpc.mainnet.arc.io
# the registry, filtered to the gate as reviewer: (count, average, decimals)
cast call 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63 \
  "getSummary(uint256,address[],string,string)(uint64,int128,uint8)" \
  <AGENT_ID> "[<GATE>]" paid-review "" --rpc-url https://rpc.mainnet.arc.io
```

Free ratings posted directly to the registry are not counted, because their reviewer is
not the gate. Also check `blockedReviews(agentId)`.

## The trust score

The checker gathers facts as of the payment block and scores them with fixed, published
rules (`checker/src/config.mjs`, `checker/src/score.mjs`, rules version 4). Hard checks
are pass or fail: failing any of them makes the whole score 0. The design rule is that
every point must cost an attacker time, or money paid to someone genuinely independent.

| Check | How it is read from Arc | Points |
|---|---|---|
| Payer is not the agent's owner, wallet or payee | registry state at the payment block | hard |
| Wallet age | first block with a balance or a sent transaction (4-way search over archive state) | hard: at least 7 days; 30+ days: 2, 7+ days: 1 |
| Payer is an ERC-8004 agent it controls, registered at least 7 days before paying | `ownerOf` / `getAgentWallet`, registration file, `ownerOf` 7 days earlier | 1 |
| Claimed model or code | recorded, cannot be proven from public data | 0 |
| A non-shared endpoint domain proves control of that agent | `https://<domain>/.well-known/agent-registration.json` lists the agentId and registry (ERC-8004); shared hosts such as raw.githubusercontent.com or IPFS gateways never count | 1 |
| Payments to established, independent parties in the last 10 days | each recipient received at least 0.01 USDC in one transfer, was active 7+ days before the payment, and either existed before the payer or was first funded by someone other than the payer, its funders or the agent's side | 3+: 2, 1-2: 1 |
| Funding link | the payer's first funder, followed 2 hops back; through a contract, the account that sent the funding transaction; hubs judged at the funding block | hard; 2 if independent, 0 if unknown |
| Money from the agent's side | every transfer into the payer in the last 10 days (its whole life if younger), by any route: Arc logs the debited account even for an ERC-20 `transferFrom` or EIP-7702 code. Each sender is checked, the transaction's sender is checked, and the largest senders are traced one hop further. Gate withdrawals and gate payments to the payer are checked over all time | hard |
| Not a single target | the payer has paid an established, independent party | 1 |
| No cluster | no other payer of this agent shares the payer's funder or funds it | 1 |
| | **Total** | **10** |

**Established wallets.** A payer that has been active for 3 weeks and sent transactions in
each of those weeks (read from its nonce at fixed blocks) takes a faster path: the inbound
check covers its last 4 days instead of 10, and a recipient newer than the payer that is an
established hub (a contract, or a busy wallet active for 7+ days) counts without tracing its
funder. The funding chain, the hard minimum age and every other check still apply. Steady activity over weeks cannot be bought
quickly, which is why this shortcut is safe enough; it keeps a check on a very busy wallet
to minutes on public endpoints.

Hubs are the zero address, contracts (bridges, gateways), and wallets that had more than 500
sent transactions and had been active for 7 days at the time of the funding (exchange hot
wallets). A shared hub is not counted as a link. Pumping a personal wallet past 500
transactions just before funding socks does not make it a hub.

Arc emits a `Transfer(from, to, value)` log from `0xffff...fffe` for every native USDC
transfer, including transfers inside contract calls and transfers through the ERC-20
interface; the checker reads those logs.

### Examples

| Payer | Score | Can review |
|---|---|---|
| Established wallet: 10+ days old, funded from an exchange, paid 3 established, unrelated parties | 7 | yes |
| Agent registered weeks ago with a verified domain, 30+ days old, independent history | 10 | yes |
| Owner's second wallet funded by the owner (directly, 2 hops back, through a forwarder contract, or by a `transferFrom` pull) | 0 | no |
| Any wallet younger than 7 days, however it is set up | 0 | no |
| Genuine first-time customer with a brand-new wallet | 0 | no, until it is 7 days old and has history |

### Every score can be rechecked

The full report (every signal, its evidence and the rules) is hashed with sha256 over a
canonical JSON encoding, and that `reportHash` is inside the signed permit and the
`ReviewTrust` event. Anyone can rerun the open checker on the same receipt and compare.
The facts are read at the payment block (or a fixed number of blocks before it), and the
history keeps the newest recipients in a fixed order, so a rerun reads the same data
whichever endpoints serve it. The one exception is the `.well-known` fetch, which depends
on the web at the time of the check.

## Threat model: what it stops, and what it does not

It stops:
- the agent's owner, operators or wallet reviewing (contract and checker);
- instant sock wallets: anything younger than 7 days cannot review;
- a sock funded by the owner: directly, up to 2 hops back, through a forwarder contract the
  owner called, or by pulling the owner's USDC with `transferFrom`;
- free points: a fresh agent registration, a file on a shared host, and dust payments to
  fresh wallets earn nothing;
- groups of payers funded by the same personal wallet;
- reviews without a payment, reuse of a receipt, and forged, altered, expired or replayed
  permits.

It does not stop:
- a patient attacker. A wallet funded through an exchange, left for 7 days, that pays at
  least 0.01 USDC to each of three established parties that it and the owner do not
  control, passes. Faking a review now costs a week per wallet and real money paid to
  others, instead of a cent of gas. Paying real people to review (collusion) is not
  stopped by any review system.
- genuine new customers from reviewing straight away. With the threshold at 7 and the
  7-day minimum, a new wallet can pay at once and review once it is a week old and has
  paid others.

Trust model: the checker key is trusted to apply the published rules; the report hash makes
its work checkable. The gate pins one checker address at deploy and cannot rotate it: if the
key leaked, the gate would have to be redeployed. Every RPC endpoint the checker reads is
trusted to answer honestly. Several independent checkers are on the roadmap.

Known gaps: for established wallets, money from the agent's side that arrived more than 4
days before the payment is only caught if it was the first funding; approved operators of the agent are not part of "the agent's side" (the
registry has no cheap way to list them); money that reached the payer more than 10 days
before payment, other than its first funding, is not examined (an owner who funds a sock
after a first deposit from an exchange and then waits 10 days escapes this check; the
window is kept short so busy wallets can be checked in minutes on public endpoints); a payer that is a contract
wallet deployed without value has no first funder and gets 0 funding points.

Other limits: a rating proves the payer paid and passed the checker, not that the work was
good. Ratings stay with the agent id if the agent is sold. Arc's blocklist and zero-address
transfer rules cannot be reproduced on a local fork; the gate's handling of them (a failed
Instant forward is held; a blocklisted payee cannot withdraw) is reasoned, not tested.

## Why Arc

- USDC is the native gas token and the payment, so paying an agent and paying for the
  transaction are the same money. Native USDC has 18 decimals and the ERC-20 view has 6;
  the gate only accepts whole ERC-20 units (multiples of 1e12 wei), so both views of every
  amount match.
- The ERC-8004 registries are already live on Arc mainnet; the gate writes to them.
- Arc logs every native USDC transfer as a standard `Transfer` event, which is what makes
  funding links and money loops visible to the checker.
- Sub-second blocks, so the payment is final before the agent starts work, and the check
  runs during the work.
- Plain wallets work; nothing here needs a custodial or programmable wallet.

## Tests and scripts

- Contract: 61 tests (60 run against Arc mainnet state, 1 fuzz test with mock registries).
  `forge test --fork-url https://rpc.mainnet.arc.io`. They cover Instant and Hold payouts,
  hostile payees (reverting, gas-burning, re-entering, returning large data), permits
  (valid, wrong signer, altered fields, other receipt, other agent, other payer, other gate,
  expired, malleable signature, bad length), the trust threshold, receipts, replacement,
  the owner veto, ownership changes between pay and review, and the registry's revoke
  behaviour this design relies on.
- Checker: 26 tests (`cd checker && npm test`, offline; CI runs them on every push): the scoring rules, the age search, and
  regression tests for the attacks found in an independent review, run against a fake
  chain (a sock with a fresh agent, a shared-host domain and dust recipients; money pulled
  from the owner with `transferFrom`; reruns served by different endpoints).
- End to end (`checker/test/e2e-anvil.mjs`): the gate is deployed on a local fork of Arc
  mainnet and real mainnet wallets pay and review, with the checker reading their real
  history from Arc's endpoints:

  | Real wallet | Checker | Gate |
  |---|---|---|
  | first funded by the agent's owner | 0/10: too new, funding link, money from the agent's side | review rejected, `TrustScoreTooLow` |
  | unrelated, 3 weeks old | 7/10: age passes, 3 established independent recipients, independent funding | review accepted |

## Performance on Arc's public endpoints

Measured 7 Oct 2026 from a home connection. Arc's public archive endpoints allow about 3
historical reads per second in sustained use and penalise bursts, so the checker
throttles itself (3 requests in flight) and uses Blockdaemon for the last few days.

| Payer | Time | Historical reads |
|---|---|---|
| A sock or other new wallet | about 45 seconds | about 240 |
| A very busy wallet (800+ transactions in 3 weeks) | about 4.5 minutes | about 820 |

Most of the cost is finding when wallets first became active (about 70 reads each): the
payer, its funders, newer recipients and the largest inbound senders. Measured by phase for
the busy wallet: age and funding 15 s, money from the agent's side 73 s, history and
recipients 186 s. Ranges where an
account did nothing are skipped, and the last few days are read in large ranges. The
checker starts on the `Paid` event (`watch` mode), so the check runs while the agent
works. A keyed RPC (set `ARC_ARCHIVE_RPCS`) removes the public throttle, which is almost
all of the time above.

## Deployed addresses (Arc mainnet, chain 5042)

| Contract | Address |
|---|---|
| PaidReviews | [`0xE6F94dAFBE0B37194911a3Ab738727e37FD3F05d`](https://explorer.arc.io/address/0xE6F94dAFBE0B37194911a3Ab738727e37FD3F05d) (deployed in block 25,957,249) |
| Checker (signing key, public address) | `0x777908f9BC5b4e31be3b2b85e25c0268cf69143d` |
| Demo agents (ERC-8004) | 2439 (used in the demo) and 2440, owned by the deployer `0xF30E876a47B989e8CE7baa3cE10313aad4B26c49` |
| ERC-8004 IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

## Demo transactions (Arc mainnet, 14 Oct 2026)

| # | Step | Transaction | Result |
|---|---|---|---|
| 1 | Register demo agents 2439 and 2440 (deployer) | [`0x5e91bc18…`](https://explorer.arc.io/tx/0x5e91bc185dc03541997dbc9724addb567f89ab3c0aed35d6904bcd57d4c13f46) [`0xb414292d…`](https://explorer.arc.io/tx/0xb414292de18a3e49837251f80856a345cf473a1bf9da2c470085eedcf509a8d7) | agents owned by `0xF30E…6c49` |
| 2 | Deploy PaidReviews (checker `0x7779…143d`, threshold 7, min payment 0.01 USDC) | [`0x60ff87cf…`](https://explorer.arc.io/tx/0x60ff87cfd35b8c5f6ba5d2409dd647db954b963a44855eff109dfc6dda6a078a) | gate [`0xE6F9…F05d`](https://explorer.arc.io/address/0xE6F94dAFBE0B37194911a3Ab738727e37FD3F05d) |
| 3 | The agent's owner funds a sock wallet with 0.05 USDC | [`0xd900f180…`](https://explorer.arc.io/tx/0xd900f1807e62739a316d1f7836af6f3390a93c9ddd2e59f1f559a750019d4fb2) | sock `0x1c2d…E3BB` |
| 4 | The owner sends the payer wallet 0.02 USDC for gas | [`0xd7c1b0c5…`](https://explorer.arc.io/tx/0xd7c1b0c5313001b467eb8d4f02bf79cc37f31fa12d62d4842fc98e446393c7c7) | payer `0x5dD7…4317` |
| 5 | Sock pays agent 2439 0.01 USDC through the gate | [`0xde89c66b…`](https://explorer.arc.io/tx/0xde89c66bd8b52302afd0babf3893c0e49055de46b2bf6562183e0bdeb4bb3a07) | receipt #1; `Paid(..., instant = true)`; the agent received the full 0.01 USDC in the same transaction, the gate holds 0 |
| 6 | Checker scores receipt #1 (off-chain, 29 s on public endpoints) | [report](checker/reports/receipt-1.json), [permit](permits/receipt-1.json) | **0/10**, hard fails: funded by the agent's owner, money from the agent's side, wallet younger than 7 days. Report hash `0x53bf23de…f8e8`; two independent runs produced the same hash |
| 7 | Sock submits its review with that permit | [`0x4a217015…`](https://explorer.arc.io/tx/0x4a217015e0ac907714bd97bb228361424d58499bc66ff35e39267f131858de0c) | **rejected on-chain:** `TrustScoreTooLow(0, 7)` |
| 8 | Payer, which never paid, tries to review the sock's receipt | [`0x22db0b5b…`](https://explorer.arc.io/tx/0x22db0b5bf462a21e28e0776fea46e104a3cd603af469d259c5cc954fb5eca8ca) | **rejected on-chain:** `NotReceiptPayer(1)` |

Afterwards `liveScore(2439)` is `(0, 0)`: no unchecked rating reached the registry through
the gate. Forge's broadcast records for steps 1 and 2 are in `broadcast/*/5042/`.

## What is real and what is not

- **Real, on Arc mainnet:** the PaidReviews contract, the demo agent in the ERC-8004
  IdentityRegistry, the payments (USDC moved to the agent), and the rejected reviews above.
- **Real, off-chain:** the trust checker, run against Arc mainnet data; its reports and
  permits for the demo receipts are signed with the checker key whose address is pinned in
  the contract.
- **Not on mainnet: an accepted review.** The checker requires a payer wallet to be at least
  7 days old. This project's wallets were first funded on 14 Oct 2026, the deadline day, so
  no wallet of ours could pass honestly in time, and lowering the rule for the demo would
  defeat it. The accepted case is shown instead by the end-to-end run on a local
  fork of Arc mainnet ([output](docs/e2e-fork-run-2026-10-07.txt),
  [script](checker/test/e2e-anvil.mjs)): the same contract deployed on the fork, real mainnet
  wallets as payers, and the checker reading their real Arc history.
- **In this demo the builder controls the agent, the payer and the sock.** The sock is
  rejected because it was funded by the agent's owner. A payer funded through an exchange
  cannot be linked to the owner by any public data; that is the documented limit below.

## Run it

### Keystores (never use `--private-key` on mainnet)

```sh
cast wallet new arc-deployer   # deploys the gate, owns the demo agent
cast wallet new arc-payer      # pays and reviews
cast wallet new arc-checker    # signs trust permits; needs no funds
```

Each command asks for a password and stores the key encrypted in `~/.foundry/keystores`.
Put the public addresses in `.env` (see `.env.example`).

### Deploy and use

```sh
forge script script/RegisterAgents.s.sol --rpc-url $ARC_RPC_URL --account arc-deployer --broadcast
forge script script/DeployPaidReviews.s.sol --rpc-url $ARC_RPC_URL --account arc-deployer --broadcast
# put GATE, GATE_DEPLOY_BLOCK, AGENT_ID_1, AGENT_ID_2 in .env

forge script script/PayDemo.s.sol --rpc-url $ARC_RPC_URL --account arc-payer --sender $PAYER --broadcast

cd checker && npm install
node src/cli.mjs watch                      # scores each payment as it lands
node src/cli.mjs score <receiptId> --sign   # signs the permit (asks for the arc-checker password)
#   -> prints the ready cast send command for the payer's review
```

A payer that is itself an ERC-8004 agent can pass `--payer-agent <id>` to `score` for the
identity and domain points.

## Roadmap

- Several independent checkers, with the gate accepting any one of them (or a quorum).
- A proof-of-personhood or KYC attestation as an extra signal, if a provider publishes one
  on Arc that contracts can read.
- Agent-side delivery confirmation before a review, a minimum delay between pay and
  review, and refunds for undelivered work.

## License

MIT
