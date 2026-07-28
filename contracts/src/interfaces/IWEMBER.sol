// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

interface IWEMBER {
    function deposit() external payable;
    function withdraw(uint256) external;
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}
