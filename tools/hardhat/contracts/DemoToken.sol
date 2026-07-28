// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * A deliberately boring ERC-20, so that scripts/swap.js has something to pool
 * EMBER against. 18 decimals, fixed supply, minted to the deployer.
 *
 * This is NOT a template for an asset you intend anyone to hold. It has no
 * access control, no pause, no upgrade path and no supply policy, because the
 * only thing it is for is proving that a swap works end to end.
 *
 * Note the absence of a fee on transfer. The Uniswap V2 router has separate
 * `…SupportingFeeOnTransferTokens` entry points for tokens that take a cut
 * mid-transfer, and using the ordinary ones with such a token reverts on the
 * router's own output check.
 */
contract DemoToken {
    string public constant name = "Hearth Demo Token";
    string public constant symbol = "DEMO";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        // The usual infinite-approval shortcut: type(uint256).max means "do not
        // decrement", which is what every router integration relies on.
        if (allowed != type(uint256).max) {
            require(allowed >= value, "DEMO: allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(to != address(0), "DEMO: to zero");
        uint256 bal = balanceOf[from];
        require(bal >= value, "DEMO: balance");
        unchecked {
            balanceOf[from] = bal - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
