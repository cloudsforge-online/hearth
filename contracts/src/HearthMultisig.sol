// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

/// @title HearthMultisig
/// @notice An *m*-of-*n* wallet: a call executes only once `required` of the current
/// owners have confirmed it.
///
/// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
///
/// `HearthV2Factory.feeToSetter` is the one privileged role in the whole DEX. It
/// decides where the protocol fee goes, and V2 gives it no timelock and no two-step
/// handover: whoever holds that key redirects the fee switch in a single transaction,
/// and `setFeeToSetter` hands the role on with no acceptance step. Worse, moving the
/// role off a compromised key requires *that key*. So the address passed to the
/// factory's constructor has to already be a contract that no single person can
/// operate — not a deployer EOA, not "we'll migrate it later".
///
/// Nothing in this estate was one, so this is it. It is deliberately the smallest
/// thing that satisfies the requirement.
///
/// ── CONFIRMATIONS ARE ON-CHAIN, NOT AGGREGATED SIGNATURES ───────────────────────
///
/// Safe-style wallets collect EIP-712 signatures off-chain and submit them in one
/// transaction. That is the right trade when gas is expensive and signers are many.
/// Here neither holds: EMBER is mined by the project, the signer set is small, and an
/// off-chain scheme needs a domain separator, a nonce discipline and a signature
/// malleability policy — three more things to get wrong for a saving that does not
/// matter. Each owner sends their own confirmation from their own key. There is no
/// `ecrecover` in this contract and nothing to replay.
///
/// ── THE PARTS THAT ARE NOT THE OBVIOUS ONES ─────────────────────────────────────
///
/// 1. Confirmations are counted over the CURRENT owner list, never cached. A stored
///    counter goes stale the moment an owner is removed, and the direction it goes
///    stale in is "a departed signer still counts toward the threshold". Counting
///    live is O(n) on a set this contract caps at 20, and it cannot be wrong.
///
/// 2. `removeOwner` REVERTS rather than lowering `required` to fit, which is what the
///    Gnosis original does. Silently reducing a 3-of-3 to a 2-of-2 as a side effect of
///    removing someone is a change to the security property, and a change to the
///    security property should be a proposal the owners confirm on its own terms. Use
///    `replaceOwner` to rotate a signer — the count, and therefore the threshold, does
///    not move.
///
/// 3. A failed execution reverts and bubbles the target's reason, rather than being
///    swallowed into an `ExecutionFailure` event. `executed` is written before the
///    call and rolled back with it, so a transaction that fails is still pending and
///    can be retried after the cause is fixed — and the caller is told what the cause
///    was instead of reading it out of a log.
///
/// 4. Owner and threshold changes are `onlyWallet`: they are ordinary proposals this
///    contract makes to itself, confirmed by the same threshold as anything else.
///    There is no admin path around the multisig, because that path would be the
///    thing an attacker looks for first.
contract HearthMultisig {
    /// @notice Upper bound on the owner set. Every confirmation count walks this list,
    /// so an unbounded set is an unbounded loop; 20 is far above any plausible signer
    /// roster and far below a gas limit.
    uint256 public constant MAX_OWNERS = 20;

    event Deposit(address indexed sender, uint256 value);
    event Submission(uint256 indexed txId, address indexed to, uint256 value, bytes data);
    event Confirmation(address indexed owner, uint256 indexed txId);
    event Revocation(address indexed owner, uint256 indexed txId);
    event Execution(uint256 indexed txId, address indexed to, uint256 value);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event RequirementChanged(uint256 required);

    struct Transaction {
        address to;
        uint256 value;
        bytes data;
        bool executed;
    }

    address[] private _owners;
    Transaction[] private _transactions;

    /// @notice Is this address one of the current owners?
    mapping(address => bool) public isOwner;
    /// @notice How many confirmations a transaction needs to execute.
    uint256 public required;
    /// @notice Has `owner` confirmed transaction `txId`? A confirmation by an address
    /// that is later removed from the owner set stops counting, because
    /// `confirmationCount` walks the owner list rather than a stored tally.
    mapping(uint256 => mapping(address => bool)) public confirmedBy;

    modifier onlyOwner() {
        require(isOwner[msg.sender], "HearthMultisig: NOT_OWNER");
        _;
    }

    /// @dev The only way in for owner and threshold changes: a proposal this contract
    /// executes against itself, which means it passed the threshold like anything else.
    modifier onlyWallet() {
        require(msg.sender == address(this), "HearthMultisig: NOT_WALLET");
        _;
    }

    modifier txExists(uint256 txId) {
        require(txId < _transactions.length, "HearthMultisig: NO_SUCH_TX");
        _;
    }

    /// @param owners_ The initial signer set. Duplicates and the zero address are
    /// rejected here rather than tolerated, because both silently weaken the
    /// threshold — a duplicate is one key holding two confirmations.
    /// @param required_ The initial threshold, 1..owners_.length.
    constructor(address[] memory owners_, uint256 required_) {
        require(owners_.length > 0, "HearthMultisig: NO_OWNERS");
        require(owners_.length <= MAX_OWNERS, "HearthMultisig: TOO_MANY_OWNERS");
        require(required_ > 0 && required_ <= owners_.length, "HearthMultisig: BAD_REQUIRED");
        for (uint256 i = 0; i < owners_.length; i++) {
            address owner = owners_[i];
            require(owner != address(0), "HearthMultisig: ZERO_OWNER");
            require(!isOwner[owner], "HearthMultisig: DUPLICATE_OWNER");
            isOwner[owner] = true;
            _owners.push(owner);
            emit OwnerAdded(owner);
        }
        required = required_;
        emit RequirementChanged(required_);
    }

    /// @dev So the wallet can hold EMBER — a `feeTo` recipient, or a treasury, needs to
    /// be paid without a proposal.
    receive() external payable {
        if (msg.value > 0) emit Deposit(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------ proposals

    /// @notice Propose a call, and confirm it as the submitter in the same transaction.
    /// @dev The submitter's confirmation is implied: proposing a call one does not
    /// approve of is not a thing that happens, and the extra transaction would only be
    /// a way to forget.
    function submitTransaction(address to, uint256 value, bytes calldata data)
        external
        onlyOwner
        returns (uint256 txId)
    {
        require(to != address(0), "HearthMultisig: ZERO_TARGET");
        txId = _transactions.length;
        _transactions.push(Transaction({to: to, value: value, data: data, executed: false}));
        emit Submission(txId, to, value, data);
        confirmedBy[txId][msg.sender] = true;
        emit Confirmation(msg.sender, txId);
    }

    function confirmTransaction(uint256 txId) external onlyOwner txExists(txId) {
        require(!_transactions[txId].executed, "HearthMultisig: ALREADY_EXECUTED");
        require(!confirmedBy[txId][msg.sender], "HearthMultisig: ALREADY_CONFIRMED");
        confirmedBy[txId][msg.sender] = true;
        emit Confirmation(msg.sender, txId);
    }

    function revokeConfirmation(uint256 txId) external onlyOwner txExists(txId) {
        require(!_transactions[txId].executed, "HearthMultisig: ALREADY_EXECUTED");
        require(confirmedBy[txId][msg.sender], "HearthMultisig: NOT_CONFIRMED");
        confirmedBy[txId][msg.sender] = false;
        emit Revocation(msg.sender, txId);
    }

    /// @notice Run a transaction that has reached the threshold.
    /// @dev Kept separate from `confirmTransaction` on purpose. If the confirmation
    /// that reaches the threshold also executed, an owner's confirmation would revert
    /// whenever the target reverts, and they would read that as "my confirmation
    /// failed" when the truth is "the proposal is wrong".
    function executeTransaction(uint256 txId) external onlyOwner txExists(txId) {
        Transaction storage t = _transactions[txId];
        require(!t.executed, "HearthMultisig: ALREADY_EXECUTED");
        require(confirmationCount(txId) >= required, "HearthMultisig: NOT_ENOUGH_CONFIRMATIONS");

        // Written before the call: a target that re-enters here finds the transaction
        // already executed. Rolled back with the revert below if the call fails, which
        // leaves the proposal pending and retryable.
        t.executed = true;

        (bool succeeded, bytes memory ret) = t.to.call{value: t.value}(t.data);
        if (!succeeded) {
            // Bubble the target's own revert reason. Without this the owners see a bare
            // failure and have to reconstruct the cause; with it, a rejected
            // `setFeeTo` says `HearthV2: FORBIDDEN` in the trace. Assembly is the only
            // way to re-raise return data unchanged.
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        emit Execution(txId, t.to, t.value);
    }

    // ------------------------------------------------------- owners and threshold

    function addOwner(address owner) external onlyWallet {
        require(owner != address(0), "HearthMultisig: ZERO_OWNER");
        require(!isOwner[owner], "HearthMultisig: DUPLICATE_OWNER");
        require(_owners.length < MAX_OWNERS, "HearthMultisig: TOO_MANY_OWNERS");
        isOwner[owner] = true;
        _owners.push(owner);
        emit OwnerAdded(owner);
    }

    /// @dev Reverts if the removal would leave fewer owners than `required`, instead of
    /// quietly lowering the threshold to fit. Lower the threshold first, in its own
    /// proposal, if that is genuinely what the owners want.
    function removeOwner(address owner) external onlyWallet {
        require(isOwner[owner], "HearthMultisig: NOT_OWNER");
        require(_owners.length - 1 >= required, "HearthMultisig: WOULD_STRAND_REQUIRED");
        isOwner[owner] = false;
        for (uint256 i = 0; i < _owners.length; i++) {
            if (_owners[i] == owner) {
                _owners[i] = _owners[_owners.length - 1];
                _owners.pop();
                break;
            }
        }
        emit OwnerRemoved(owner);
    }

    /// @notice Rotate a signer: swap one key for another without changing the count.
    /// @dev This is the intended way to move a signer to a new device or hand the seat
    /// to a different person, precisely because it does not touch the threshold.
    function replaceOwner(address owner, address newOwner) external onlyWallet {
        require(isOwner[owner], "HearthMultisig: NOT_OWNER");
        require(newOwner != address(0), "HearthMultisig: ZERO_OWNER");
        require(!isOwner[newOwner], "HearthMultisig: DUPLICATE_OWNER");
        for (uint256 i = 0; i < _owners.length; i++) {
            if (_owners[i] == owner) {
                _owners[i] = newOwner;
                break;
            }
        }
        isOwner[owner] = false;
        isOwner[newOwner] = true;
        emit OwnerRemoved(owner);
        emit OwnerAdded(newOwner);
    }

    function changeRequirement(uint256 required_) external onlyWallet {
        require(required_ > 0 && required_ <= _owners.length, "HearthMultisig: BAD_REQUIRED");
        required = required_;
        emit RequirementChanged(required_);
    }

    // ------------------------------------------------------------------- readers

    function owners() external view returns (address[] memory) {
        return _owners;
    }

    function ownerCount() external view returns (uint256) {
        return _owners.length;
    }

    function transactionCount() external view returns (uint256) {
        return _transactions.length;
    }

    function transaction(uint256 txId)
        external
        view
        txExists(txId)
        returns (address to, uint256 value, bytes memory data, bool executed)
    {
        Transaction storage t = _transactions[txId];
        return (t.to, t.value, t.data, t.executed);
    }

    /// @notice Confirmations from addresses that are owners RIGHT NOW.
    function confirmationCount(uint256 txId) public view txExists(txId) returns (uint256 count) {
        for (uint256 i = 0; i < _owners.length; i++) {
            if (confirmedBy[txId][_owners[i]]) count++;
        }
    }

    function isConfirmed(uint256 txId) external view returns (bool) {
        return confirmationCount(txId) >= required;
    }
}
