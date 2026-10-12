// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PaidReviews} from "../src/PaidReviews.sol";

interface IReputationSummary {
    function getSummary(uint256 agentId, address[] calldata clients, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}

/// Step 2 of the demo: the payer rates the three receipts from PayDemo, each with the
/// trust permit the checker wrote to permits/receipt-<id>.json.
///   RECEIPT_1 -> 95, RECEIPT_2 -> 80, RECEIPT_3 -> 90
/// RECEIPT_1 and RECEIPT_2 are both for agent 1 from the same payer, so the second
/// review revokes the first rating and replaces it.
///
///   forge script script/ReviewDemo.s.sol --rpc-url $ARC_RPC_URL --account arc-payer --sender $PAYER --broadcast
///
/// Env: GATE, RECEIPT_1, RECEIPT_2, RECEIPT_3
contract ReviewDemo is Script {
    address constant REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    function run() external {
        PaidReviews gate = PaidReviews(vm.envAddress("GATE"));
        uint256[3] memory ids = [vm.envUint("RECEIPT_1"), vm.envUint("RECEIPT_2"), vm.envUint("RECEIPT_3")];
        int128[3] memory scores = [int128(95), int128(80), int128(90)];
        string[3] memory tags = ["translation", "translation", "research"];

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        for (uint256 i; i < 3; i++) {
            (PaidReviews.TrustPermit memory pm, bytes memory sig) = loadPermit(ids[i]);
            (, uint256 agentId,,) = gate.receipts(ids[i]);
            uint64 before_ = gate.activeIndex(agentId, sender);
            gate.review(ids[i], scores[i], tags[i], "", bytes32(0), pm, sig);
            console.log("receipt", ids[i]);
            console.log("  agent", agentId);
            console.log("  trust score", pm.trustScore);
            console.log("  feedbackIndex", gate.activeIndex(agentId, sender));
            console.log("  replacedIndex (0 = none)", before_);
        }
        vm.stopBroadcast();

        (, uint256 agent1,,) = gate.receipts(ids[0]);
        (, uint256 agent2,,) = gate.receipts(ids[2]);
        _logSummary(address(gate), agent1);
        _logSummary(address(gate), agent2);
    }

    /// Reads permits/receipt-<id>.json written by the checker (checker/ in this repo).
    function loadPermit(uint256 receiptId)
        public
        view
        returns (PaidReviews.TrustPermit memory pm, bytes memory sig)
    {
        string memory json = vm.readFile(string.concat("permits/receipt-", vm.toString(receiptId), ".json"));
        pm.trustScore = uint8(vm.parseJsonUint(json, ".permit.trustScore"));
        pm.reportHash = vm.parseJsonBytes32(json, ".permit.reportHash");
        pm.deadline = uint64(vm.parseJsonUint(json, ".permit.deadline"));
        sig = vm.parseJsonBytes(json, ".signature");
    }

    function _logSummary(address gate, uint256 agentId) internal view {
        address[] memory only = new address[](1);
        only[0] = gate;
        (uint64 count, int128 value, uint8 decimals) =
            IReputationSummary(REPUTATION).getSummary(agentId, only, "paid-review", "");
        (uint256 liveCount, int256 liveSum) = PaidReviews(gate).liveScore(agentId);
        console.log("agent", agentId);
        console.log("  registry getSummary: live paid ratings", count);
        console.logInt(value);
        console.log("  summaryValueDecimals", decimals);
        console.log("  gate liveScore: count", liveCount);
        console.logInt(liveSum);
        console.log("  gate blockedReviews", PaidReviews(gate).blockedReviews(agentId));
    }
}
