// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Multicall3
/// @notice Aggregate results from multiple function calls in a single `eth_call`.
/// A port of the canonical Multicall3 (Michael Elliot, Joshua Levine, Nick Johnson,
/// Andreas Bigger, Matt Solomon) to Solidity 0.8.26 with `evmVersion: shanghai`.
///
/// This exists because every front-end, indexer and wallet already assumes it does.
/// Loading a token list, a set of pool reserves and a user's balances is one RPC round
/// trip with Multicall3 and hundreds without it.
///
/// TWO PORTING NOTES, both worth reading before deploying:
///
///  1. `getCurrentBlockDifficulty` returns `block.prevrandao`. The canonical source says
///     `block.difficulty`, which solc rejects outright from 0.8.18 onwards when
///     `evmVersion >= paris`. Both spellings compile to opcode `0x44`, so the runtime
///     behaviour is identical and the selector is unchanged; only the Solidity spelling
///     moved. Hearth is proof-of-work (Homefire), so `0x44` is a difficulty here rather
///     than a randomness beacon.
///
///  2. `getBasefee` uses opcode `0x48` (BASEFEE, EIP-3198), which Shanghai includes.
///     Hearth v1 has no EIP-1559 fee market, so the value it reports is whatever the
///     node returns — likely zero. The function is kept because the canonical ABI has
///     it; nothing else in this file depends on it.
///
/// See contracts/README.md on the canonical address
/// `0xcA11bde05977b3631167028862bE2a173976CA11` and what it would take to claim it here.
contract Multicall3 {
    struct Call {
        address target;
        bytes callData;
    }

    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Call3Value {
        address target;
        bool allowFailure;
        uint256 value;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    /// @notice Backwards-compatible call aggregation with Multicall. Reverts if any call fails.
    function aggregate(Call[] calldata calls)
        public
        payable
        returns (uint256 blockNumber, bytes[] memory returnData)
    {
        blockNumber = block.number;
        uint256 length = calls.length;
        returnData = new bytes[](length);
        Call calldata call;
        for (uint256 i = 0; i < length;) {
            bool success;
            call = calls[i];
            (success, returnData[i]) = call.target.call(call.callData);
            require(success, "Multicall3: call failed");
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Backwards-compatible with Multicall2. Optionally tolerates failures.
    function tryAggregate(bool requireSuccess, Call[] calldata calls)
        public
        payable
        returns (Result[] memory returnData)
    {
        uint256 length = calls.length;
        returnData = new Result[](length);
        Call calldata call;
        for (uint256 i = 0; i < length;) {
            Result memory result = returnData[i];
            call = calls[i];
            (result.success, result.returnData) = call.target.call(call.callData);
            if (requireSuccess) require(result.success, "Multicall3: call failed");
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Backwards-compatible with Multicall2. Also returns the block number and hash.
    function tryBlockAndAggregate(bool requireSuccess, Call[] calldata calls)
        public
        payable
        returns (uint256 blockNumber, bytes32 blockHash, Result[] memory returnData)
    {
        blockNumber = block.number;
        blockHash = blockhash(block.number);
        returnData = tryAggregate(requireSuccess, calls);
    }

    /// @notice Backwards-compatible with Multicall2. Reverts if any call fails.
    function blockAndAggregate(Call[] calldata calls)
        public
        payable
        returns (uint256 blockNumber, bytes32 blockHash, Result[] memory returnData)
    {
        (blockNumber, blockHash, returnData) = tryBlockAndAggregate(true, calls);
    }

    /// @notice Aggregate calls, each with its own failure tolerance.
    function aggregate3(Call3[] calldata calls) public payable returns (Result[] memory returnData) {
        uint256 length = calls.length;
        returnData = new Result[](length);
        Call3 calldata calli;
        for (uint256 i = 0; i < length;) {
            Result memory result = returnData[i];
            calli = calls[i];
            (result.success, result.returnData) = calli.target.call(calli.callData);
            assembly {
                // Revert if the call failed and failure is not allowed.
                // `allowFailure := calldataload(add(calli, 0x20))`, `success := mload(result)`.
                if iszero(or(calldataload(add(calli, 0x20)), mload(result))) {
                    // bytes4(keccak256("Error(string)"))
                    mstore(0x00, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    // data offset
                    mstore(0x04, 0x0000000000000000000000000000000000000000000000000000000000000020)
                    // length of the revert string
                    mstore(0x24, 0x0000000000000000000000000000000000000000000000000000000000000017)
                    // "Multicall3: call failed"
                    mstore(0x44, 0x4d756c746963616c6c333a2063616c6c206661696c6564000000000000000000)
                    revert(0x00, 0x64)
                }
            }
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Aggregate calls with a msg.value, each with its own failure tolerance.
    /// @dev The sum of the individual values must equal `msg.value`, so nothing is stranded.
    function aggregate3Value(Call3Value[] calldata calls) public payable returns (Result[] memory returnData) {
        uint256 valAccumulator;
        uint256 length = calls.length;
        returnData = new Result[](length);
        Call3Value calldata calli;
        for (uint256 i = 0; i < length;) {
            Result memory result = returnData[i];
            calli = calls[i];
            uint256 val = calli.value;
            // Humanity will be a Type V Kardashev civilisation before this overflows.
            unchecked {
                valAccumulator += val;
            }
            (result.success, result.returnData) = calli.target.call{value: val}(calli.callData);
            assembly {
                if iszero(or(calldataload(add(calli, 0x20)), mload(result))) {
                    mstore(0x00, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(0x04, 0x0000000000000000000000000000000000000000000000000000000000000020)
                    mstore(0x24, 0x0000000000000000000000000000000000000000000000000000000000000017)
                    mstore(0x44, 0x4d756c746963616c6c333a2063616c6c206661696c6564000000000000000000)
                    revert(0x00, 0x64)
                }
            }
            unchecked {
                ++i;
            }
        }
        require(msg.value == valAccumulator, "Multicall3: value mismatch");
    }

    // ------------------------------------------------------------------ chain reads

    function getBasefee() public view returns (uint256 basefee) {
        basefee = block.basefee;
    }

    function getBlockHash(uint256 blockNumber) public view returns (bytes32 blockHash) {
        blockHash = blockhash(blockNumber);
    }

    function getBlockNumber() public view returns (uint256 blockNumber) {
        blockNumber = block.number;
    }

    function getChainId() public view returns (uint256 chainid) {
        chainid = block.chainid;
    }

    function getCurrentBlockCoinbase() public view returns (address coinbase) {
        coinbase = block.coinbase;
    }

    /// @dev Opcode `0x44`. Spelled `prevrandao` because solc requires it from 0.8.18 with
    /// `evmVersion >= paris`; the selector and the runtime behaviour are the canonical ones.
    function getCurrentBlockDifficulty() public view returns (uint256 difficulty) {
        difficulty = block.prevrandao;
    }

    function getCurrentBlockGasLimit() public view returns (uint256 gaslimit) {
        gaslimit = block.gaslimit;
    }

    function getCurrentBlockTimestamp() public view returns (uint256 timestamp) {
        timestamp = block.timestamp;
    }

    function getEthBalance(address addr) public view returns (uint256 balance) {
        balance = addr.balance;
    }

    function getLastBlockHash() public view returns (bytes32 blockHash) {
        unchecked {
            blockHash = blockhash(block.number - 1);
        }
    }
}
