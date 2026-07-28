// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Greeter} from "../src/Greeter.sol";

/**
 * `forge test` runs against Foundry's own EVM, not against Hearth. That is
 * useful and it is also the limit of what it proves: a green suite here says
 * the Solidity is right, not that Hearth executes it the same way. Hearth's
 * EVM is gated separately, on `ethereum/legacytests` GeneralStateTests
 * (docs/evm-spec.md §0).
 *
 * The chain id is forced to 7411 so that anything reading `block.chainid` —
 * EIP-712 domain separators, `permit` signatures, replay guards — is exercised
 * against the value it will meet in production.
 */
contract GreeterTest is Test {
    Greeter greeter;

    function setUp() public {
        vm.chainId(7411);
        greeter = new Greeter("hello hearth");
    }

    function test_InitialGreeting() public view {
        assertEq(greeter.greeting(), "hello hearth");
        assertEq(greeter.owner(), address(this));
    }

    function test_ChainIdIsHearth() public view {
        assertEq(greeter.chainId(), 7411);
    }

    function test_SetGreetingEmits() public {
        vm.expectEmit(true, false, false, true);
        emit Greeter.GreetingChanged(address(this), "warmer");
        greeter.setGreeting("warmer");
        assertEq(greeter.greeting(), "warmer");
    }

    function testFuzz_SetGreeting(string calldata s) public {
        greeter.setGreeting(s);
        assertEq(greeter.greeting(), s);
    }
}
