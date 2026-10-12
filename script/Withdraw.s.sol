// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PaidReviews} from "../src/PaidReviews.sol";

/// Withdraws the broadcaster's held balance (Hold mode or failed Instant forwards). Broadcast as the
/// payee: the agent's wallet if one is set, otherwise the agent owner.
///
///   forge script script/Withdraw.s.sol --rpc-url $ARC_RPC_URL --account arc-deployer --broadcast
///
/// Env: GATE, WITHDRAW_TO (destination address; must be able to receive native USDC)
contract Withdraw is Script {
    function run() external {
        PaidReviews gate = PaidReviews(vm.envAddress("GATE"));
        address payable to = payable(vm.envAddress("WITHDRAW_TO"));

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        uint256 amount = gate.owed(sender);
        console.log("account", sender);
        console.log("owed (native wei, 18 decimals)", amount);
        gate.withdraw(to);
        vm.stopBroadcast();

        console.log("withdrawn to", to);
    }
}
