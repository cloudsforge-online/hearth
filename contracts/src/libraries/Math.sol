// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

/// @notice Uniswap V2's `Math`, unchanged. Babylonian square root, used for the
/// initial LP mint and for the protocol-fee accrual in `_mintFee`.
library Math {
    function min(uint256 x, uint256 y) internal pure returns (uint256 z) {
        z = x < y ? x : y;
    }

    /// @dev Babylonian method. Converges from above, so the loop terminates when the
    /// next estimate stops decreasing. Every operation here is provably in range
    /// (`x` and `z` are bounded above by `y`), so checked arithmetic never trips.
    function sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
