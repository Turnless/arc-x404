// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PaidReviews} from "../src/PaidReviews.sol";
import {PayDemo} from "../script/PayDemo.s.sol";

interface IId {
    function register(string calldata agentURI) external returns (uint256);
    function ownerOf(uint256) external view returns (address);
    function getAgentWallet(uint256) external view returns (address);
    function isAuthorizedOrOwner(address, uint256) external view returns (bool);
    function setApprovalForAll(address, bool) external;
    function approve(address, uint256) external;
    function transferFrom(address, address, uint256) external;
}

interface IRep {
    function getSummary(uint256 agentId, address[] calldata clients, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
    function getLastIndex(uint256 agentId, address client) external view returns (uint64);
    function giveFeedback(uint256, int128, uint8, string calldata, string calldata, string calldata, string calldata, bytes32)
        external;
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;
    function readFeedback(uint256 agentId, address client, uint64 index)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);
}

/// Payee code used with vm.etch. Tries to re-enter the gate with the money it receives.
contract ReentrantPayee {
    PaidReviews immutable gate;
    uint256 immutable agentId;
    uint256 public calls; // slot 0 of whatever address this code is etched onto

    constructor(PaidReviews g, uint256 id) {
        gate = g;
        agentId = id;
    }

    receive() external payable {
        calls++;
        gate.pay{value: msg.value}(agentId);
    }
}

/// A payee that can receive native USDC but has no way to call withdraw.
contract AcceptOnlyPayee {
    receive() external payable {}
}

/// Withdraw recipient that tries to pay another agent from inside its receive hook.
contract PayOnReceive {
    PaidReviews immutable gate;
    uint256 immutable otherAgent;

    constructor(PaidReviews g, uint256 a) {
        gate = g;
        otherAgent = a;
    }

    receive() external payable {
        gate.pay{value: msg.value}(otherAgent);
    }
}

