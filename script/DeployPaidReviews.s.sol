// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PaidReviews} from "../src/PaidReviews.sol";

/// Deploys the PaidReviews gate. The key comes from the CLI (--account), never from this file.
/// There is no fee: agents receive 100% of every payment.
///
/// Env:
///   CHECKER     address of the trust checker's signing key (required; public address only)
///   MIN_TRUST   lowest trust score out of 10 that may review (default 7)
///
///   forge script script/DeployPaidReviews.s.sol --rpc-url $ARC_RPC_URL --account arc-deployer --broadcast
contract DeployPaidReviews is Script {
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    uint256 constant MIN_PAYMENT = 1e16; // 0.01 USDC (native, 18 decimals)

    function run() external returns (PaidReviews gate) {
        address checker = vm.envAddress("CHECKER");
        uint8 minTrust = uint8(vm.envOr("MIN_TRUST", uint256(7)));

        vm.startBroadcast();
        gate = new PaidReviews(IDENTITY, REPUTATION, MIN_PAYMENT, checker, minTrust);
        vm.stopBroadcast();

        console.log("GATE", address(gate));
        console.log("checker", checker);
        console.log("minTrustScore", minTrust);
        console.log("minPayment", MIN_PAYMENT);
    }
}
