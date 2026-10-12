// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);
}

interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;
    /// Shape checked with cast against the deployed v2.0.0 registry on Arc mainnet.
    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);
    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);
    function getIdentityRegistry() external view returns (address);
}

/// @title PaidReviews
/// @notice Paid, trust-checked ratings for ERC-8004 agents on Arc, settled in native USDC.
///
///         Step 1, pay(agentId): anyone can pay any agent. The payer sends exactly the
///         price and the agent gets all of it; there is no fee. By default the payment is
///         forwarded to the agent at once (Instant). The forward runs with a small gas
///         cap; if it fails (a payee contract that reverts or wastes gas, or an address
///         that cannot receive), the payment is held for the payee instead, so pay never
///         fails because of the payee. An owner can switch an agent to Hold, in which case
///         payments are held and collected later with withdraw(to). A receipt
///         {payer, agentId, amount, reviewed} is stored.
///
///         Step 2, review(...): only the receipt's payer, once per receipt, posts a 0..100
///         rating, and only with a permit signed by the trust checker that gives the payer
///         a trust score of at least minTrustScore (out of 10). The checker is an off-chain
///         service that scores the payer from public Arc data while the agent works
///         (funding links to the agent's owner, money loops, wallet age, history with
///         independent parties, clusters of related payers, and the payer's own agent
///         registration and domain). The permit binds the receipt, payer, agent, score,
///         a hash of the full score report, and an expiry. This contract cannot read
///         history itself; it enforces the checker's signed result.
///
///         The ReputationRegistry records msg.sender as the reviewer, so every rating is
///         attributed to this contract; getSummary(agentId, [address(this)], "paid-review",
///         "") returns a score built only from paid, trust-checked ratings. The same live
///         score is kept here in O(1) as liveScore(agentId). One live rating per payer
///         wallet per agent: a later review revokes the payer's earlier rating.
///
///         Owner veto: if the agent owner approves this gate in the IdentityRegistry, the
///         registry rejects the gate's ratings as self-feedback. pay() then reverts, and a
///         review of a receipt paid earlier is recorded here instead (blockedReviews,
///         ReviewBlocked) so the attempt leaves an on-chain trace.
///
///         Trust model: the checker key is trusted to apply its published rules. Each permit
///         carries reportHash, the hash of the score report, so anyone can rerun the open
///         checker on the same public data and compare. A rating proves the rater paid the
///         agent and passed the checker; it does not prove the work was good, and a patient
///         attacker who builds an aged, independently funded wallet with real history can
///         still pass. The checker raises the cost of faking; it does not make it impossible.
contract PaidReviews {
    string public constant TAG = "paid-review";
    int128 public constant MAX_SCORE = 100;
    uint8 public constant MAX_TRUST_SCORE = 10;
    /// Native USDC has 18 decimals, the ERC-20 interface has 6. Payments must be whole
    /// multiples of 1e12 wei so the ERC-20 view of every amount is exact.
    uint256 public constant NATIVE_PER_ERC20_UNIT = 1e12;
    /// Gas given to an Instant forward. Enough for an EOA or a simple wallet's receive,
    /// far too little to re-enter this contract or do meaningful work.
    uint256 public constant PUSH_GAS = 30_000;
    uint256 public constant MAX_TAG2_BYTES = 64;
    uint256 public constant MAX_URI_BYTES = 512;

    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "ReviewPermit(uint256 receiptId,address payer,uint256 agentId,uint8 trustScore,bytes32 reportHash,uint64 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// secp256k1n / 2, the upper bound for a non-malleable signature's s value.
    uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    IIdentityRegistry public immutable identity;
    IReputationRegistry public immutable reputation;
    /// Minimum payment in native units (18 decimals). Non-zero, whole ERC-20 units.
    uint256 public immutable minPayment;
    /// Address whose signatures are accepted as trust permits.
    address public immutable checker;
    /// Lowest trust score (out of 10) that may review.
    uint8 public immutable minTrustScore;

    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;

    struct Receipt {
        address payer;
        uint256 agentId;
        uint256 amount;
        bool reviewed;
    }

    /// The checker's signed verdict on a payer for one receipt.
    struct TrustPermit {
        uint8 trustScore;
        bytes32 reportHash;
        uint64 deadline;
    }

    /// The payer's live rating for an agent. index 0 means none: the registry's
    /// feedback indices are 1-based (verified on Arc mainnet).
    struct LiveRating {
        uint64 index;
        int128 score;
    }

    /// Native USDC held for each address (Hold mode, or a failed Instant forward).
    mapping(address => uint256) public owed;
    /// Payment receipts by id. Ids start at 1; payer == address(0) means no such receipt.
    mapping(uint256 => Receipt) public receipts;
    /// Id the next pay() will return.
    uint256 public nextReceiptId = 1;
    /// True if the agent's owner chose Hold: payments are held instead of forwarded.
    mapping(uint256 agentId => bool) public holdPayouts;
    /// Reviews that could not be posted because the owner had approved the gate.
    mapping(uint256 agentId => uint256) public blockedReviews;
    /// Number of live paid ratings per agent (one per payer wallet).
    mapping(uint256 agentId => uint256) public liveCount;
    /// Sum of the live paid scores per agent.
    mapping(uint256 agentId => int256) public liveSum;

    mapping(uint256 agentId => mapping(address payer => LiveRating)) private _live;
    uint256 private _locked = 1;

    /// @param instant true if the payment reached the payee now, false if it is held in `owed`.
    event Paid(
        uint256 indexed receiptId,
        uint256 indexed agentId,
        address indexed payer,
        address payee,
        uint256 amount,
        bool instant
    );
    /// @param feedbackIndex  registry index of the new rating (client = this contract).
    /// @param replacedIndex  registry index of the payer's earlier rating for this agent
    ///                       that was replaced, or 0 if there was none.
    event PaidReview(
        uint256 indexed receiptId,
        uint256 indexed agentId,
        address indexed payer,
        uint64 feedbackIndex,
        uint64 replacedIndex,
        int128 score,
        string tag2,
        bytes32 feedbackHash
    );
    /// The checker verdict a review was accepted with.
    event ReviewTrust(uint256 indexed receiptId, uint8 trustScore, bytes32 reportHash);
    /// A review the registry could not take because the owner had approved the gate.
    /// The receipt is used up and counted in blockedReviews; no rating is posted.
    event ReviewBlocked(
        uint256 indexed receiptId, uint256 indexed agentId, address indexed payer, int128 score, string tag2
    );
    event PayoutModeSet(uint256 indexed agentId, bool hold);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    error ZeroAddress();
    error BadMinPayment(uint256 minPayment);
    error BadMinTrustScore(uint8 minTrustScore);
    error RegistryMismatch(address expected, address actual);
    error PaymentTooSmall(uint256 sent, uint256 required);
    error AmountNotWholeErc20Units(uint256 sent);
    error ScoreOutOfRange(int128 score);
    error Tag2TooLong(uint256 length);
    error FeedbackURITooLong(uint256 length);
    error SelfReview();
    error AgentBlocksPaidReviews(uint256 agentId);
    error NotAgentOwner(uint256 agentId);
    error UnknownReceipt(uint256 receiptId);
    error NotReceiptPayer(uint256 receiptId);
    error ReceiptAlreadyUsed(uint256 receiptId);
    error PermitExpired(uint64 deadline);
    error BadPermitSignature();
    error TrustScoreTooLow(uint8 trustScore, uint8 required);
    error NothingOwed();
    error WithdrawFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address identity_, address reputation_, uint256 minPayment_, address checker_, uint8 minTrustScore_) {
        if (identity_ == address(0) || reputation_ == address(0) || checker_ == address(0)) revert ZeroAddress();
        if (minPayment_ == 0 || minPayment_ % NATIVE_PER_ERC20_UNIT != 0) revert BadMinPayment(minPayment_);
        if (minTrustScore_ == 0 || minTrustScore_ > MAX_TRUST_SCORE) revert BadMinTrustScore(minTrustScore_);
        address linked = IReputationRegistry(reputation_).getIdentityRegistry();
        if (linked != identity_) revert RegistryMismatch(identity_, linked);

        identity = IIdentityRegistry(identity_);
        reputation = IReputationRegistry(reputation_);
        minPayment = minPayment_;
        checker = checker_;
        minTrustScore = minTrustScore_;
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    // ------------------------------------------------------------------ payment

    /// @notice Pay an agent exactly msg.value of native USDC and get a receipt that allows
    ///         one trust-checked rating later. The agent receives the whole amount: now
    ///         (Instant, the default) or held for withdraw (Hold, or if the forward fails).
    /// @param agentId ERC-8004 agent id being paid.
    /// @return receiptId id to pass to review(); only msg.sender can use it.
    function pay(uint256 agentId) external payable nonReentrant returns (uint256 receiptId) {
        if (msg.value < minPayment) revert PaymentTooSmall(msg.value, minPayment);
        if (msg.value % NATIVE_PER_ERC20_UNIT != 0) revert AmountNotWholeErc20Units(msg.value);

        address payee = _checkCaller(agentId);
        if (_gateApproved(agentId)) revert AgentBlocksPaidReviews(agentId);

        receiptId = nextReceiptId++;
        receipts[receiptId] = Receipt({payer: msg.sender, agentId: agentId, amount: msg.value, reviewed: false});

        bool instant = false;
        if (!holdPayouts[agentId]) {
            // Gas-capped forward that ignores return data, so the payee cannot make the
            // payer pay to copy a huge return value.
            assembly ("memory-safe") {
                instant := call(PUSH_GAS, payee, callvalue(), 0, 0, 0, 0)
            }
        }
        if (!instant) owed[payee] += msg.value;

        emit Paid(receiptId, agentId, msg.sender, payee, msg.value, instant);
    }

    /// @notice The agent's owner (or an approved operator) chooses how payments arrive:
    ///         hold = false forwards each payment at once (default), hold = true keeps
    ///         payments here until withdraw.
    function setHoldPayouts(uint256 agentId, bool hold) external {
        if (!identity.isAuthorizedOrOwner(msg.sender, agentId)) revert NotAgentOwner(agentId);
        holdPayouts[agentId] = hold;
        emit PayoutModeSet(agentId, hold);
    }

    // ------------------------------------------------------------------ review

    /// @notice Rate the agent of an unused receipt with a trust permit from the checker.
    ///         Only the receipt's payer can call this, once per receipt. If the payer
    ///         already has a live rating for the agent, it is revoked and replaced.
    ///         Ownership and approvals can change between pay and review, so the
    ///         self-review check runs again here. If the owner has approved the gate, the
    ///         review is recorded as blocked instead of reverting.
    /// @param receiptId    id returned by pay().
    /// @param score        0..100.
    /// @param tag2         Free-form second tag, at most 64 bytes.
    /// @param feedbackURI  Optional URI with the written review, at most 512 bytes.
    /// @param feedbackHash keccak256 of the content at feedbackURI, or zero (ERC-8004).
    /// @param permit       The checker's verdict for this receipt and payer.
    /// @param signature    The checker's 65-byte EIP-712 signature over the permit.
    function review(
        uint256 receiptId,
        int128 score,
        string calldata tag2,
        string calldata feedbackURI,
        bytes32 feedbackHash,
        TrustPermit calldata permit,
        bytes calldata signature
    ) external nonReentrant {
        Receipt storage r = receipts[receiptId];
        if (r.payer == address(0)) revert UnknownReceipt(receiptId);
        if (r.payer != msg.sender) revert NotReceiptPayer(receiptId);
        if (r.reviewed) revert ReceiptAlreadyUsed(receiptId);
        if (score < 0 || score > MAX_SCORE) revert ScoreOutOfRange(score);
        if (bytes(tag2).length > MAX_TAG2_BYTES) revert Tag2TooLong(bytes(tag2).length);
        if (bytes(feedbackURI).length > MAX_URI_BYTES) revert FeedbackURITooLong(bytes(feedbackURI).length);

        uint256 agentId = r.agentId;
        _verifyPermit(receiptId, agentId, permit, signature);

        // Mark used before any external call.
        r.reviewed = true;
        _checkCaller(agentId);
        emit ReviewTrust(receiptId, permit.trustScore, permit.reportHash);

        if (_gateApproved(agentId)) {
            blockedReviews[agentId] += 1;
            emit ReviewBlocked(receiptId, agentId, msg.sender, score, tag2);
            return;
        }

        _postRating(receiptId, agentId, score, tag2, feedbackURI, feedbackHash);
    }

    // ------------------------------------------------------------------ withdraw

    /// @notice Withdraw the caller's whole held balance to `to`. If `to` cannot receive
    ///         native USDC the call reverts and the balance stays owed; retry elsewhere.
    function withdraw(address payable to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _payout(msg.sender, to);
    }

    /// @notice Anyone can push `account`'s whole held balance to `account` itself, for
    ///         payees that cannot call withdraw.
    function withdrawFor(address account) external nonReentrant {
        _payout(account, payable(account));
    }

    // ------------------------------------------------------------------ views

    /// @notice EIP-712 domain separator for trust permits.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    /// @notice The digest the checker signs for a permit. Lets the off-chain checker
    ///         confirm it hashes exactly what this contract verifies.
    function permitDigest(uint256 receiptId, address payer, uint256 agentId, TrustPermit calldata permit)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_TYPEHASH, receiptId, payer, agentId, permit.trustScore, permit.reportHash, permit.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    /// @notice Registry index of the payer's live rating for the agent, 0 if none.
    function activeIndex(uint256 agentId, address payer) external view returns (uint64) {
        return _live[agentId][payer].index;
    }

    /// @notice Score of the payer's live rating for the agent (meaningful only if
    ///         activeIndex is non-zero).
    function activeScore(uint256 agentId, address payer) external view returns (int128) {
        return _live[agentId][payer].score;
    }

    /// @notice Live paid ratings for the agent: how many, and the sum of their scores.
    function liveScore(uint256 agentId) external view returns (uint256 count, int256 sum) {
        return (liveCount[agentId], liveSum[agentId]);
    }

    /// @notice Average live paid score, truncated like the registry's getSummary; 0 if none.
    function liveAverage(uint256 agentId) external view returns (int256) {
        uint256 n = liveCount[agentId];
        return n == 0 ? int256(0) : liveSum[agentId] / int256(n);
    }

    // ------------------------------------------------------------------ internals

    function _verifyPermit(uint256 receiptId, uint256 agentId, TrustPermit calldata permit, bytes calldata signature)
        internal
        view
    {
        if (block.timestamp > permit.deadline) revert PermitExpired(permit.deadline);
        if (_recover(permitDigest(receiptId, msg.sender, agentId, permit), signature) != checker) {
            revert BadPermitSignature();
        }
        if (permit.trustScore < minTrustScore) revert TrustScoreTooLow(permit.trustScore, minTrustScore);
    }

    function _postRating(
        uint256 receiptId,
        uint256 agentId,
        int128 score,
        string calldata tag2,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) internal {
        LiveRating memory old = _live[agentId][msg.sender];
        if (old.index != 0) {
            // Skip the revoke if the entry is already revoked, so a payer can never be
            // locked out by the registry's "Already revoked" revert.
            (,,,, bool isRevoked) = reputation.readFeedback(agentId, address(this), old.index);
            if (!isRevoked) reputation.revokeFeedback(agentId, old.index);
            liveSum[agentId] -= old.score;
        } else {
            liveCount[agentId] += 1;
        }

        reputation.giveFeedback(agentId, score, 0, TAG, tag2, "", feedbackURI, feedbackHash);
        uint64 feedbackIndex = reputation.getLastIndex(agentId, address(this));
        _live[agentId][msg.sender] = LiveRating({index: feedbackIndex, score: score});
        liveSum[agentId] += score;

        emit PaidReview(receiptId, agentId, msg.sender, feedbackIndex, old.index, score, tag2, feedbackHash);
    }

    function _payout(address account, address payable to) internal {
        uint256 amount = owed[account];
        if (amount == 0) revert NothingOwed();
        owed[account] = 0;
        emit Withdrawn(account, to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    /// Returns the current payee (agent wallet if set, else owner) and reverts if
    /// msg.sender is the payee, the owner or an approved operator. Reverts with the
    /// registry's own error for a nonexistent agent.
    function _checkCaller(uint256 agentId) internal view returns (address payee) {
        payee = identity.ownerOf(agentId);
        address wallet = identity.getAgentWallet(agentId);
        if (wallet != address(0)) payee = wallet;
        if (msg.sender == payee || identity.isAuthorizedOrOwner(msg.sender, agentId)) revert SelfReview();
    }

    /// True if the owner approved this gate; the registry would then reject the gate's
    /// ratings as self-feedback.
    function _gateApproved(uint256 agentId) internal view returns (bool) {
        return identity.isAuthorizedOrOwner(address(this), agentId);
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("PaidReviews"), keccak256("1"), block.chainid, address(this))
        );
    }

    /// ecrecover with the standard malleability and length checks. Returns address(0)
    /// for any invalid signature, which never equals the non-zero checker.
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
