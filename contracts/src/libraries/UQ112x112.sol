// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

/// @notice A binary fixed point number with 112 integer and 112 fractional bits,
/// carried in a `uint224`. This is the format of the TWAP price accumulators.
///
/// Range: [0, 2**112 - 1]. Resolution: 1 / 2**112.
///
/// PORTING NOTE (0.6 -> 0.8): the original relied on unchecked arithmetic everywhere.
/// `encode` cannot overflow — `y <= 2**112 - 1` and `Q112 == 2**112`, so the product is
/// at most `2**224 - 2**112`, which fits a `uint224`. It is wrapped in `unchecked`
/// anyway so the compiler does not emit a revert branch that can never be taken; this
/// keeps the accumulator update on the same gas footing as the audited original.
///
/// The deliberate overflow that V2 actually depends on is NOT here — it is the `+=`
/// on `price0CumulativeLast` / `price1CumulativeLast` in `HearthV2Pair._update`.
library UQ112x112 {
    uint224 internal constant Q112 = 2 ** 112;

    /// @dev Encode a `uint112` as a UQ112x112.
    function encode(uint112 y) internal pure returns (uint224 z) {
        unchecked {
            z = uint224(y) * Q112; // never overflows: see the note above
        }
    }

    /// @dev Divide a UQ112x112 by a `uint112`, returning a UQ112x112.
    /// Reverts on `y == 0`, exactly as the original did — callers guard with
    /// `_reserve0 != 0 && _reserve1 != 0`.
    function uqdiv(uint224 x, uint112 y) internal pure returns (uint224 z) {
        z = x / uint224(y);
    }
}