/// Runs against Arc mainnet state: forge test --fork-url https://rpc.mainnet.arc.io
contract PaidReviewsForkTest is Test {
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    uint256 constant LIVE_AGENT = 1; // used only where wallet != owner is needed
    uint256 constant MIN = 10_000e12; // 0.01 USDC
    uint8 constant MIN_TRUST = 7;
    uint8 constant GOOD_TRUST = 8;
    uint256 constant SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    PaidReviews gate;
    address checker;
    uint256 checkerKey;
    address payer = makeAddr("payer");
    address payer2 = makeAddr("payer2");
    address payer3 = makeAddr("payer3");
    address agentOwner = makeAddr("agentOwner");
    uint256 agentId;
    uint256 agentId2;

    function setUp() public {
        (checker, checkerKey) = makeAddrAndKey("checker");
        gate = new PaidReviews(IDENTITY, REPUTATION, MIN, checker, MIN_TRUST);
        vm.startPrank(agentOwner);
        agentId = IId(IDENTITY).register("data:application/json,{\"name\":\"test-agent-1\"}");
        agentId2 = IId(IDENTITY).register("data:application/json,{\"name\":\"test-agent-2\"}");
        vm.stopPrank();
        vm.deal(payer, 100 ether);
        vm.deal(payer2, 100 ether);
        vm.deal(payer3, 100 ether);
    }

    // ---------------------------------------------------------------- helpers

    /// EIP-712 digest computed independently of the contract, to cross-check permitDigest.
    function _digest(PaidReviews g, uint256 rid, address p, uint256 aid, PaidReviews.TrustPermit memory pm)
        internal
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("PaidReviews"),
                keccak256("1"),
                block.chainid,
                address(g)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "ReviewPermit(uint256 receiptId,address payer,uint256 agentId,uint8 trustScore,bytes32 reportHash,uint64 deadline)"
                ),
                rid,
                p,
                aid,
                pm.trustScore,
                pm.reportHash,
                pm.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _signWith(uint256 key, PaidReviews g, uint256 rid, address p, uint256 aid, PaidReviews.TrustPermit memory pm)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(g, rid, p, aid, pm));
        return abi.encodePacked(r, s, v);
    }

    function _permitFor(uint256 rid, address p, uint256 aid, uint8 trust)
        internal
        view
        returns (PaidReviews.TrustPermit memory pm, bytes memory sig)
    {
        pm = PaidReviews.TrustPermit({
            trustScore: trust,
            reportHash: keccak256(abi.encode("report", rid, p)),
            deadline: uint64(block.timestamp + 1 hours)
        });
        sig = _signWith(checkerKey, gate, rid, p, aid, pm);
    }

    function _pay(address from, uint256 id, uint256 amount) internal returns (uint256 rid) {
        vm.prank(from);
        rid = gate.pay{value: amount}(id);
    }

    /// Review with a valid checker permit (trust 8) for `id`.
    function _rateAgent(address from, uint256 rid, uint256 id, int128 score) internal {
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(rid, from, id, GOOD_TRUST);
        vm.prank(from);
        gate.review(rid, score, "demo", "", bytes32(0), pm, sig);
    }

    function _rate(address from, uint256 rid, int128 score) internal {
        (, uint256 id,,) = gate.receipts(rid);
        _rateAgent(from, rid, id, score);
    }

    function _payAndRate(address from, uint256 id, uint256 amount, int128 score) internal returns (uint256 rid) {
        rid = _pay(from, id, amount);
        _rateAgent(from, rid, id, score);
    }

    function _hold(uint256 id) internal {
        vm.prank(agentOwner);
        gate.setHoldPayouts(id, true);
    }

    function _sum(uint256 id) internal view returns (uint64 count, int128 value) {
        address[] memory only = new address[](1);
        only[0] = address(gate);
        (count, value,) = IRep(REPUTATION).getSummary(id, only, "paid-review", "");
    }

    function _receipt(uint256 rid) internal view returns (address p, uint256 a, uint256 amt, bool used) {
        (p, a, amt, used) = gate.receipts(rid);
    }

    /// The gate's O(1) aggregates must agree with the registry's gate-filtered summary.
    function _assertAggregatesMatch(uint256 id) internal view {
        (uint64 c, int128 v) = _sum(id);
        (uint256 n, int256 s) = gate.liveScore(id);
        assertEq(n, c, "liveCount == getSummary count");
        if (n > 0) assertEq(gate.liveAverage(id), int256(v), "liveAverage == getSummary average");
        else assertEq(s, 0);
    }

    function _bytesOf(uint256 n) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; i++) b[i] = "a";
    }

    // ---------------------------------------------------------------- registry behaviour the design relies on

    /// Observed on the deployed ReputationRegistry: indices are 1-based, the original
    /// client can revoke, revoked feedback drops out of getSummary, getLastIndex does not
    /// move on revoke, double revoke and index 0 revert, and other clients cannot touch it.
    function test_registryRevokeSemantics() public {
        address client = makeAddr("client");
        assertEq(IRep(REPUTATION).getLastIndex(agentId, client), 0, "0 before any feedback");

        vm.startPrank(client);
        IRep(REPUTATION).giveFeedback(agentId, 90, 0, "paid-review", "", "", "", bytes32(0));
        assertEq(IRep(REPUTATION).getLastIndex(agentId, client), 1, "first index is 1");
        IRep(REPUTATION).giveFeedback(agentId, 40, 0, "paid-review", "", "", "", bytes32(0));
        assertEq(IRep(REPUTATION).getLastIndex(agentId, client), 2);

        vm.expectRevert(bytes("index must be > 0"));
        IRep(REPUTATION).revokeFeedback(agentId, 0);

        IRep(REPUTATION).revokeFeedback(agentId, 1);
        assertEq(IRep(REPUTATION).getLastIndex(agentId, client), 2, "revoke does not move lastIndex");
        (int128 v,,,, bool revoked) = IRep(REPUTATION).readFeedback(agentId, client, 1);
        assertEq(v, 90);
        assertTrue(revoked);

        vm.expectRevert(bytes("Already revoked"));
        IRep(REPUTATION).revokeFeedback(agentId, 1);
        vm.stopPrank();

        address[] memory only = new address[](1);
        only[0] = client;
        (uint64 count, int128 value,) = IRep(REPUTATION).getSummary(agentId, only, "paid-review", "");
        assertEq(count, 1, "revoked feedback not counted");
        assertEq(value, 40, "revoked feedback not averaged");

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(bytes("index out of bounds"));
        IRep(REPUTATION).revokeFeedback(agentId, 2);
    }

    // ---------------------------------------------------------------- pay: instant (default)

    function test_freshAgentWalletDefaultsToOwner() public view {
        assertEq(IId(IDENTITY).ownerOf(agentId), agentOwner);
        assertEq(IId(IDENTITY).getAgentWallet(agentId), agentOwner);
    }

    function test_instantPayoutIsDefaultAndPaysFullAmount() public {
        uint256 amount = 0.1 ether; // 0.1 USDC
        uint256 payerBefore = payer.balance;
        uint256 ownerBefore = agentOwner.balance;
        assertFalse(gate.holdPayouts(agentId), "Instant by default");
        assertEq(gate.nextReceiptId(), 1, "ids start at 1");

        vm.expectEmit(true, true, true, true, address(gate));
        emit PaidReviews.Paid(1, agentId, payer, agentOwner, amount, true);
        uint256 rid = _pay(payer, agentId, amount);

        assertEq(rid, 1);
        assertEq(gate.nextReceiptId(), 2);
        (address p, uint256 a, uint256 amt, bool used) = _receipt(rid);
        assertEq(p, payer);
        assertEq(a, agentId);
        assertEq(amt, amount);
        assertFalse(used);

        assertEq(payer.balance, payerBefore - amount, "payer paid exactly the price");
        assertEq(agentOwner.balance, ownerBefore + amount, "agent got 100% at once");
        assertEq(gate.owed(agentOwner), 0);
        assertEq(address(gate).balance, 0, "nothing kept by the gate");

        (uint64 count,) = _sum(agentId);
        assertEq(count, 0, "paying alone posts no rating");
    }

    /// Instant forward with return data: ignored, still a success.
    function test_instantPayeeReturningDataStillPaid() public {
        vm.etch(agentOwner, hex"6110006000f3"); // PUSH2 0x1000 PUSH1 0 RETURN (4 KB of zeros)
        uint256 before_ = agentOwner.balance;
        _pay(payer, agentId, MIN);
        assertEq(agentOwner.balance, before_ + MIN);
        assertEq(gate.owed(agentOwner), 0);
    }

    // ---------------------------------------------------------------- pay: hostile payees under Instant

    function test_revertingPayeeFallsBackToHeld() public {
        vm.etch(agentOwner, hex"60006000fd"); // PUSH1 0 PUSH1 0 REVERT
        vm.expectEmit(true, true, true, true, address(gate));
        emit PaidReviews.Paid(1, agentId, payer, agentOwner, MIN, false);
        _pay(payer, agentId, MIN);
        assertEq(gate.owed(agentOwner), MIN, "held, not lost");
        assertEq(address(gate).balance, MIN);

        // and the payee cannot block the review either
        _rate(payer, 1, 5);
        (uint64 count, int128 value) = _sum(agentId);
        assertEq(count, 1);
        assertEq(value, 5);
    }

    function test_gasBurningPayeeIsCappedAndFallsBackToHeld() public {
        vm.etch(agentOwner, hex"5b600056"); // JUMPDEST PUSH1 0 JUMP: loops until out of gas
        vm.prank(payer);
        uint256 g0 = gasleft();
        gate.pay{value: MIN}(agentId);
        uint256 used = g0 - gasleft();
        console.log("pay gas with gas-burning payee (in-test)", used);
        assertLt(used, 300_000, "the payee can burn at most PUSH_GAS");
        assertEq(gate.owed(agentOwner), MIN);
    }

    function test_reentrantPayeeCannotReenterDuringInstantForward() public {
        ReentrantPayee tpl = new ReentrantPayee(gate, agentId2);
        vm.etch(agentOwner, address(tpl).code);
        _pay(payer, agentId, MIN);
        assertEq(gate.nextReceiptId(), 2, "no nested receipt");
        assertEq(gate.owed(agentOwner), MIN, "forward failed, payment held");
        assertEq(ReentrantPayee(payable(agentOwner)).calls(), 0, "the re-entry rolled back");
    }

    // ---------------------------------------------------------------- pay: hold mode

    function test_holdModeHoldsPaymentForWithdraw() public {
        vm.expectEmit(true, false, false, true, address(gate));
        emit PaidReviews.PayoutModeSet(agentId, true);
        _hold(agentId);
        assertTrue(gate.holdPayouts(agentId));

        uint256 ownerBefore = agentOwner.balance;
        vm.expectEmit(true, true, true, true, address(gate));
        emit PaidReviews.Paid(1, agentId, payer, agentOwner, 0.1 ether, false);
        _pay(payer, agentId, 0.1 ether);
        assertEq(agentOwner.balance, ownerBefore, "not forwarded");
        assertEq(gate.owed(agentOwner), 0.1 ether, "full amount held");
        assertEq(address(gate).balance, 0.1 ether);

        vm.prank(agentOwner);
        gate.withdraw(payable(agentOwner));
        assertEq(agentOwner.balance, ownerBefore + 0.1 ether, "agent got 100%");
    }

    function test_holdModeIsPerAgent() public {
        _hold(agentId);
        uint256 before_ = agentOwner.balance;
        _pay(payer, agentId2, MIN);
        assertEq(agentOwner.balance, before_ + MIN, "agent 2 still Instant");
        assertEq(gate.owed(agentOwner), 0);
    }

    function test_setHoldPayoutsOnlyOwnerOrOperator() public {
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.NotAgentOwner.selector, agentId));
        gate.setHoldPayouts(agentId, true);

        address op = makeAddr("operator");
        vm.prank(agentOwner);
        IId(IDENTITY).setApprovalForAll(op, true);
        vm.prank(op);
        gate.setHoldPayouts(agentId, true);
        assertTrue(gate.holdPayouts(agentId));

        vm.prank(agentOwner);
        gate.setHoldPayouts(agentId, false);
        assertFalse(gate.holdPayouts(agentId));
    }

    function test_heldPaymentsAccumulate() public {
        _hold(agentId);
        _hold(agentId2);
        _pay(payer, agentId, MIN);
        _pay(payer2, agentId, 3 * MIN);
        _pay(payer, agentId2, 2 * MIN);
        assertEq(gate.owed(agentOwner), 6 * MIN);
        assertEq(address(gate).balance, 6 * MIN);
        assertEq(gate.nextReceiptId(), 4);
    }

    function test_unreviewedPaymentStillPaid() public {
        uint256 before_ = agentOwner.balance;
        _pay(payer, agentId, 0.1 ether); // payer never rates
        assertEq(agentOwner.balance, before_ + 0.1 ether);
    }

    // ---------------------------------------------------------------- trust permits

    function test_reviewWithValidPermitPostsRating() public {
        uint256 rid = _pay(payer, agentId, MIN);
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(rid, payer, agentId, GOOD_TRUST);

        vm.expectEmit(true, false, false, true, address(gate));
        emit PaidReviews.ReviewTrust(rid, GOOD_TRUST, pm.reportHash);
        vm.prank(payer);
        gate.review(rid, 90, "demo", "", bytes32(0), pm, sig);

        (uint64 count, int128 value) = _sum(agentId);
        assertEq(count, 1);
        assertEq(value, 90);
        (,,, bool used) = _receipt(rid);
        assertTrue(used);
        assertEq(gate.activeIndex(agentId, payer), IRep(REPUTATION).getLastIndex(agentId, address(gate)));
        assertEq(gate.activeScore(agentId, payer), 90);
        _assertAggregatesMatch(agentId);
        (count,) = _sum(agentId2);
        assertEq(count, 0, "the other agent is untouched");
    }

    function test_permitDigestMatchesIndependentHash() public view {
        PaidReviews.TrustPermit memory pm =
            PaidReviews.TrustPermit({trustScore: 9, reportHash: keccak256("r"), deadline: 123});
        assertEq(gate.permitDigest(5, payer, agentId, pm), _digest(gate, 5, payer, agentId, pm));
    }

    /// The core rule: a payer below the threshold cannot review. The receipt stays unused.
    function test_trustScoreBelowMinRejected() public {
        uint256 rid = _pay(payer, agentId, MIN);
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(rid, payer, agentId, 6);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.TrustScoreTooLow.selector, 6, MIN_TRUST));
        gate.review(rid, 100, "demo", "", bytes32(0), pm, sig);
        (,,, bool used) = _receipt(rid);
        assertFalse(used);
        (uint64 count,) = _sum(agentId);
        assertEq(count, 0);
    }

    /// The owner's sock wallet (funded by the owner) scores 0 at the checker: it can pay,
    /// the agent keeps the money, but the sock can never post a rating.
    function test_sockWithZeroTrustCannotReview() public {
        address sock = makeAddr("sock");
        vm.deal(agentOwner, 1 ether);
        vm.prank(agentOwner);
        payable(sock).transfer(MIN);
        uint256 rid = _pay(sock, agentId, MIN);
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(rid, sock, agentId, 0);
        vm.prank(sock);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.TrustScoreTooLow.selector, 0, MIN_TRUST));
        gate.review(rid, 100, "demo", "", bytes32(0), pm, sig);
    }

    function test_trustScoreBoundaries() public {
        uint256 r1 = _pay(payer, agentId, MIN);
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(r1, payer, agentId, MIN_TRUST);
        vm.prank(payer);
        gate.review(r1, 70, "demo", "", bytes32(0), pm, sig);

        uint256 r2 = _pay(payer2, agentId, MIN);
        (pm, sig) = _permitFor(r2, payer2, agentId, 10);
        vm.prank(payer2);
        gate.review(r2, 80, "demo", "", bytes32(0), pm, sig);

        (uint64 count,) = _sum(agentId);
        assertEq(count, 2, "7 and 10 both accepted");
    }

    function test_reviewWithoutCheckerSignatureRejected() public {
        uint256 rid = _pay(payer, agentId, MIN);
        (, uint256 forgerKey) = makeAddrAndKey("forger");
        (PaidReviews.TrustPermit memory pm,) = _permitFor(rid, payer, agentId, 10);
        bytes memory forged = _signWith(forgerKey, gate, rid, payer, agentId, pm);
        vm.prank(payer);
        vm.expectRevert(PaidReviews.BadPermitSignature.selector);
        gate.review(rid, 100, "demo", "", bytes32(0), pm, forged);
    }

    /// A permit is bound to its receipt, payer, agent, score, report and deadline.
    function test_permitCannotBeAlteredOrMoved() public {
        uint256 r1 = _pay(payer, agentId, MIN);
        uint256 r2 = _pay(payer, agentId, MIN);
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(r1, payer, agentId, GOOD_TRUST);

        vm.startPrank(payer);
        // used on another receipt
        vm.expectRevert(PaidReviews.BadPermitSignature.selector);
        gate.review(r2, 90, "demo", "", bytes32(0), pm, sig);
        // trust score raised
        PaidReviews.TrustPermit memory bumped =
            PaidReviews.TrustPermit({trustScore: 10, reportHash: pm.reportHash, deadline: pm.deadline});
        vm.expectRevert(PaidReviews.BadPermitSignature.selector);
        gate.review(r1, 90, "demo", "", bytes32(0), bumped, sig);
        // report swapped
        PaidReviews.TrustPermit memory swapped =
            PaidReviews.TrustPermit({trustScore: pm.trustScore, reportHash: keccak256("other"), deadline: pm.deadline});
        vm.expectRevert(PaidReviews.BadPermitSignature.selector);
        gate.review(r1, 90, "demo", "", bytes32(0), swapped, sig);
        // deadline extended
        PaidReviews.TrustPermit memory extended =
            PaidReviews.TrustPermit({trustScore: pm.trustScore, reportHash: pm.reportHash, deadline: pm.deadline + 1});
        vm.expectRevert(PaidReviews.BadPermitSignature.selector);
        gate.review(r1, 90, "demo", "", bytes32(0), extended, sig);
        vm.stopPrank();

        // signed for payer, so no other receipt holder can use it either
        uint256 r3 = _pay(payer2, agentId, MIN);
        (PaidReviews.TrustPermit memory pm3, bytes memory sig3) = _permitFor(r3, payer, agentId, GOOD_TRUST);
        vm.prank(payer2);
        vm.expectRevert(PaidReviews.BadPermitSignature.selector);
        gate.review(r3, 90, "demo", "", bytes32(0), pm3, sig3);

        // and the untouched permit still works on its own receipt
        vm.prank(payer);
        gate.review(r1, 90, "demo", "", bytes32(0), pm, sig);
    }

    /// Signed for agent 2 but the receipt is for agent 1.
    function test_permitBoundToAgent() public {
        uint256 rid = _pay(payer, agentId, MIN);
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(rid, payer, agentId2, GOOD_TRUST);
        vm.prank(payer);
        vm.expectRevert(PaidReviews.BadPermitSignature.selector);
        gate.review(rid, 90, "demo", "", bytes32(0), pm, sig);
    }

    /// Same checker key, different gate: the EIP-712 domain stops replay.
    function test_permitCannotBeReplayedOnAnotherGate() public {
        PaidReviews other = new PaidReviews(IDENTITY, REPUTATION, MIN, checker, MIN_TRUST);
        vm.prank(payer);
        uint256 rid = other.pay{value: MIN}(agentId);
        uint256 rid0 = _pay(payer, agentId, MIN);
        assertEq(rid, rid0, "same receipt id on both gates");
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(rid0, payer, agentId, GOOD_TRUST);
        vm.prank(payer);
        vm.expectRevert(PaidReviews.BadPermitSignature.selector);
        other.review(rid, 90, "demo", "", bytes32(0), pm, sig);
    }

    function test_expiredPermitRejected() public {
        uint256 rid = _pay(payer, agentId, MIN);
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(rid, payer, agentId, GOOD_TRUST);
        vm.warp(uint256(pm.deadline) + 1);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.PermitExpired.selector, pm.deadline));
        gate.review(rid, 90, "demo", "", bytes32(0), pm, sig);
    }

    function test_permitAtDeadlineAccepted() public {
        uint256 rid = _pay(payer, agentId, MIN);
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(rid, payer, agentId, GOOD_TRUST);
        vm.warp(pm.deadline);
        vm.prank(payer);
        gate.review(rid, 90, "demo", "", bytes32(0), pm, sig);
    }

    function test_malleableSignatureRejected() public {
        uint256 rid = _pay(payer, agentId, MIN);
        (PaidReviews.TrustPermit memory pm,) = _permitFor(rid, payer, agentId, GOOD_TRUST);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(checkerKey, _digest(gate, rid, payer, agentId, pm));
        bytes memory flipped = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.prank(payer);
        vm.expectRevert(PaidReviews.BadPermitSignature.selector);
        gate.review(rid, 90, "demo", "", bytes32(0), pm, flipped);
    }

    function test_badSignatureLengthAndVRejected() public {
        uint256 rid = _pay(payer, agentId, MIN);
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(rid, payer, agentId, GOOD_TRUST);
        bytes memory short = new bytes(64);
        for (uint256 i; i < 64; i++) short[i] = sig[i];
        bytes memory badV = bytes.concat(short, bytes1(uint8(29)));

        vm.startPrank(payer);
        vm.expectRevert(PaidReviews.BadPermitSignature.selector);
        gate.review(rid, 90, "demo", "", bytes32(0), pm, short);
        vm.expectRevert(PaidReviews.BadPermitSignature.selector);
        gate.review(rid, 90, "demo", "", bytes32(0), pm, badV);
        vm.expectRevert(PaidReviews.BadPermitSignature.selector);
        gate.review(rid, 90, "demo", "", bytes32(0), pm, "");
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- receipts and ratings

    /// The 'address that never paid' case: a non-payer cannot use someone else's receipt.
    function test_reviewByNonPayerReverts() public {
        uint256 rid = _pay(payer, agentId, MIN);
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(rid, payer2, agentId, 10);
        vm.prank(payer2);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.NotReceiptPayer.selector, rid));
        gate.review(rid, 100, "demo", "", bytes32(0), pm, sig);
        _rate(payer, rid, 70);
        (uint64 count, int128 value) = _sum(agentId);
        assertEq(count, 1);
        assertEq(value, 70);
    }

    function test_unknownReceiptReverts() public {
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(0, payer, agentId, 10);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.UnknownReceipt.selector, 0));
        gate.review(0, 50, "demo", "", bytes32(0), pm, sig);

        _pay(payer, agentId, MIN);
        uint256 next = gate.nextReceiptId();
        (pm, sig) = _permitFor(next, payer, agentId, 10);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.UnknownReceipt.selector, next));
        gate.review(next, 50, "demo", "", bytes32(0), pm, sig);
    }

    function test_receiptAndPermitCannotBeReused() public {
        uint256 rid = _pay(payer, agentId, MIN);
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(rid, payer, agentId, GOOD_TRUST);
        vm.startPrank(payer);
        gate.review(rid, 90, "demo", "", bytes32(0), pm, sig);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.ReceiptAlreadyUsed.selector, rid));
        gate.review(rid, 10, "demo", "", bytes32(0), pm, sig);
        vm.stopPrank();
        (uint64 count, int128 value) = _sum(agentId);
        assertEq(count, 1);
        assertEq(value, 90);
    }

    function test_scoreOutOfRangeRejectedAndReceiptKept() public {
        uint256 rid = _pay(payer, agentId, MIN);
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(rid, payer, agentId, GOOD_TRUST);
        vm.startPrank(payer);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.ScoreOutOfRange.selector, int128(101)));
        gate.review(rid, 101, "demo", "", bytes32(0), pm, sig);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.ScoreOutOfRange.selector, int128(-1)));
        gate.review(rid, -1, "demo", "", bytes32(0), pm, sig);
        vm.stopPrank();
        (,,, bool used) = _receipt(rid);
        assertFalse(used);
        _rate(payer, rid, 0);
    }

    function test_boundaryScoresAccepted() public {
        _payAndRate(payer, agentId, MIN, 0);
        _payAndRate(payer2, agentId, MIN, 100);
        (uint64 count, int128 value) = _sum(agentId);
        assertEq(count, 2);
        assertEq(value, 50);
        _assertAggregatesMatch(agentId);
    }

    function test_lengthCaps() public {
        uint256 rid = _pay(payer, agentId, MIN);
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(rid, payer, agentId, GOOD_TRUST);
        vm.startPrank(payer);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.Tag2TooLong.selector, 65));
        gate.review(rid, 50, string(_bytesOf(65)), "", bytes32(0), pm, sig);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.FeedbackURITooLong.selector, 513));
        gate.review(rid, 50, "", string(_bytesOf(513)), bytes32(0), pm, sig);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.Tag2TooLong.selector, 8192));
        gate.review(rid, 50, string(_bytesOf(8192)), "", bytes32(0), pm, sig);
        gate.review(rid, 50, string(_bytesOf(64)), string(_bytesOf(512)), bytes32(0), pm, sig);
        vm.stopPrank();
        (uint64 count,) = _sum(agentId);
        assertEq(count, 1);
    }

    function test_twoDifferentPayersCountTwo() public {
        _payAndRate(payer, agentId, MIN, 95);
        _payAndRate(payer2, agentId, MIN, 80);
        (uint64 count, int128 value) = _sum(agentId);
        assertEq(count, 2);
        assertEq(value, 87, "average truncated at 0 decimals");
        _assertAggregatesMatch(agentId);
    }

    function test_payerPaysTwiceAndReRates() public {
        _payAndRate(payer, agentId, MIN, 95);
        uint64 first = gate.activeIndex(agentId, payer);
        assertEq(first, 1, "fresh gate: first registry index is 1");

        _payAndRate(payer, agentId, MIN, 40);
        uint64 second = gate.activeIndex(agentId, payer);
        assertEq(second, 2);

        (uint64 count, int128 value) = _sum(agentId);
        assertEq(count, 1, "one live rating per payer");
        assertEq(value, 40, "latest rating wins");
        (,,,, bool revoked) = IRep(REPUTATION).readFeedback(agentId, address(gate), first);
        assertTrue(revoked, "old rating revoked in the registry");
        _assertAggregatesMatch(agentId);

        _payAndRate(payer, agentId, MIN, 60);
        (count, value) = _sum(agentId);
        assertEq(count, 1);
        assertEq(value, 60);
    }

    function test_reviewOlderReceiptLastStillReplaces() public {
        uint256 big = _pay(payer, agentId, 1 ether);
        uint256 small = _pay(payer, agentId, MIN);
        _rate(payer, big, 20);
        _rate(payer, small, 85);
        (uint64 count, int128 value) = _sum(agentId);
        assertEq(count, 1);
        assertEq(value, 85);
        _assertAggregatesMatch(agentId);
    }

    function test_reRatingIsolatedPerAgentAndPayer() public {
        _payAndRate(payer, agentId, MIN, 90);
        _payAndRate(payer, agentId2, MIN, 30);
        _payAndRate(payer2, agentId, MIN, 10);
        _payAndRate(payer, agentId, MIN, 70);
        (uint64 c1, int128 v1) = _sum(agentId);
        (uint64 c2, int128 v2) = _sum(agentId2);
        assertEq(c1, 2);
        assertEq(v1, 40);
        assertEq(c2, 1);
        assertEq(v2, 30);
        _assertAggregatesMatch(agentId);
        _assertAggregatesMatch(agentId2);
    }

    function test_aggregatesMatchSummaryThroughReplacements() public {
        _payAndRate(payer, agentId, MIN, 10);
        _payAndRate(payer2, agentId, MIN, 100);
        _payAndRate(payer, agentId, MIN, 55);
        _payAndRate(payer3, agentId, MIN, 0);
        _payAndRate(payer2, agentId, MIN, 33);
        _payAndRate(payer3, agentId, MIN, 99);
        (uint256 n, int256 s) = gate.liveScore(agentId);
        assertEq(n, 3);
        assertEq(s, 55 + 33 + 99);
        _assertAggregatesMatch(agentId);
    }

    function test_alreadyRevokedEntryDoesNotBrickPayer() public {
        _payAndRate(payer, agentId, MIN, 90);
        uint64 idx = gate.activeIndex(agentId, payer);
        vm.prank(address(gate)); // simulate an out-of-band revoke of the gate's entry
        IRep(REPUTATION).revokeFeedback(agentId, idx);

        uint256 rid = _pay(payer, agentId, MIN);
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(rid, payer, agentId, GOOD_TRUST);
        vm.expectEmit(true, true, true, true, address(gate));
        emit PaidReviews.PaidReview(rid, agentId, payer, idx + 1, idx, 40, "demo", bytes32(0));
        vm.prank(payer);
        gate.review(rid, 40, "demo", "", bytes32(0), pm, sig);

        (uint64 count, int128 value) = _sum(agentId);
        assertEq(count, 1);
        assertEq(value, 40);
        _assertAggregatesMatch(agentId);
    }

    function test_paidReviewEventFieldsFirstAndReplacement() public {
        uint256 r1 = _pay(payer, agentId, MIN);
        uint256 r2 = _pay(payer, agentId, MIN);
        uint64 base = IRep(REPUTATION).getLastIndex(agentId, address(gate));
        bytes32 h = keccak256("review body");
        (PaidReviews.TrustPermit memory pm1, bytes memory s1) = _permitFor(r1, payer, agentId, GOOD_TRUST);
        (PaidReviews.TrustPermit memory pm2, bytes memory s2) = _permitFor(r2, payer, agentId, GOOD_TRUST);

        vm.expectEmit(true, true, true, true, address(gate));
        emit PaidReviews.PaidReview(r1, agentId, payer, base + 1, 0, 77, "translation", h);
        vm.prank(payer);
        gate.review(r1, 77, "translation", "ipfs://review", h, pm1, s1);

        vm.expectEmit(true, true, true, true, address(gate));
        emit PaidReviews.PaidReview(r2, agentId, payer, base + 2, base + 1, 55, "translation", bytes32(0));
        vm.prank(payer);
        gate.review(r2, 55, "translation", "", bytes32(0), pm2, s2);
    }

    // ---------------------------------------------------------------- withdraw (Hold mode)

    function test_withdrawToSelfAndElsewhere() public {
        _hold(agentId);
        _payAndRate(payer, agentId, 0.1 ether, 90);
        uint256 before_ = agentOwner.balance;

        vm.expectEmit(true, true, false, true, address(gate));
        emit PaidReviews.Withdrawn(agentOwner, agentOwner, 0.1 ether);
        vm.prank(agentOwner);
        gate.withdraw(payable(agentOwner));
        assertEq(agentOwner.balance, before_ + 0.1 ether);
        assertEq(gate.owed(agentOwner), 0);
        assertEq(address(gate).balance, 0);

        _pay(payer, agentId, MIN);
        address cold = makeAddr("cold");
        vm.prank(agentOwner);
        gate.withdraw(payable(cold));
        assertEq(cold.balance, MIN);
    }

    function test_withdrawRejections() public {
        vm.prank(agentOwner);
        vm.expectRevert(PaidReviews.NothingOwed.selector);
        gate.withdraw(payable(agentOwner));

        _hold(agentId);
        _pay(payer, agentId, MIN);
        vm.startPrank(agentOwner);
        vm.expectRevert(PaidReviews.ZeroAddress.selector);
        gate.withdraw(payable(address(0)));
        gate.withdraw(payable(agentOwner));
        vm.expectRevert(PaidReviews.NothingOwed.selector);
        gate.withdraw(payable(agentOwner));
        vm.stopPrank();
    }

    function test_withdrawForContractPayee() public {
        AcceptOnlyPayee tpl = new AcceptOnlyPayee();
        vm.etch(agentOwner, address(tpl).code);
        _hold(agentId);
        _pay(payer, agentId, 0.1 ether);
        uint256 before_ = agentOwner.balance;
        vm.prank(makeAddr("anyone"));
        gate.withdrawFor(agentOwner);
        assertEq(agentOwner.balance, before_ + 0.1 ether);
        vm.expectRevert(PaidReviews.NothingOwed.selector);
        gate.withdrawFor(agentOwner);
    }

    function test_withdrawForRevertingPayeeKeepsBalance() public {
        vm.etch(agentOwner, hex"60006000fd");
        _pay(payer, agentId, MIN); // Instant forward fails, so it is held
        vm.expectRevert(PaidReviews.WithdrawFailed.selector);
        gate.withdrawFor(agentOwner);
        assertEq(gate.owed(agentOwner), MIN);
        // the owner can still pull it to a working address
        address cold = makeAddr("cold");
        vm.prank(agentOwner);
        gate.withdraw(payable(cold));
        assertEq(cold.balance, MIN);
    }

    /// pay is locked too now: a withdraw recipient cannot pay from its receive hook, so
    /// the withdraw fails and the balance stays owed.
    function test_withdrawCallbackCannotReenterPay() public {
        _hold(agentId);
        _pay(payer, agentId, 1 ether);
        PayOnReceive sink = new PayOnReceive(gate, agentId2);
        vm.prank(agentOwner);
        vm.expectRevert(PaidReviews.WithdrawFailed.selector);
        gate.withdraw(payable(address(sink)));
        assertEq(gate.owed(agentOwner), 1 ether);
        assertEq(gate.nextReceiptId(), 2);
    }

    // ---------------------------------------------------------------- payment rejections

    function test_paymentAmountRules() public {
        vm.startPrank(payer);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.PaymentTooSmall.selector, 0, MIN));
        gate.pay(agentId);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.PaymentTooSmall.selector, MIN - 1e12, MIN));
        gate.pay{value: MIN - 1e12}(agentId);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.AmountNotWholeErc20Units.selector, MIN + 1));
        gate.pay{value: MIN + 1}(agentId);
        uint256 rid = gate.pay{value: MIN}(agentId);
        vm.stopPrank();
        (,, uint256 amt,) = _receipt(rid);
        assertEq(amt, MIN, "exactly the minimum is accepted");
    }

    function test_nonexistentAgentReverts() public {
        uint256 bogus = 999_999_999;
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSignature("ERC721NonexistentToken(uint256)", bogus));
        gate.pay{value: MIN}(bogus);
    }

    // ---------------------------------------------------------------- self-review at pay time

    function test_ownerSelfPayBlocked() public {
        vm.deal(agentOwner, 1 ether);
        vm.prank(agentOwner);
        vm.expectRevert(PaidReviews.SelfReview.selector);
        gate.pay{value: MIN}(agentId);
    }

    function test_operatorsCannotPay() public {
        address op = makeAddr("operator");
        address one = makeAddr("approved");
        vm.startPrank(agentOwner);
        IId(IDENTITY).setApprovalForAll(op, true);
        IId(IDENTITY).approve(one, agentId2);
        vm.stopPrank();
        vm.deal(op, 1 ether);
        vm.deal(one, 1 ether);
        vm.prank(op);
        vm.expectRevert(PaidReviews.SelfReview.selector);
        gate.pay{value: MIN}(agentId);
        vm.prank(one);
        vm.expectRevert(PaidReviews.SelfReview.selector);
        gate.pay{value: MIN}(agentId2);
    }

    /// Live agent 1 has a payment wallet that differs from its owner. Both are read at runtime.
    function test_walletDiffersFromOwner_paysWalletAndBlocksWalletSelfReview() public {
        address owner_ = IId(IDENTITY).ownerOf(LIVE_AGENT);
        address wallet = IId(IDENTITY).getAgentWallet(LIVE_AGENT);
        if (wallet == address(0) || wallet == owner_) vm.skip(true);

        uint256 before_ = wallet.balance + gate.owed(wallet);
        _payAndRate(payer, LIVE_AGENT, 0.1 ether, 88);
        assertEq(wallet.balance + gate.owed(wallet), before_ + 0.1 ether, "wallet paid (or held for it)");
        assertEq(gate.owed(owner_), 0, "owner not credited");

        vm.deal(wallet, 1 ether);
        vm.prank(wallet);
        vm.expectRevert(PaidReviews.SelfReview.selector);
        gate.pay{value: MIN}(LIVE_AGENT);
    }

    function test_payeeFallsBackToOwnerWhenWalletUnset() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(agentOwner);
        IId(IDENTITY).transferFrom(agentOwner, newOwner, agentId);
        assertEq(IId(IDENTITY).getAgentWallet(agentId), address(0));

        uint256 before_ = newOwner.balance;
        _pay(payer, agentId, 0.1 ether);
        assertEq(newOwner.balance, before_ + 0.1 ether);
    }

    function test_agentZeroExistsWithUnrelatedOwner() public view {
        address stranger = IId(IDENTITY).ownerOf(0);
        assertTrue(stranger != address(0));
        assertTrue(stranger != agentOwner);
    }

    // ---------------------------------------------------------------- owner blocks the gate

    function test_ownerApprovingGateBlocksPay() public {
        vm.startPrank(agentOwner);
        IId(IDENTITY).approve(address(gate), agentId);
        IId(IDENTITY).setApprovalForAll(address(gate), true);
        vm.stopPrank();
        vm.startPrank(payer);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.AgentBlocksPaidReviews.selector, agentId));
        gate.pay{value: MIN}(agentId);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.AgentBlocksPaidReviews.selector, agentId2));
        gate.pay{value: MIN}(agentId2);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- state changes between pay and review

    function test_ownerApprovesGateAfterPay_reviewRecordedAsBlocked() public {
        uint256 rid = _pay(payer, agentId, MIN);
        vm.prank(agentOwner);
        IId(IDENTITY).approve(address(gate), agentId);

        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(rid, payer, agentId, GOOD_TRUST);
        vm.expectEmit(true, true, true, true, address(gate));
        emit PaidReviews.ReviewBlocked(rid, agentId, payer, 10, "demo");
        vm.prank(payer);
        gate.review(rid, 10, "demo", "", bytes32(0), pm, sig);

        assertEq(gate.blockedReviews(agentId), 1);
        (,,, bool used) = _receipt(rid);
        assertTrue(used, "receipt used up");
        (uint64 count,) = _sum(agentId);
        assertEq(count, 0, "registry cannot take the rating");
        _assertAggregatesMatch(agentId);
    }

    function test_selectiveVetoSandwichLeavesTrace() public {
        uint256 r1 = _pay(payer, agentId, MIN);
        vm.prank(agentOwner);
        IId(IDENTITY).approve(address(gate), agentId);
        _rate(payer, r1, 0);
        vm.prank(agentOwner);
        IId(IDENTITY).approve(address(0), agentId);
        _payAndRate(payer2, agentId, MIN, 100);

        (uint64 c, int128 v) = _sum(agentId);
        assertEq(c, 1);
        assertEq(v, 100);
        assertEq(gate.blockedReviews(agentId), 1);
    }

    function test_payerBecomesOwnerOrOperatorBetweenPayAndReview() public {
        uint256 r1 = _pay(payer, agentId, MIN);
        uint256 r2 = _pay(payer2, agentId2, MIN);
        vm.startPrank(agentOwner);
        IId(IDENTITY).transferFrom(agentOwner, payer, agentId);
        IId(IDENTITY).setApprovalForAll(payer2, true);
        vm.stopPrank();

        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(r1, payer, agentId, GOOD_TRUST);
        vm.prank(payer);
        vm.expectRevert(PaidReviews.SelfReview.selector);
        gate.review(r1, 100, "demo", "", bytes32(0), pm, sig);

        (pm, sig) = _permitFor(r2, payer2, agentId2, GOOD_TRUST);
        vm.prank(payer2);
        vm.expectRevert(PaidReviews.SelfReview.selector);
        gate.review(r2, 100, "demo", "", bytes32(0), pm, sig);
    }

    function test_ownershipTransferredToThirdPartyReviewStillWorks() public {
        uint256 rid = _pay(payer, agentId, MIN);
        address newOwner = makeAddr("newOwner");
        vm.prank(agentOwner);
        IId(IDENTITY).transferFrom(agentOwner, newOwner, agentId);
        _rate(payer, rid, 65);
        (uint64 count, int128 value) = _sum(agentId);
        assertEq(count, 1);
        assertEq(value, 65);
    }

    function test_ratingPersistsAfterPayerBuysAgent() public {
        _payAndRate(payer, agentId, MIN, 100);
        vm.prank(agentOwner);
        IId(IDENTITY).transferFrom(agentOwner, payer, agentId);
        (uint64 c, int128 v) = _sum(agentId);
        assertEq(c, 1);
        assertEq(v, 100, "documented limit: the earlier rating still counts");
    }

    // ---------------------------------------------------------------- unpaid ratings

    function test_unpaidDirectRatingExcludedFromGateSummary() public {
        _payAndRate(payer, agentId, MIN, 90);
        vm.prank(payer2);
        IRep(REPUTATION).giveFeedback(agentId, 1, 0, "paid-review", "", "", "", bytes32(0));
        (uint64 count, int128 value) = _sum(agentId);
        assertEq(count, 1, "gate summary ignores unpaid rater");
        assertEq(value, 90);
        _assertAggregatesMatch(agentId);
    }

    // ---------------------------------------------------------------- gas

    function test_gasMeasurements() public {
        (PaidReviews.TrustPermit memory pm, bytes memory sig) = _permitFor(1, payer, agentId, GOOD_TRUST);
        vm.startPrank(payer);
        uint256 g0 = gasleft();
        uint256 rid = gate.pay{value: MIN}(agentId);
        uint256 gPay = g0 - gasleft();
        g0 = gasleft();
        gate.review(rid, 50, "t", "", bytes32(0), pm, sig);
        uint256 gReview1 = g0 - gasleft();
        vm.stopPrank();
        rid = _pay(payer, agentId, MIN);
        (pm, sig) = _permitFor(rid, payer, agentId, GOOD_TRUST);
        vm.prank(payer);
        g0 = gasleft();
        gate.review(rid, 60, "t", "", bytes32(0), pm, sig);
        uint256 gReview2 = g0 - gasleft();
        console.log("pay gas, Instant (in-test)", gPay);
        console.log("first review gas (in-test)", gReview1);
        console.log("replacing review gas (in-test)", gReview2);
        _assertAggregatesMatch(agentId);
    }

    // ---------------------------------------------------------------- constructor

    function test_constructorValidation() public {
        vm.expectRevert(PaidReviews.ZeroAddress.selector);
        new PaidReviews(address(0), REPUTATION, MIN, checker, MIN_TRUST);
        vm.expectRevert(PaidReviews.ZeroAddress.selector);
        new PaidReviews(IDENTITY, address(0), MIN, checker, MIN_TRUST);
        vm.expectRevert(PaidReviews.ZeroAddress.selector);
        new PaidReviews(IDENTITY, REPUTATION, MIN, address(0), MIN_TRUST);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.BadMinPayment.selector, 0));
        new PaidReviews(IDENTITY, REPUTATION, 0, checker, MIN_TRUST);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.BadMinPayment.selector, MIN + 1));
        new PaidReviews(IDENTITY, REPUTATION, MIN + 1, checker, MIN_TRUST);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.BadMinTrustScore.selector, 0));
        new PaidReviews(IDENTITY, REPUTATION, MIN, checker, 0);
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.BadMinTrustScore.selector, 11));
        new PaidReviews(IDENTITY, REPUTATION, MIN, checker, 11);
        address wrongIdentity = makeAddr("wrongIdentity");
        vm.expectRevert(abi.encodeWithSelector(PaidReviews.RegistryMismatch.selector, wrongIdentity, IDENTITY));
        new PaidReviews(wrongIdentity, REPUTATION, MIN, checker, MIN_TRUST);

        assertEq(gate.checker(), checker);
        assertEq(gate.minTrustScore(), MIN_TRUST);
        assertEq(gate.minPayment(), MIN);
        assertEq(gate.nextReceiptId(), 1);
    }

    // ---------------------------------------------------------------- demo script guards

    /// One test (not several) because vm.setEnv is process-wide and tests run in parallel.
    function test_payDemoGuards() public {
        PayDemo demo = new PayDemo();
        vm.setEnv("GATE", vm.toString(address(gate)));
        vm.setEnv("DEPLOYER", vm.toString(agentOwner));

        vm.setEnv("AGENT_ID_1", "0");
        vm.setEnv("AGENT_ID_2", vm.toString(agentId2));
        vm.expectRevert(bytes("PayDemo: AGENT_ID_1 and AGENT_ID_2 must be non-zero"));
        demo.run();

        vm.setEnv("AGENT_ID_1", vm.toString(LIVE_AGENT));
        vm.expectRevert(bytes("PayDemo: AGENT_ID_1 not owned by DEPLOYER"));
        demo.run();
        vm.setEnv("AGENT_ID_1", vm.toString(agentId));
        vm.setEnv("AGENT_ID_2", vm.toString(LIVE_AGENT));
        vm.expectRevert(bytes("PayDemo: AGENT_ID_2 not owned by DEPLOYER"));
        demo.run();

        vm.setEnv("AGENT_ID_2", vm.toString(agentId2));
        vm.chainId(1);
        vm.expectRevert(bytes("PayDemo: unexpected chain id"));
        demo.run();
    }
}

