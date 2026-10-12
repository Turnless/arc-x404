# ARC-x404: submission pack (Arc Microgrants)

Deadline: the DoraHacks listing shows 15 Oct 2026 03:59 UTC (14 Oct 23:59 ET, 15 Oct 04:59 in
Nigeria); its description says submissions close on 14 Oct. Review is on a rolling basis and
decisions come by 21 Oct, so submit as early as possible.
Submission page: https://dorahacks.io/hackathon/arc-microgrants

## Form answers (draft)

**Project name:** ARC-x404

**One-liner:** Paid, trust-checked reviews for AI agents on Arc: everyone can pay, not everyone
can review.

**Description:**
Anyone can rate an AI agent in Arc's ERC-8004 ReputationRegistry for free, so an agent's
score can be faked with a sock wallet for a cent of gas. ARC-x404 lets anyone pay an agent in
native USDC through the PaidReviews contract, and the agent receives 100% of the payment in
the same transaction. Turning that payment into a rating needs a permit from an open trust
checker that scores the payer from public Arc data while the agent works: who funded the
wallet (two hops back, through contracts too), whether money flowed to it from the agent's
side by any route, how old it is, whether it has paid established, independent parties, and
whether other payers share its funder. A payer under 7/10 cannot review; an owner's sock
funded by the owner scores 0. The contract verifies the checker's EIP-712 signature and
writes the rating to Arc's ERC-8004 ReputationRegistry. Every score can be rechecked: the
report hash is inside the permit and the on-chain event.

**What is on Arc mainnet:** the PaidReviews contract, a demo agent in the ERC-8004
IdentityRegistry, USDC payments that reached the agent in full, and reviews rejected
on-chain (a sock funded by the agent's owner, a wallet younger than 7 days, and a wallet
that never paid).

**Live deployment link:** TBD (Arc explorer link to the PaidReviews contract)

**Repository:** https://github.com/Turnless/arc-x404

**Arc components used:** native USDC as payment and gas (18-decimal native and 6-decimal
ERC-20 views kept consistent); Arc's ERC-8004 IdentityRegistry and ReputationRegistry on
mainnet; Arc's native-transfer `Transfer` logs from `0xffff...fffe`, which the checker reads
to find funding links and money loops.

**Honest note for the reviewers:** an accepted review is not on mainnet yet. The checker's
hard rule is that a payer wallet must be at least 7 days old, and this project's wallets were
first funded two days before the deadline. The accepted case is shown by an end-to-end run on
a local fork of Arc mainnet with real mainnet wallets (`docs/e2e-fork-run-2026-10-07.txt`).
The project wallets can post a real accepted review on mainnet from about 19 Oct.

## Addresses

| What | Address |
|---|---|
| PaidReviews (gate) | TBD |
| Deploy block | TBD |
| Demo agent id | TBD |
| Checker signing key (public) | `0x777908f9BC5b4e31be3b2b85e25c0268cf69143d` |
| Deployer / agent owner | `0xF30E876a47B989e8CE7baa3cE10313aad4B26c49` |
| Payer | `0x5dD74aceF3cB49b94279792af30B63d585FF4317` |
| Sock (funded by the deployer) | `0x1c2d972C667C2DA5A9dEd15f4A9F93d4BA47E3BB` |
| ERC-8004 IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

## Demo video script (about 2.5 minutes, filmed on the real mainnet transactions)

1. **Hook (10 s).** "On Arc, anyone can rate an AI agent for free. That means any agent's
   score can be faked with a second wallet for a cent of gas."
2. **The rule (15 s).** Show the README headline: everyone can pay, not everyone can review.
   One sentence on the checker: it looks at who is behind the wallet, using Arc's public data.
3. **Payment (30 s).** Explorer: the payer's `pay` transaction; the agent received the full
   amount in the same transaction (internal transfer).
4. **The checker (40 s).** Terminal: `node src/cli.mjs score <receipt>` on the sock's receipt.
   The signal list prints: funded by the agent's owner, money from the agent's side, too new.
   Score 0.
5. **Rejection on-chain (20 s).** Explorer: the sock's `review` transaction failed with
   `TrustScoreTooLow(0, 7)`. Then the brand-new wallet's review, also rejected.
6. **The accepted case (20 s).** The fork run output: a real unrelated mainnet wallet scored 7
   and its review was accepted; a real owner-funded wallet scored 0.
7. **Why Arc and what is next (15 s).** USDC as payment and gas, ERC-8004 already on mainnet,
   every transfer logged. Next: several independent checkers, keyed RPC for second-level
   checks.

## X posts (drafts; post them yourself)

1. **Thesis.** "On Arc, anyone can rate an AI agent in the ERC-8004 registry for free. So any
   agent's score can be faked with a second wallet for a cent of gas. Building the fix for
   @arc Microgrants: everyone can pay, not everyone can review."
2. **Proof.** "First ARC-x404 transactions on Arc mainnet: a payment that reached the agent in
   full, and a review from a sock wallet (funded by the agent's own owner) rejected on-chain:
   TrustScoreTooLow(0, 7). [explorer link] [screenshot]"
3. **Launch.** "ARC-x404 is live on Arc mainnet. Pay any agent in USDC (it gets 100%). Review
   only if an open checker, reading public Arc data, scores you 7/10: funding links, money
   loops, wallet age, real payment history. 61 contract tests, 26 checker tests, every score
   recheckable. Repo: github.com/Turnless/arc-x404 [video] @arc @circle #ArcMicrogrants"

## Pre-submit checklist

- [x] Repo prepared: license (MIT), secrets scanned (no keys, `.env` ignored), README judge-first
- [ ] Repo pushed and public: https://github.com/Turnless/arc-x404 opens in a private window
- [ ] CI green on GitHub (checker tests + contract build + offline fuzz test)
- [ ] Wallets funded: deployer about 0.5 USDC, payer about 0.3 USDC (Arc mainnet)
- [ ] Mainnet deploy done; contract verified on the Arc explorer (or flattened source linked)
- [ ] Demo transactions done; every TBD in README and here replaced with real hashes
- [ ] Judge fast path followed literally from a fresh browser
- [ ] Video recorded and linked (unlisted is fine)
- [ ] X posts published by you, launch post linked in the form
- [ ] Submitted on DoraHacks before the deadline
