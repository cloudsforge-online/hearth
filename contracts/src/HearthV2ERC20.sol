// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

import {IHearthV2ERC20} from "./interfaces/IHearthV2ERC20.sol";

/// @title HearthV2ERC20
/// @notice The liquidity-provider token every `HearthV2Pair` inherits. A port of
/// Uniswap's `UniswapV2ERC20` to Solidity 0.8, including EIP-2612 `permit`.
///
/// PORTING NOTES (0.5 -> 0.8):
///   * `SafeMath` is gone. 0.8 checks every `+` and `-` by default and reverts with
///     `Panic(0x11)` on overflow instead of a string. The failure modes are identical;
///     leaving SafeMath in place would have been decoration over a compiler feature.
///   * The storage layout is unchanged from the original, because `HearthV2Pair`
///     inherits from this and appends its own slots after these five.
///   * `DOMAIN_SEPARATOR` stays a constructor-assigned storage variable rather than
///     becoming `immutable`. That is faithful to the original and, more usefully, it
///     keeps the door open to recomputing it after a chain split.
abstract contract HearthV2ERC20 is IHearthV2ERC20 {
    string private constant _NAME = "Hearth V2";
    string private constant _SYMBOL = "HEARTH-V2";
    uint8 private constant _DECIMALS = 18;

    // --- slot 0..4: layout must not change, HearthV2Pair extends it ---
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bytes32 public DOMAIN_SEPARATOR;
    mapping(address => uint256) public nonces;

    /// @dev keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")
    /// Folded by the compiler at build time; asserted against the canonical constant in the test suite.
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(_NAME)),
                keccak256(bytes("1")),
                block.chainid, // 7411 on Hearth; see docs/evm-spec.md §1
                address(this)
            )
        );
    }

    function name() external pure returns (string memory) {
        return _NAME;
    }

    function symbol() external pure returns (string memory) {
        return _SYMBOL;
    }

    function decimals() external pure returns (uint8) {
        return _DECIMALS;
    }

    function _mint(address to, uint256 value) internal {
        totalSupply = totalSupply + value;
        balanceOf[to] = balanceOf[to] + value;
        emit Transfer(address(0), to, value);
    }

    function _burn(address from, uint256 value) internal {
        balanceOf[from] = balanceOf[from] - value;
        totalSupply = totalSupply - value;
        emit Transfer(from, address(0), value);
    }

    function _approve(address owner, address spender, uint256 value) private {
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function _transfer(address from, address to, uint256 value) private {
        balanceOf[from] = balanceOf[from] - value;
        balanceOf[to] = balanceOf[to] + value;
        emit Transfer(from, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        // An allowance of type(uint256).max is treated as infinite and never decremented,
        // exactly as in the original.
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] = allowance[from][msg.sender] - value;
        }
        _transfer(from, to, value);
        return true;
    }

    /// @notice EIP-2612 gasless approval. Requires `ecrecover`, i.e. precompile `0x01`.
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(deadline >= block.timestamp, "HearthV2: EXPIRED");
        bytes32 digest;
        unchecked {
            digest = keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    DOMAIN_SEPARATOR,
                    keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))
                )
            );
        }
        address recoveredAddress = ecrecover(digest, v, r, s);
        require(recoveredAddress != address(0) && recoveredAddress == owner, "HearthV2: INVALID_SIGNATURE");
        _approve(owner, spender, value);
    }
}
