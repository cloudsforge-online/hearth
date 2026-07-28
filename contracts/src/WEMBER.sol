// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

/// @title WEMBER — Wrapped Ember
/// @notice EMBER, Hearth's native gas asset, as an ERC-20. A port of WETH9.
///
/// An AMM cannot hold the native asset in a pool: `x * y = k` needs two things it can
/// call `transferFrom` on. WEMBER is the adapter. One WEMBER is always exactly one
/// EMBER — `deposit()` mints at par, `withdraw()` burns at par, and `totalSupply()` is
/// simply this contract's EMBER balance, so the peg is an accounting identity rather
/// than a promise.
///
/// EMBER has 18 decimals (docs/evm-spec.md §1), so WEMBER does too and no scaling is
/// needed anywhere.
///
/// DELIBERATE DEVIATION FROM WETH9: `withdraw` pays out with `.call{value:}` rather than
/// `.transfer`. The 2300-gas stipend `.transfer` imposes has been the wrong default since
/// EIP-1884 repriced SLOAD — it makes withdrawal fail for perfectly ordinary
/// smart-contract wallets. The balance is decremented before the call, so the
/// reentrancy that `.transfer` was protecting against gets a zeroed balance to work with.
///
/// Otherwise this is WETH9 as deployed: same function names, same events, same
/// infinite-allowance shortcut, same depositing fallback.
contract WEMBER {
    string public name = "Wrapped Ember";
    string public symbol = "WEMBER";
    uint8 public decimals = 18;

    event Approval(address indexed src, address indexed guy, uint256 wad);
    event Transfer(address indexed src, address indexed dst, uint256 wad);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @dev Plain EMBER transfers wrap.
    receive() external payable {
        deposit();
    }

    /// @dev WETH9's fallback also wrapped, and a great deal of deployed code relies on
    /// sending EMBER here with arbitrary calldata. Kept for that reason.
    fallback() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) public {
        require(balanceOf[msg.sender] >= wad, "WEMBER: INSUFFICIENT_BALANCE");
        balanceOf[msg.sender] -= wad;
        (bool success,) = msg.sender.call{value: wad}("");
        require(success, "WEMBER: EMBER_TRANSFER_FAILED");
        emit Withdrawal(msg.sender, wad);
    }

    /// @notice Always equal to the EMBER held by this contract. The peg cannot drift.
    function totalSupply() public view returns (uint256) {
        return address(this).balance;
    }

    function approve(address guy, uint256 wad) public returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }

    function transfer(address dst, uint256 wad) public returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad, "WEMBER: INSUFFICIENT_BALANCE");

        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad, "WEMBER: INSUFFICIENT_ALLOWANCE");
            allowance[src][msg.sender] -= wad;
        }

        balanceOf[src] -= wad;
        balanceOf[dst] += wad;

        emit Transfer(src, dst, wad);
        return true;
    }
}
