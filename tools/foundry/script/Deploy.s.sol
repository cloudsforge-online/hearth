// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Greeter} from "../src/Greeter.sol";

/**
 * Deploy Greeter to Hearth.
 *
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url "$HEARTH_RPC_URL" \
 *     --private-key "$HEARTH_PRIVATE_KEY" \
 *     --legacy \
 *     --broadcast
 *
 * `--legacy` IS NOT OPTIONAL. Foundry asks the node for `eth_feeHistory`
 * before it prices anything, Hearth v1 does not implement it (docs/evm-spec.md
 * §6), and without the flag the run aborts with:
 *
 *     Failed to estimate EIP1559 fees. This chain might not support EIP1559,
 *     try adding --legacy to your command.
 *     - server returned an error response: error code -32601: the method
 *       eth_feeHistory does not exist/is not available
 *
 * There is no foundry.toml key and no environment variable for this — it has
 * to be on the command line. See tools/foundry/README.md.
 */
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();

        Greeter greeter = new Greeter("hello hearth");

        console.log("Greeter", address(greeter));
        console.log("greeting", greeter.greeting());

        // CHAINID, read from the deployed code. The cheapest end-to-end proof
        // that the node, the signer and forge all agree which chain this is.
        console.log("chainId", greeter.chainId());
        require(greeter.chainId() == 7411, "not Hearth: CHAINID is not 7411");

        vm.stopBroadcast();
    }
}
