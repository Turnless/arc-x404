// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";

interface IIdentityRegister {
    function register(string calldata agentURI) external returns (uint256 agentId);
}

/// Registers two demo agents in Arc's ERC-8004 IdentityRegistry from the broadcaster.
/// The key comes from the CLI (--account <keystore name>), never from this file.
///
///   forge script script/RegisterAgents.s.sol --rpc-url $ARC_RPC_URL --account arc-deployer --broadcast
contract RegisterAgents is Script {
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;

    function run() external returns (uint256 id1, uint256 id2) {
        string memory uri1 = _uri(
            "PaidReviews Demo Translator",
            "Demo agent for the PaidReviews gate on Arc. Rated only through paid reviews."
        );
        string memory uri2 = _uri(
            "PaidReviews Demo Researcher",
            "Demo agent for the PaidReviews gate on Arc. Rated only through paid reviews."
        );

        vm.startBroadcast();
        id1 = IIdentityRegister(IDENTITY).register(uri1);
        id2 = IIdentityRegister(IDENTITY).register(uri2);
        vm.stopBroadcast();

        console.log("AGENT_ID_1", id1);
        console.log("AGENT_ID_2", id2);
    }

    /// ERC-8004 registration-v1 JSON, inlined as a base64 data URI.
    function _uri(string memory name, string memory description) internal pure returns (string memory) {
        string memory json = string.concat(
            '{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1",',
            '"name":"', name, '",',
            '"description":"', description, '",',
            '"services":[]}'
        );
        return string.concat("data:application/json;base64,", vm.toBase64(json));
    }
}