// -------------------------------------------------------------------- unit fuzz (no fork state used)

contract MockIdentity {
    mapping(uint256 => address) public ownerOf;

    function set(uint256 id, address o) external {
        ownerOf[id] = o;
    }

    function getAgentWallet(uint256) external pure returns (address) {
        return address(0);
    }

    function isAuthorizedOrOwner(address s, uint256 id) external view returns (bool) {
        return s == ownerOf[id];
    }
}

/// Mirrors the observed registry rules: 1-based indices, revoke only own, in bounds, once.
contract MockReputation {
    address public immutable getIdentityRegistry;
    mapping(uint256 => mapping(address => uint64)) public getLastIndex;
    mapping(uint256 => mapping(address => mapping(uint64 => bool))) public revoked;
    mapping(uint256 => mapping(address => mapping(uint64 => int128))) public values;

    constructor(address id) {
        getIdentityRegistry = id;
    }

    function giveFeedback(uint256 agentId, int128 v, uint8, string calldata, string calldata, string calldata, string calldata, bytes32)
        external
    {
        uint64 i = ++getLastIndex[agentId][msg.sender];
        values[agentId][msg.sender][i] = v;
    }

    function revokeFeedback(uint256 agentId, uint64 index) external {
        require(index > 0, "index must be > 0");
        require(index <= getLastIndex[agentId][msg.sender], "index out of bounds");
        require(!revoked[agentId][msg.sender][index], "Already revoked");
        revoked[agentId][msg.sender][index] = true;
    }

    function readFeedback(uint256 agentId, address client, uint64 index)
        external
        view
        returns (int128, uint8, string memory, string memory, bool)
    {
        require(index > 0, "index must be > 0");
        return (values[agentId][client][index], 0, "paid-review", "", revoked[agentId][client][index]);
    }
}

