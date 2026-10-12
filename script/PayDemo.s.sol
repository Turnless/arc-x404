// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PaidReviews} from "../src/PaidReviews.sol";

/// Step 1 of the demo: three payments from the payer (not the agents' owner).
///   agent 1: 0.02 USDC, agent 1 again: 0.01 USDC, agent 2: 0.05 USDC
/// Each payment returns a receipt id. The id is also read from nextReceiptId before
/// each pay; if someone else pays the gate between simulation and broadcast the real
/// ids can differ, so confirm them from the Paid events (receiptId is topic 1).
///
/// Safety checks before anything is sent:
///   - chain id must be 5042 (Arc mainnet), 31337 or 1337 (local anvil / dev chains);
///   - AGENT_ID_1 and AGENT_ID_2 must be set and non-zero (agent ids 0, 1, 2, ... already
///     exist on Arc mainnet with unrelated owners, so a default id would pay a stranger);
///   - both agents must be owned by DEPLOYER (the demo pays only agents you registered).
///
///   forge script script/PayDemo.s.sol --rpc-url $ARC_RPC_URL --account arc-payer --sender $PAYER --broadcast
///
/// Env: GATE, AGENT_ID_1, AGENT_ID_2, DEPLOYER
contract PayDemo is Script {
    function run() external returns (uint256 r1, uint256 r2, uint256 r3) {
        require(
            block.chainid == 5042 || block.chainid == 31337 || block.chainid == 1337, "PayDemo: unexpected chain id"
        );
        PaidReviews gate = PaidReviews(vm.envAddress("GATE"));
        uint256 agent1 = vm.envUint("AGENT_ID_1");
        uint256 agent2 = vm.envUint("AGENT_ID_2");
        address deployer = vm.envAddress("DEPLOYER");
        require(agent1 != 0 && agent2 != 0, "PayDemo: AGENT_ID_1 and AGENT_ID_2 must be non-zero");
        require(gate.identity().ownerOf(agent1) == deployer, "PayDemo: AGENT_ID_1 not owned by DEPLOYER");
        require(gate.identity().ownerOf(agent2) == deployer, "PayDemo: AGENT_ID_2 not owned by DEPLOYER");

        vm.startBroadcast();
        console.log("next receipt id", gate.nextReceiptId());
        r1 = gate.pay{value: 2e16}(agent1); // 0.02 USDC
        console.log("next receipt id", gate.nextReceiptId());
        r2 = gate.pay{value: 1e16}(agent1); // 0.01 USDC, same payer, same agent
        console.log("next receipt id", gate.nextReceiptId());
        r3 = gate.pay{value: 5e16}(agent2); // 0.05 USDC
        vm.stopBroadcast();

        console.log("RECEIPT_1 (agent 1, 0.02 USDC)", r1);
        console.log("RECEIPT_2 (agent 1, 0.01 USDC)", r2);
        console.log("RECEIPT_3 (agent 2, 0.05 USDC)", r3);
    }
}
