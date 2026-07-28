// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

interface IHearthV2Factory {
    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);

    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address);

    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function allPairs(uint256) external view returns (address pair);
    function allPairsLength() external view returns (uint256);

    function createPair(address tokenA, address tokenB) external returns (address pair);

    function setFeeTo(address) external;
    function setFeeToSetter(address) external;

    /// @notice `keccak256(type(HearthV2Pair).creationCode)` as built by this factory.
    /// The router hard-codes the same value in `HearthV2Library.INIT_CODE_HASH`; call
    /// this on-chain after deployment to prove the two agree.
    function pairCodeHash() external pure returns (bytes32);
}