contract PaidReviewsAccountingFuzzTest is Test {
    // Fixed addresses: fuzzing addresses under --fork-url would hit the RPC for every
    // fresh account and make the run very slow.
    address payer = makeAddr("fuzzPayer");
    address payee = makeAddr("fuzzPayee");
    uint256 constant AGENT = 7;
    PaidReviews gate;
    MockReputation rep;
    uint256 key;

    function _setUpGate(bool hold) internal {
        address chk;
        (chk, key) = makeAddrAndKey("fuzzChecker");
        MockIdentity id = new MockIdentity();
        rep = new MockReputation(address(id));
        gate = new PaidReviews(address(id), address(rep), 10_000e12, chk, 7);
        id.set(AGENT, payee);
        if (hold) {
            vm.prank(payee);
            gate.setHoldPayouts(AGENT, true);
        }
    }

    function _payAs(uint256 amount) internal returns (uint256 rid) {
        vm.prank(payer);
        rid = gate.pay{value: amount}(AGENT);
    }

    function _reviewAs(uint256 rid, int128 score) internal {
        PaidReviews.TrustPermit memory pm =
            PaidReviews.TrustPermit({trustScore: 9, reportHash: bytes32(rid), deadline: uint64(block.timestamp + 60)});
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, gate.permitDigest(rid, payer, AGENT, pm));
        vm.prank(payer);
        gate.review(rid, score, "", "", bytes32(0), pm, abi.encodePacked(r, s, v));
    }

    /// The payee always ends up with exactly what was paid (forwarded + held), whatever
    /// the amounts, payout mode and review order.
    function testFuzz_payeeGetsEverything(uint256 units1, uint256 units2, bool hold, bool reviewFirst) public {
        uint256 total = (bound(units1, 10_000, 1e15) + bound(units2, 10_000, 1e15)) * 1e12;
        uint256 a1 = bound(units1, 10_000, 1e15) * 1e12;
        _setUpGate(hold);
        vm.deal(payer, total);
        uint256 payeeBefore = payee.balance;

        uint256 r1 = _payAs(a1);
        if (reviewFirst) _reviewAs(r1, 50);
        uint256 r2 = _payAs(total - a1);
        if (!reviewFirst) _reviewAs(r1, 50);
        _reviewAs(r2, 60);

        assertEq(payee.balance - payeeBefore + gate.owed(payee), total, "payee gets 100%");
        assertEq(address(gate).balance, gate.owed(payee), "gate holds only what is owed");
        assertEq(gate.owed(payee), hold ? total : 0);
        assertEq(rep.getLastIndex(AGENT, address(gate)), 2);
        assertTrue(rep.revoked(AGENT, address(gate), 1), "first rating replaced");
        (uint256 n, int256 sum) = gate.liveScore(AGENT);
        assertEq(n, 1);
        assertEq(sum, 60);
    }
}
