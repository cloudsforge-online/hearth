// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

import {HearthV2ERC20} from "./HearthV2ERC20.sol";
import {Math} from "./libraries/Math.sol";
import {UQ112x112} from "./libraries/UQ112x112.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IHearthV2Pair} from "./interfaces/IHearthV2Pair.sol";
import {IHearthV2Factory} from "./interfaces/IHearthV2Factory.sol";
import {IHearthV2Callee} from "./interfaces/IHearthV2Callee.sol";

/// @title HearthV2Pair
/// @notice A constant-product pool, `x * y >= k`, with a 0.3% fee. A faithful port of
/// Uniswap V2's `UniswapV2Pair` to Solidity 0.8.26.
///
/// THE CONSTRUCTOR TAKES NO ARGUMENTS. This is load-bearing: the factory deploys pairs
/// with CREATE2 and the router computes their addresses off-chain from
/// `keccak256(0xff ++ factory ++ salt ++ INIT_CODE_HASH)`. An argument would make the
/// init code vary per pair and destroy that. Tokens are set once by `initialize`, which
/// only the factory may call.
///
/// PORTING NOTES (0.6 -> 0.8) — the two places V2 *needs* wrapping arithmetic:
///
///  1. `_update` accumulates `price{0,1}CumulativeLast` with a `uint256` that is meant
///     to wrap. Consumers of a TWAP always read the difference between two observations,
///     and that difference is correct across a wrap so long as the wrap is silent. Under
///     0.8's checked arithmetic the `+=` would revert instead, permanently bricking every
///     pair whose accumulator crossed 2**256 and, long before that, making an oracle
///     reading straddling the wrap revert rather than return.
///
///  2. `timeElapsed = blockTimestamp - blockTimestampLast` on `uint32` is meant to wrap.
///     The timestamp is deliberately truncated to 32 bits so that it packs into the same
///     storage slot as the two `uint112` reserves — one `SLOAD` for `getReserves`. It
///     wraps in February 2106; checked subtraction would revert at that moment and every
///     `mint`, `burn`, `swap` and `sync` on every pair would fail forever.
///
/// Both live inside a single `unchecked` block below, which is the whole of the change.
/// Everything else that `SafeMath` used to guard is now guarded by the compiler, so
/// `SafeMath` has been deleted rather than kept as decoration.
contract HearthV2Pair is IHearthV2Pair, HearthV2ERC20 {
    using UQ112x112 for uint224;

    /// @notice Burned to the zero address on the very first `mint`, permanently. It makes
    /// the LP supply impossible to drain to zero, which is what stops an attacker from
    /// donating tokens to a one-wei pool and rounding every later depositor down to nothing.
    uint256 public constant MINIMUM_LIQUIDITY = 10 ** 3;

    address public factory;
    address public token0;
    address public token1;

    // Packed into one slot; read together by getReserves().
    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    /// @notice `reserve0 * reserve1` as of the last liquidity event. Only tracked while
    /// the protocol fee is on.
    uint256 public kLast;

    uint256 private unlocked = 1;

    modifier lock() {
        require(unlocked == 1, "HearthV2: LOCKED");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor() {
        factory = msg.sender;
    }

    /// @dev Called once by the factory immediately after CREATE2.
    function initialize(address _token0, address _token1) external {
        require(msg.sender == factory, "HearthV2: FORBIDDEN");
        token0 = _token0;
        token1 = _token1;
    }

    function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    function _safeTransfer(address token, address to, uint256 value) private {
        // bytes4(keccak256(bytes("transfer(address,uint256)")))
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "HearthV2: TRANSFER_FAILED");
    }

    /// @dev Write the new reserves and, on the first touch of each block, advance the
    /// TWAP accumulators by the *previous* reserves times the elapsed time.
    function _update(uint256 balance0, uint256 balance1, uint112 _reserve0, uint112 _reserve1) private {
        require(balance0 <= type(uint112).max && balance1 <= type(uint112).max, "HearthV2: OVERFLOW");
        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        unchecked {
            // DELIBERATE WRAPAROUND — see the porting notes at the top of this file.
            uint32 timeElapsed = blockTimestamp - blockTimestampLast;
            if (timeElapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
                // The multiplications cannot overflow: encode/uqdiv yields < 2**224 and
                // timeElapsed < 2**32. The additions are meant to.
                price0CumulativeLast += uint256(UQ112x112.encode(_reserve1).uqdiv(_reserve0)) * timeElapsed;
                price1CumulativeLast += uint256(UQ112x112.encode(_reserve0).uqdiv(_reserve1)) * timeElapsed;
            }
        }
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = blockTimestamp;
        emit Sync(reserve0, reserve1);
    }

    /// @dev If `feeTo` is set, mint LP worth 1/6th of the growth in sqrt(k) since the
    /// last liquidity event — the protocol's 0.05% of the 0.3%.
    function _mintFee(uint112 _reserve0, uint112 _reserve1) private returns (bool feeOn) {
        address feeTo = IHearthV2Factory(factory).feeTo();
        feeOn = feeTo != address(0);
        uint256 _kLast = kLast; // gas savings
        if (feeOn) {
            if (_kLast != 0) {
                uint256 rootK = Math.sqrt(uint256(_reserve0) * _reserve1);
                uint256 rootKLast = Math.sqrt(_kLast);
                if (rootK > rootKLast) {
                    uint256 numerator = totalSupply * (rootK - rootKLast);
                    uint256 denominator = rootK * 5 + rootKLast;
                    uint256 liquidity = numerator / denominator;
                    if (liquidity > 0) _mint(feeTo, liquidity);
                }
            }
        } else if (_kLast != 0) {
            kLast = 0;
        }
    }

    /// @notice Mint LP tokens for whatever was transferred in since the last sync.
    /// Low-level: call this from a contract that has already sent both tokens, or use
    /// the router.
    function mint(address to) external lock returns (uint256 liquidity) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply; // must be read after _mintFee, which can mint
        if (_totalSupply == 0) {
            liquidity = Math.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(address(0), MINIMUM_LIQUIDITY); // permanently locked
        } else {
            liquidity = Math.min(amount0 * _totalSupply / _reserve0, amount1 * _totalSupply / _reserve1);
        }
        require(liquidity > 0, "HearthV2: INSUFFICIENT_LIQUIDITY_MINTED");
        _mint(to, liquidity);

        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * reserve1;
        emit Mint(msg.sender, amount0, amount1);
    }

    /// @notice Burn the LP tokens this contract holds and return the underlying.
    /// Low-level: send the LP tokens here first, or use the router.
    function burn(address to) external lock returns (uint256 amount0, uint256 amount1) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        address _token0 = token0; // gas savings
        address _token1 = token1;
        uint256 balance0 = IERC20(_token0).balanceOf(address(this));
        uint256 balance1 = IERC20(_token1).balanceOf(address(this));
        uint256 liquidity = balanceOf[address(this)];

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply; // must be read after _mintFee, which can mint
        // Pro-rata against balances, not reserves, so donated tokens are distributed.
        amount0 = liquidity * balance0 / _totalSupply;
        amount1 = liquidity * balance1 / _totalSupply;
        require(amount0 > 0 && amount1 > 0, "HearthV2: INSUFFICIENT_LIQUIDITY_BURNED");
        _burn(address(this), liquidity);
        _safeTransfer(_token0, to, amount0);
        _safeTransfer(_token1, to, amount1);
        balance0 = IERC20(_token0).balanceOf(address(this));
        balance1 = IERC20(_token1).balanceOf(address(this));

        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * reserve1;
        emit Burn(msg.sender, amount0, amount1, to);
    }

    /// @notice Swap. Optimistically transfers the output first, optionally calls back
    /// into `to` (the flash swap), then requires that `k` did not decrease once the 0.3%
    /// fee is charged on whatever came in. Low-level: use the router.
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external lock {
        require(amount0Out > 0 || amount1Out > 0, "HearthV2: INSUFFICIENT_OUTPUT_AMOUNT");
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        require(amount0Out < _reserve0 && amount1Out < _reserve1, "HearthV2: INSUFFICIENT_LIQUIDITY");

        uint256 balance0;
        uint256 balance1;
        {
            // scope for _token{0,1}, avoids stack too deep
            address _token0 = token0;
            address _token1 = token1;
            require(to != _token0 && to != _token1, "HearthV2: INVALID_TO");
            if (amount0Out > 0) _safeTransfer(_token0, to, amount0Out);
            if (amount1Out > 0) _safeTransfer(_token1, to, amount1Out);
            if (data.length > 0) IHearthV2Callee(to).hearthV2Call(msg.sender, amount0Out, amount1Out, data);
            balance0 = IERC20(_token0).balanceOf(address(this));
            balance1 = IERC20(_token1).balanceOf(address(this));
        }
        uint256 amount0In = balance0 > _reserve0 - amount0Out ? balance0 - (_reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _reserve1 - amount1Out ? balance1 - (_reserve1 - amount1Out) : 0;
        require(amount0In > 0 || amount1In > 0, "HearthV2: INSUFFICIENT_INPUT_AMOUNT");
        {
            // scope for the invariant check, avoids stack too deep.
            // Balances are <= 2**112, so scaling by 1000 keeps every product under
            // 2**244 and checked arithmetic never trips here.
            uint256 balance0Adjusted = balance0 * 1000 - amount0In * 3;
            uint256 balance1Adjusted = balance1 * 1000 - amount1In * 3;
            require(
                balance0Adjusted * balance1Adjusted >= uint256(_reserve0) * _reserve1 * (1000 ** 2), "HearthV2: K"
            );
        }

        _update(balance0, balance1, _reserve0, _reserve1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    /// @notice Sweep any balance above the recorded reserves to `to`.
    function skim(address to) external lock {
        address _token0 = token0; // gas savings
        address _token1 = token1;
        _safeTransfer(_token0, to, IERC20(_token0).balanceOf(address(this)) - reserve0);
        _safeTransfer(_token1, to, IERC20(_token1).balanceOf(address(this)) - reserve1);
    }

    /// @notice Force the reserves to match the balances. The escape hatch for a pair
    /// whose reserves have been desynchronised, e.g. by a rebasing token.
    function sync() external lock {
        _update(
            IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)), reserve0, reserve1
        );
    }
}
