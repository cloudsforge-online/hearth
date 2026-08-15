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
///    live is O(n) on a set this contract caps at 20.
///
///    Walking the list is necessary and not sufficient, which is what the first version
///    of this contract got wrong (hearth#26). A confirmation flag that is merely
///    *ignored* while its owner is out of the set comes back the moment that address is
///    added again — so a signer rotated out under suspicion and later rotated back in
///    would silently re-confirm every proposal still pending from before, without
///    sending a transaction or knowing which proposals they were now confirming.
///
///    So a confirmation records WHEN it was given, and counts only if it was given
///    during the confirmer's current tenure: `_confirmedIn[txId][owner] >=
///    ownerSince[owner]`. Joining the owner set takes the next `ownerEpoch`, which is
///    strictly higher than any confirmation that came before it, so a rejoining owner
///    starts from nothing and re-confirms what they still mean. Clearing the map on the
///    way out would be the obvious alternative and is an unbounded loop over the whole
///    proposal history; this is O(1) and does not go stale.
///
///    It is deliberately per-owner rather than one global cutoff. Rotating carol out
///    must not discard alice's confirmations — alice did not go anywhere, and a
///    signer-set change that silently un-confirms everything makes routine rotations
///    expensive enough to avoid.
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
    /// @notice A counter that only ever goes up, incremented every time an address JOINS
    /// the owner set. Not by `changeRequirement`, which changes how many confirmations
    /// are needed rather than who may give them, and not by `removeOwner`, which has
    /// nothing to invalidate until the address comes back.
    uint256 public ownerEpoch = 1;

    /// @notice The epoch at which this address most recently BECAME an owner. Zero for an
    /// address that never has. Re-adding a removed owner moves it forward, which is what
    /// makes their old confirmations stay dead.
    mapping(address => uint256) public ownerSince;

    /// @dev txId => owner => the epoch the confirmation was given in, or zero for none.
    /// A confirmation counts only if it was given during the confirmer's current tenure:
    /// `_confirmedIn >= ownerSince`. Confirmations from owners who never left are
    /// untouched by someone else's rotation, which is why this is per-owner and not a
    /// single global cutoff.
    mapping(uint256 => mapping(address => uint256)) private _confirmedIn;

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
            ownerSince[owner] = ownerEpoch; // 1 — the founding tenure
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
        _confirmedIn[txId][msg.sender] = ownerEpoch;
        emit Confirmation(msg.sender, txId);
    }

    /// @dev A returning owner whose earlier confirmation predates their current tenure is
    /// not "already confirmed" — `confirmedBy` reads false for them — so they can and
    /// must confirm again, now, if they still mean it.
    function confirmTransaction(uint256 txId) external onlyOwner txExists(txId) {
        require(!_transactions[txId].executed, "HearthMultisig: ALREADY_EXECUTED");
        require(!confirmedBy(txId, msg.sender), "HearthMultisig: ALREADY_CONFIRMED");
        _confirmedIn[txId][msg.sender] = ownerEpoch;
        emit Confirmation(msg.sender, txId);
    }

    function revokeConfirmation(uint256 txId) external onlyOwner txExists(txId) {
        require(!_transactions[txId].executed, "HearthMultisig: ALREADY_EXECUTED");
        require(confirmedBy(txId, msg.sender), "HearthMultisig: NOT_CONFIRMED");
        _confirmedIn[txId][msg.sender] = 0;
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
        ownerSince[owner] = ++ownerEpoch;
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
        // No epoch bump here on purpose. A departed owner's confirmations stop counting
        // immediately because `confirmationCount` walks the live owner list, and they
        // stay dead if the address ever returns because rejoining takes a strictly
        // higher epoch than any confirmation given before it.
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
        ownerSince[newOwner] = ++ownerEpoch;
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

    /// @notice Has `owner` confirmed transaction `txId`, in a way that still counts?
    /// @dev Two conditions, and the second is the one that is easy to leave out. The
    /// confirmation must exist, and it must have been given under the signer set that
    /// exists now. Clearing the map when an owner leaves would be the obvious way to get
    /// the second, and it is an unbounded loop over the whole proposal history; the epoch
    /// is O(1) and strictly stronger, because it also invalidates confirmations when an
    /// unrelated owner joins. Same selector and same return type as the `public mapping`
    /// this replaced, so nothing off-chain has to change.
    function confirmedBy(uint256 txId, address owner) public view returns (bool) {
        uint256 at = _confirmedIn[txId][owner];
        return at != 0 && at >= ownerSince[owner];
    }

    /// @notice Confirmations from addresses that are owners RIGHT NOW, given while they
    /// were. A departed signer's confirmation stops counting when they leave — and stays
    /// stopped if they come back, which is the part a stored tally and a cleared flag
    /// both get wrong.
    function confirmationCount(uint256 txId) public view txExists(txId) returns (uint256 count) {
        for (uint256 i = 0; i < _owners.length; i++) {
            if (confirmedBy(txId, _owners[i])) count++;
        }
    }

    function isConfirmed(uint256 txId) external view returns (bool) {
        return confirmationCount(txId) >= required;
    }
}
