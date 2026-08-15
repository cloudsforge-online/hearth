// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

import {IHearthV2Factory} from "./interfaces/IHearthV2Factory.sol";
import {IHearthV2Pair} from "./interfaces/IHearthV2Pair.sol";
import {HearthV2Pair} from "./HearthV2Pair.sol";

/// @title HearthV2Factory
/// @notice Creates and registers `HearthV2Pair` pools. A port of Uniswap's
/// `UniswapV2Factory`.
///
/// Pairs are deployed with CREATE2 using `keccak256(token0, token1)` as the salt, so
/// that a pair's address is a pure function of `(factory, token0, token1)` and the
/// router can compute it without an external call. `token0` is always the numerically
/// smaller address, which makes a pair's identity independent of argument order.
///
/// The CREATE2 address also depends on `keccak256(type(HearthV2Pair).creationCode)` —
/// the init code hash — which changes with any edit to `HearthV2Pair`, to anything it
/// imports, or to the compiler version and settings. `pairCodeHash()` returns the value
/// this factory will actually produce; `HearthV2Library.INIT_CODE_HASH` hard-codes what
/// the router believes it to be. They must agree. See contracts/README.md.
contract HearthV2Factory is IHearthV2Factory {
    /// @notice Recipient of the protocol fee (1/6th of the 0.3%). Zero means the fee is
    /// off and 100% of the fee accrues to liquidity providers.
    address public feeTo;
    /// @notice The only address that may change `feeTo` or hand over this role.
    address public feeToSetter;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    /// @param _feeToSetter The address that may move the fee switch. Rejected if zero,
    /// because a factory born with no setter has no fee switch at all and nothing
    /// detects it — `feeTo()` reads zero either way, and there is no key that can fix it.
    constructor(address _feeToSetter) {
        require(_feeToSetter != address(0), "HearthV2: ZERO_ADDRESS");
        feeToSetter = _feeToSetter;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function pairCodeHash() external pure returns (bytes32) {
        return keccak256(type(HearthV2Pair).creationCode);
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "HearthV2: IDENTICAL_ADDRESSES");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "HearthV2: ZERO_ADDRESS");
        require(getPair[token0][token1] == address(0), "HearthV2: PAIR_EXISTS"); // single check is sufficient

        // The original wrote this with inline assembly `create2`; `new C{salt:}()` is the
        // 0.8 spelling of exactly the same thing and yields the same address.
        pair = address(new HearthV2Pair{salt: keccak256(abi.encodePacked(token0, token1))}());
        IHearthV2Pair(pair).initialize(token0, token1);

        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // populate both directions
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address _feeTo) external {
        require(msg.sender == feeToSetter, "HearthV2: FORBIDDEN");
        feeTo = _feeTo;
    }

    /// @notice Hand the role on. There is no acceptance step — V2 has none, and adding
    /// one here would put this factory's ABI out of step with every V2 tool — so the
    /// only protection against handing it somewhere unusable is refusing the one
    /// destination that is definitely unusable.
    /// @dev Uniswap V2 allows `setFeeToSetter(address(0))`, and after it no key on earth
    /// can call `setFeeTo` or `setFeeToSetter` again: the role is not stolen, it stops
    /// existing, and recovering it means a new factory, a new router and every pool
    /// migrated. A truncated or empty address pasted into a proposal lands on zero, so
    /// this is a plausible mistake with an unrecoverable result. Note the asymmetry with
    /// `setFeeTo`, where zero is the meaningful "fee off" state and must stay allowed.
    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, "HearthV2: FORBIDDEN");
        require(_feeToSetter != address(0), "HearthV2: ZERO_ADDRESS");
        feeToSetter = _feeToSetter;
    }
}
