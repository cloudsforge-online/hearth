// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

import {IHearthV2Pair} from "../interfaces/IHearthV2Pair.sol";

/// @notice The pricing maths and address derivation shared by the router.
/// A port of Uniswap's `UniswapV2Library`; `SafeMath` is gone because 0.8 checks
/// every operation it used to guard.
library HearthV2Library {
    /// @notice `keccak256(type(HearthV2Pair).creationCode)`.
    ///
    /// ============================ READ THIS ============================
    /// This value is hard-coded so that `pairFor` can derive a pair's address with pure
    /// arithmetic instead of an `SLOAD` on the factory. That saves gas on every single
    /// swap — and it means a STALE VALUE MAKES THE ROUTER LOOK FOR POOLS AT ADDRESSES
    /// THAT DO NOT EXIST. Every call then reverts, or worse, silently resolves to an
    /// empty account. This is the single most common way a V2 fork is stood up broken.
    ///
    /// It changes if ANY of these change: HearthV2Pair.sol, anything it imports
    /// (HearthV2ERC20, Math, UQ112x112, the interfaces), the solc version, the optimizer
    /// settings, or the evmVersion.
    ///
    /// Regenerate with:  cd contracts && npm run compile -- --sync-hash
    /// Verify on-chain:  HearthV2Factory.pairCodeHash() must equal this.
    /// The test suite (`npm test`) fails the build if the two ever diverge.
    /// ===================================================================
    bytes32 internal constant INIT_CODE_HASH = 0x46b4122ae9db4a03c913cfbed4e6321064741545c60aafe3ed9410be7657a537;

    /// @dev Sorts token addresses so a pair's identity does not depend on argument order.
    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        require(tokenA != tokenB, "HearthV2Library: IDENTICAL_ADDRESSES");
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "HearthV2Library: ZERO_ADDRESS");
    }

    /// @dev The CREATE2 address of a pair, computed without calling the factory.
    function pairFor(address factory, address tokenA, address tokenB) internal pure returns (address pair) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        pair = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            hex"ff", factory, keccak256(abi.encodePacked(token0, token1)), INIT_CODE_HASH
                        )
                    )
                )
            )
        );
    }

    /// @dev Reserves ordered to match the caller's `(tokenA, tokenB)`, not the pair's
    /// internal `(token0, token1)`.
    function getReserves(address factory, address tokenA, address tokenB)
        internal
        view
        returns (uint256 reserveA, uint256 reserveB)
    {
        (address token0,) = sortTokens(tokenA, tokenB);
        (uint256 reserve0, uint256 reserve1,) = IHearthV2Pair(pairFor(factory, tokenA, tokenB)).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    /// @dev The other side of a proportional deposit. No fee: this is not a trade.
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) internal pure returns (uint256 amountB) {
        require(amountA > 0, "HearthV2Library: INSUFFICIENT_AMOUNT");
        require(reserveA > 0 && reserveB > 0, "HearthV2Library: INSUFFICIENT_LIQUIDITY");
        amountB = amountA * reserveB / reserveA;
    }

    /// @dev Output for an exact input, net of the 0.3% fee (997/1000).
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256 amountOut)
    {
        require(amountIn > 0, "HearthV2Library: INSUFFICIENT_INPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "HearthV2Library: INSUFFICIENT_LIQUIDITY");
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        amountOut = numerator / denominator;
    }

    /// @dev Input required for an exact output, net of the 0.3% fee. The `+ 1` rounds
    /// the trader's cost up so rounding can never favour them against the invariant.
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256 amountIn)
    {
        require(amountOut > 0, "HearthV2Library: INSUFFICIENT_OUTPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "HearthV2Library: INSUFFICIENT_LIQUIDITY");
        uint256 numerator = reserveIn * amountOut * 1000;
        uint256 denominator = (reserveOut - amountOut) * 997;
        amountIn = (numerator / denominator) + 1;
    }

    /// @dev Chained `getAmountOut` along a multi-hop path.
    function getAmountsOut(address factory, uint256 amountIn, address[] memory path)
        internal
        view
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "HearthV2Library: INVALID_PATH");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; i++) {
            (uint256 reserveIn, uint256 reserveOut) = getReserves(factory, path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], reserveIn, reserveOut);
        }
    }

    /// @dev Chained `getAmountIn` backwards along a multi-hop path.
    function getAmountsIn(address factory, uint256 amountOut, address[] memory path)
        internal
        view
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "HearthV2Library: INVALID_PATH");
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            (uint256 reserveIn, uint256 reserveOut) = getReserves(factory, path[i - 1], path[i]);
            amounts[i - 1] = getAmountIn(amounts[i], reserveIn, reserveOut);
        }
    }
}
