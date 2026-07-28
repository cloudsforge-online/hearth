// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

/// @notice Flash-swap receiver. Deliberately named `hearthV2Call` rather than
/// `uniswapV2Call`: a contract written to be called back by Uniswap pairs on another
/// chain must not be reachable by a Hearth pair, and vice versa. Every V2 fork renames
/// this for the same reason.
interface IHearthV2Callee {
    function hearthV2Call(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}
