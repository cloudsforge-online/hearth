// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

import {IHearthV2Router02} from "./interfaces/IHearthV2Router02.sol";
import {IHearthV2Factory} from "./interfaces/IHearthV2Factory.sol";
import {IHearthV2Pair} from "./interfaces/IHearthV2Pair.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IWEMBER} from "./interfaces/IWEMBER.sol";
import {HearthV2Library} from "./libraries/HearthV2Library.sol";
import {TransferHelper} from "./libraries/TransferHelper.sol";

/// @title HearthV2Router02
/// @notice The contract users and front-ends actually talk to: liquidity, swaps,
/// multi-hop paths, deadlines, and native-EMBER wrapping. A port of Uniswap's
/// `UniswapV2Router02`.
///
/// ON THE NAME "ETH". Function names such as `swapExactETHForTokens` and the `WETH()`
/// accessor are kept verbatim from Uniswap. They are selectors, not prose: every V2
/// front-end, router aggregator, subgraph and SDK dispatches on them. Renaming them to
/// EMBER would buy nothing and cost compatibility with all of it. On Hearth, read "ETH"
/// as "the native asset" — EMBER — wrapped as WEMBER. `WEMBER()` is provided as an alias
/// of `WETH()` for readability.
///
/// The router holds no state and should never hold a balance. Anything left in it is
/// claimable by anyone.
contract HearthV2Router02 is IHearthV2Router02 {
    // Internal, not public: the ABI exposes these through `factory()`, `WETH()` and
    // `WEMBER()` so it stays selector-identical to UniswapV2Router02. A `public immutable`
    // would add `factoryAddress()` / `wemberAddress()` to the ABI for no one's benefit.
    address internal immutable factoryAddress;
    address internal immutable wemberAddress;

    modifier ensure(uint256 deadline) {
        require(deadline >= block.timestamp, "HearthV2Router: EXPIRED");
        _;
    }

    constructor(address _factory, address _WEMBER) {
        factoryAddress = _factory;
        wemberAddress = _WEMBER;
    }

    function factory() external view returns (address) {
        return factoryAddress;
    }

    function WETH() external view returns (address) {
        return wemberAddress;
    }

    function WEMBER() external view returns (address) {
        return wemberAddress;
    }

    /// @dev Only WEMBER may send EMBER here, and only as part of a `withdraw` we asked for.
    receive() external payable {
        assert(msg.sender == wemberAddress);
    }

    // ---------------------------------------------------------------- ADD LIQUIDITY

    function _addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) internal virtual returns (uint256 amountA, uint256 amountB) {
        // Create the pair if it does not exist yet.
        if (IHearthV2Factory(factoryAddress).getPair(tokenA, tokenB) == address(0)) {
            IHearthV2Factory(factoryAddress).createPair(tokenA, tokenB);
        }
        (uint256 reserveA, uint256 reserveB) = HearthV2Library.getReserves(factoryAddress, tokenA, tokenB);
        if (reserveA == 0 && reserveB == 0) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint256 amountBOptimal = HearthV2Library.quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                require(amountBOptimal >= amountBMin, "HearthV2Router: INSUFFICIENT_B_AMOUNT");
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = HearthV2Library.quote(amountBDesired, reserveB, reserveA);
                assert(amountAOptimal <= amountADesired);
                require(amountAOptimal >= amountAMin, "HearthV2Router: INSUFFICIENT_A_AMOUNT");
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external virtual ensure(deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        (amountA, amountB) = _addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);
        address pair = HearthV2Library.pairFor(factoryAddress, tokenA, tokenB);
        TransferHelper.safeTransferFrom(tokenA, msg.sender, pair, amountA);
        TransferHelper.safeTransferFrom(tokenB, msg.sender, pair, amountB);
        liquidity = IHearthV2Pair(pair).mint(to);
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable virtual ensure(deadline) returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        (amountToken, amountETH) = _addLiquidity(
            token, wemberAddress, amountTokenDesired, msg.value, amountTokenMin, amountETHMin
        );
        address pair = HearthV2Library.pairFor(factoryAddress, token, wemberAddress);
        TransferHelper.safeTransferFrom(token, msg.sender, pair, amountToken);
        IWEMBER(wemberAddress).deposit{value: amountETH}();
        assert(IWEMBER(wemberAddress).transfer(pair, amountETH));
        liquidity = IHearthV2Pair(pair).mint(to);
        // Refund dust; msg.value can be larger than amountETH.
        if (msg.value > amountETH) TransferHelper.safeTransferETH(msg.sender, msg.value - amountETH);
    }

    // ------------------------------------------------------------- REMOVE LIQUIDITY

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) public virtual ensure(deadline) returns (uint256 amountA, uint256 amountB) {
        address pair = HearthV2Library.pairFor(factoryAddress, tokenA, tokenB);
        IHearthV2Pair(pair).transferFrom(msg.sender, pair, liquidity); // send liquidity to pair
        (uint256 amount0, uint256 amount1) = IHearthV2Pair(pair).burn(to);
        (address token0,) = HearthV2Library.sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);
        require(amountA >= amountAMin, "HearthV2Router: INSUFFICIENT_A_AMOUNT");
        require(amountB >= amountBMin, "HearthV2Router: INSUFFICIENT_B_AMOUNT");
    }

    function removeLiquidityETH(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) public virtual ensure(deadline) returns (uint256 amountToken, uint256 amountETH) {
        (amountToken, amountETH) = removeLiquidity(
            token, wemberAddress, liquidity, amountTokenMin, amountETHMin, address(this), deadline
        );
        TransferHelper.safeTransfer(token, to, amountToken);
        IWEMBER(wemberAddress).withdraw(amountETH);
        TransferHelper.safeTransferETH(to, amountETH);
    }

    function removeLiquidityWithPermit(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external virtual returns (uint256 amountA, uint256 amountB) {
        address pair = HearthV2Library.pairFor(factoryAddress, tokenA, tokenB);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        IHearthV2Pair(pair).permit(msg.sender, address(this), value, deadline, v, r, s);
        (amountA, amountB) = removeLiquidity(tokenA, tokenB, liquidity, amountAMin, amountBMin, to, deadline);
    }

    function removeLiquidityETHWithPermit(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external virtual returns (uint256 amountToken, uint256 amountETH) {
        address pair = HearthV2Library.pairFor(factoryAddress, token, wemberAddress);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        IHearthV2Pair(pair).permit(msg.sender, address(this), value, deadline, v, r, s);
        (amountToken, amountETH) =
            removeLiquidityETH(token, liquidity, amountTokenMin, amountETHMin, to, deadline);
    }

    // ----------------------------- REMOVE LIQUIDITY (fee-on-transfer tokens) -------

    function removeLiquidityETHSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) public virtual ensure(deadline) returns (uint256 amountETH) {
        (, amountETH) = removeLiquidity(
            token, wemberAddress, liquidity, amountTokenMin, amountETHMin, address(this), deadline
        );
        // The amount actually received can be less than `burn` reported.
        TransferHelper.safeTransfer(token, to, IERC20(token).balanceOf(address(this)));
        IWEMBER(wemberAddress).withdraw(amountETH);
        TransferHelper.safeTransferETH(to, amountETH);
    }

    function removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external virtual returns (uint256 amountETH) {
        address pair = HearthV2Library.pairFor(factoryAddress, token, wemberAddress);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        IHearthV2Pair(pair).permit(msg.sender, address(this), value, deadline, v, r, s);
        amountETH = removeLiquidityETHSupportingFeeOnTransferTokens(
            token, liquidity, amountTokenMin, amountETHMin, to, deadline
        );
    }

    // ------------------------------------------------------------------------ SWAP

    /// @dev Walks the path, sending each hop's output straight to the next pair.
    /// Requires the initial input to already be sitting in the first pair.
    function _swap(uint256[] memory amounts, address[] memory path, address _to) internal virtual {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = HearthV2Library.sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) =
                input == token0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
            address to = i < path.length - 2 ? HearthV2Library.pairFor(factoryAddress, output, path[i + 2]) : _to;
            IHearthV2Pair(HearthV2Library.pairFor(factoryAddress, input, output)).swap(
                amount0Out, amount1Out, to, new bytes(0)
            );
        }
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external virtual ensure(deadline) returns (uint256[] memory amounts) {
        amounts = HearthV2Library.getAmountsOut(factoryAddress, amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "HearthV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, HearthV2Library.pairFor(factoryAddress, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, to);
    }

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external virtual ensure(deadline) returns (uint256[] memory amounts) {
        amounts = HearthV2Library.getAmountsIn(factoryAddress, amountOut, path);
        require(amounts[0] <= amountInMax, "HearthV2Router: EXCESSIVE_INPUT_AMOUNT");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, HearthV2Library.pairFor(factoryAddress, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, to);
    }

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        virtual
        ensure(deadline)
        returns (uint256[] memory amounts)
    {
        require(path[0] == wemberAddress, "HearthV2Router: INVALID_PATH");
        amounts = HearthV2Library.getAmountsOut(factoryAddress, msg.value, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "HearthV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        IWEMBER(wemberAddress).deposit{value: amounts[0]}();
        assert(IWEMBER(wemberAddress).transfer(HearthV2Library.pairFor(factoryAddress, path[0], path[1]), amounts[0]));
        _swap(amounts, path, to);
    }

    function swapTokensForExactETH(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external virtual ensure(deadline) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == wemberAddress, "HearthV2Router: INVALID_PATH");
        amounts = HearthV2Library.getAmountsIn(factoryAddress, amountOut, path);
        require(amounts[0] <= amountInMax, "HearthV2Router: EXCESSIVE_INPUT_AMOUNT");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, HearthV2Library.pairFor(factoryAddress, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, address(this));
        IWEMBER(wemberAddress).withdraw(amounts[amounts.length - 1]);
        TransferHelper.safeTransferETH(to, amounts[amounts.length - 1]);
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external virtual ensure(deadline) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == wemberAddress, "HearthV2Router: INVALID_PATH");
        amounts = HearthV2Library.getAmountsOut(factoryAddress, amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "HearthV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, HearthV2Library.pairFor(factoryAddress, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, address(this));
        IWEMBER(wemberAddress).withdraw(amounts[amounts.length - 1]);
        TransferHelper.safeTransferETH(to, amounts[amounts.length - 1]);
    }

    function swapETHForExactTokens(uint256 amountOut, address[] calldata path, address to, uint256 deadline)
        external
        payable
        virtual
        ensure(deadline)
        returns (uint256[] memory amounts)
    {
        require(path[0] == wemberAddress, "HearthV2Router: INVALID_PATH");
        amounts = HearthV2Library.getAmountsIn(factoryAddress, amountOut, path);
        require(amounts[0] <= msg.value, "HearthV2Router: EXCESSIVE_INPUT_AMOUNT");
        IWEMBER(wemberAddress).deposit{value: amounts[0]}();
        assert(IWEMBER(wemberAddress).transfer(HearthV2Library.pairFor(factoryAddress, path[0], path[1]), amounts[0]));
        _swap(amounts, path, to);
        // Refund dust.
        if (msg.value > amounts[0]) TransferHelper.safeTransferETH(msg.sender, msg.value - amounts[0]);
    }

    // ------------------------------------- SWAP (fee-on-transfer tokens) ----------

    /// @dev Ignores the precomputed amounts and asks each pair what it actually holds.
    /// This is what makes tokens that take a cut on transfer work.
    function _swapSupportingFeeOnTransferTokens(address[] memory path, address _to) internal virtual {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = HearthV2Library.sortTokens(input, output);
            IHearthV2Pair pair = IHearthV2Pair(HearthV2Library.pairFor(factoryAddress, input, output));
            uint256 amountInput;
            uint256 amountOutput;
            {
                (uint256 reserve0, uint256 reserve1,) = pair.getReserves();
                (uint256 reserveInput, uint256 reserveOutput) =
                    input == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
                amountInput = IERC20(input).balanceOf(address(pair)) - reserveInput;
                amountOutput = HearthV2Library.getAmountOut(amountInput, reserveInput, reserveOutput);
            }
            (uint256 amount0Out, uint256 amount1Out) =
                input == token0 ? (uint256(0), amountOutput) : (amountOutput, uint256(0));
            address to = i < path.length - 2 ? HearthV2Library.pairFor(factoryAddress, output, path[i + 2]) : _to;
            pair.swap(amount0Out, amount1Out, to, new bytes(0));
        }
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external virtual ensure(deadline) {
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, HearthV2Library.pairFor(factoryAddress, path[0], path[1]), amountIn
        );
        uint256 balanceBefore = IERC20(path[path.length - 1]).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);
        require(
            IERC20(path[path.length - 1]).balanceOf(to) - balanceBefore >= amountOutMin,
            "HearthV2Router: INSUFFICIENT_OUTPUT_AMOUNT"
        );
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable virtual ensure(deadline) {
        require(path[0] == wemberAddress, "HearthV2Router: INVALID_PATH");
        uint256 amountIn = msg.value;
        IWEMBER(wemberAddress).deposit{value: amountIn}();
        assert(IWEMBER(wemberAddress).transfer(HearthV2Library.pairFor(factoryAddress, path[0], path[1]), amountIn));
        uint256 balanceBefore = IERC20(path[path.length - 1]).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);
        require(
            IERC20(path[path.length - 1]).balanceOf(to) - balanceBefore >= amountOutMin,
            "HearthV2Router: INSUFFICIENT_OUTPUT_AMOUNT"
        );
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external virtual ensure(deadline) {
        require(path[path.length - 1] == wemberAddress, "HearthV2Router: INVALID_PATH");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, HearthV2Library.pairFor(factoryAddress, path[0], path[1]), amountIn
        );
        _swapSupportingFeeOnTransferTokens(path, address(this));
        uint256 amountOut = IERC20(wemberAddress).balanceOf(address(this));
        require(amountOut >= amountOutMin, "HearthV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        IWEMBER(wemberAddress).withdraw(amountOut);
        TransferHelper.safeTransferETH(to, amountOut);
    }

    // ------------------------------------------------------------ LIBRARY PASSTHRU

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) external pure returns (uint256 amountB) {
        return HearthV2Library.quote(amountA, reserveA, reserveB);
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        external
        pure
        returns (uint256 amountOut)
    {
        return HearthV2Library.getAmountOut(amountIn, reserveIn, reserveOut);
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        external
        pure
        returns (uint256 amountIn)
    {
        return HearthV2Library.getAmountIn(amountOut, reserveIn, reserveOut);
    }

    function getAmountsOut(uint256 amountIn, address[] memory path)
        external
        view
        returns (uint256[] memory amounts)
    {
        return HearthV2Library.getAmountsOut(factoryAddress, amountIn, path);
    }

    function getAmountsIn(uint256 amountOut, address[] memory path)
        external
        view
        returns (uint256[] memory amounts)
    {
        return HearthV2Library.getAmountsIn(factoryAddress, amountOut, path);
    }
}
