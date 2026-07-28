// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * The smallest contract that proves a chain is real: it stores something, it
 * emits something, and it reports what the chain thinks it is.
 *
 * `chainId()` returning 7411 is the single cheapest end-to-end proof that you
 * deployed to Hearth and not to a fork of somewhere else — it reads opcode
 * CHAINID, so it can only be right if the node, the signer and the tooling all
 * agree.
 */
contract Greeter {
    string public greeting;
    address public immutable owner;

    event GreetingChanged(address indexed by, string greeting);

    constructor(string memory initial) {
        greeting = initial;
        owner = msg.sender;
    }

    function setGreeting(string calldata next) external {
        greeting = next;
        emit GreetingChanged(msg.sender, next);
    }

    /// EIP-155 chain id, straight from the CHAINID opcode. On Hearth: 7411.
    function chainId() external view returns (uint256) {
        return block.chainid;
    }

    /**
     * Opcode 0x44. On Ethereum this is beacon-chain randomness; on Hearth it is
     * the PARENT BLOCK'S HOMEFIRE PROOF-OF-WORK DIGEST (docs/evm-spec.md §5).
     *
     * It is a real 256-bit hash and it is deterministic and verifiable — and it
     * is MINER-INFLUENCEABLE. A miner who dislikes the outcome can discard the
     * block and grind another one. Do not use it for anything an adversarial
     * miner would profit from biasing. That is not a Hearth caveat; it is true
     * of every proof-of-work chain that derives randomness from its own header.
     */
    function powDigestOfParent() external view returns (uint256) {
        return block.prevrandao;
    }

    /**
     * Opcode 0x48 (BASEFEE, EIP-3198). Shanghai includes it, so it compiles and
     * executes — but Hearth v1 has no EIP-1559 fee market, so it PUSHES ZERO
     * (docs/evm-spec.md §5). Do not price anything off it.
     */
    function baseFee() external view returns (uint256) {
        return block.basefee;
    }
}
