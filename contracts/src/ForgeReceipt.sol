// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

/// @title ForgeReceipt — an ERC-20 receipt for a coin held off this chain
/// @notice One token here is a claim on one coin of `underlying`, held by the issuer on
/// the chain that coin is native to, redeemable through the issuer's withdrawal path.
///
/// ── READ THIS BEFORE YOU HOLD ONE ────────────────────────────────────────────────────
///
/// **This is not a trustless bridge and it is not "wrapped" in the WEMBER sense.** WEMBER
/// can call its peg an accounting identity because the EMBER backing it is in the WEMBER
/// contract, on this chain, visible to the same EVM that mints. A Litecoin cannot be put
/// inside a Hearth contract. So the backing for a ForgeReceipt sits at addresses on
/// another chain that somebody controls, and every holder is trusting that somebody.
///
/// The symbol says so on purpose. `fLTC`, not `wLTC` — the `w` convention has come to
/// mean "wrapped, therefore trustless", and this is not that. See §4 of
/// docs/ecosystem/39-forge-exchange.md, and 25 §1 on why letting a self-custody user
/// mistake a custodial IOU for their own coin is the most dangerous confusion a design
/// can create.
///
/// ── WHAT THIS CONTRACT DOES ABOUT IT ─────────────────────────────────────────────────
///
/// It cannot make the issuer honest. It can make dishonesty **cost an on-chain lie with a
/// timestamp on it**, which is a much smaller thing to trust than a dashboard:
///
///   1. **Issuance is bounded by an attestation, in the contract.** `issue` reverts unless
///      `totalSupply + amount <= attestation.reserve`. Over-issuing is not a policy the
///      issuer chooses to follow; it is a transaction that reverts. To over-issue, the
///      issuer must first publish a reserve figure that is false — signed, timestamped,
///      and permanent.
///   2. **The attestation names the height it was read at.** A stranger takes
///      `reserveAddresses()`, takes `attestation.height`, reads the underlying chain
///      themselves at that height, and gets a number that either matches or does not.
///      No API of ours is involved in checking us.
///   3. **A stale attestation stops issuance by itself.** Past `maxAttestationAge` the
///      contract will not mint, so "we forgot to re-attest" and "we are hiding a
///      shortfall" have the same effect: nothing new is issued.
///   4. **A shortfall is recordable and is announced.** `attest` accepts a reserve BELOW
///      `totalSupply` and emits `Undercollateralised`. The alternative — refusing to
///      record bad news — would leave the last honest number standing as the current one,
///      which is the failure this whole design is trying not to have.
///   5. **There is no pause, no freeze, no blacklist and no upgrade.** The only lever the
///      issuer has is issuance. `redeem` and `transfer` cannot be stopped by us, because
///      the only thing a pause could stop is a holder's exit.
///
/// What remains trusted, stated plainly rather than buried: the issuer can publish a
/// false reserve; the issuer can decline to pay a redemption it has recorded; and the
/// keys that do both are the ones described in docs/ecosystem/39-forge-exchange.md §7.3.
/// Nothing in this file fixes those, and a reader who wants those fixed wants a different
/// product.
///
/// ── DECIMALS ─────────────────────────────────────────────────────────────────────────
///
/// `decimals` is the UNDERLYING's, not 18. A receipt for Litecoin has 8, so one unit here
/// is one litoshi and the numbers a holder sees are the numbers their Litecoin wallet
/// shows. Scaling to 18 would make every quantity in this system a conversion away from
/// the thing it is a claim on, and conversions are where reserve arithmetic goes wrong.
contract ForgeReceipt {
    // ─── ERC-20 ──────────────────────────────────────────────────────────────────────

    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice EIP-2612, so a holder can approve without holding EMBER for gas first.
    bytes32 public DOMAIN_SEPARATOR;
    mapping(address => uint256) public nonces;
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    // ─── what this is a receipt FOR ──────────────────────────────────────────────────

    /// @notice The asset code of the coin held off-chain, e.g. "LTC". Free text on
    /// purpose: this contract cannot verify a claim about another chain, and pretending
    /// an enum makes it true would be worse than admitting it is a label.
    string public underlying;

    /// @notice Human-readable statement of whose promise this is, returned by the token
    /// itself so a wallet or explorer showing the token can show it without asking us.
    string public issuerStatement;

    // ─── the reserve ─────────────────────────────────────────────────────────────────

    struct Attestation {
        /// Units of `underlying` at its own decimals, at `height`.
        uint256 reserve;
        /// The block height on the UNDERLYING chain the figure was read at. Strictly
        /// increasing, so a favourable old reading cannot be replayed as a current one.
        uint64 height;
        /// This chain's timestamp when it was recorded. Freshness is judged here.
        uint64 at;
        /// Free reference to whatever produced the figure — a run id, a report hash.
        /// Not verified on-chain; it exists so an audit can be pointed at its source.
        bytes32 ref;
    }

    Attestation public attestation;

    /// @notice Seconds after which an attestation stops authorising issuance.
    uint64 public immutable maxAttestationAge;

    /// @notice The addresses on the underlying chain that hold the backing, published
    /// here so the check does not depend on us. Strings, because this chain has no
    /// opinion on what an address looks like on another one.
    string[] private _reserveAddresses;

    event Attested(uint256 reserve, uint64 indexed height, uint256 supply, bytes32 ref);
    event Undercollateralised(uint256 reserve, uint256 supply, uint256 shortfall, uint64 indexed height);
    event ReserveAddressesSet(uint256 count);

    // ─── issuance and redemption ─────────────────────────────────────────────────────

    struct Redemption {
        address holder;
        uint256 amount;
        /// Where the holder wants the underlying coin sent. Opaque here.
        string payoutAddress;
        uint64 requestedAt;
        /// The transaction id on the underlying chain that paid it, once it has been.
        bytes32 settledTxid;
    }

    Redemption[] private _redemptions;

    event Issued(address indexed to, uint256 amount, uint256 supplyAfter, bytes32 ref);
    event RedemptionRequested(uint256 indexed id, address indexed holder, uint256 amount, string payoutAddress);
    event RedemptionSettled(uint256 indexed id, bytes32 indexed txid);

    /// @dev A payout address longer than this is not an address, it is a mistake or an
    /// attempt to make the event log expensive to read.
    uint256 public constant MAX_PAYOUT_ADDRESS = 128;

    // ─── the one privileged role ─────────────────────────────────────────────────────

    /// @notice The only account that can attest or issue. Intended to be a
    /// `HearthMultisig`; nothing here enforces that, because a contract cannot tell an
    /// m-of-n from an EOA, and claiming otherwise would be theatre.
    address public issuer;
    address public pendingIssuer;

    event IssuerHandoverBegun(address indexed from, address indexed to);
    event IssuerChanged(address indexed from, address indexed to);

    modifier onlyIssuer() {
        require(msg.sender == issuer, "ForgeReceipt: NOT_ISSUER");
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        string memory underlying_,
        string memory issuerStatement_,
        address issuer_,
        uint64 maxAttestationAge_
    ) {
        require(issuer_ != address(0), "ForgeReceipt: ZERO_ISSUER");
        require(maxAttestationAge_ > 0, "ForgeReceipt: ZERO_MAX_AGE");
        require(bytes(underlying_).length > 0, "ForgeReceipt: NO_UNDERLYING");
        // A receipt that does not say whose promise it is fails §4's third mitigation at
        // deployment, where it is cheap, rather than on a marketing page later.
        require(bytes(issuerStatement_).length > 0, "ForgeReceipt: NO_STATEMENT");

        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        underlying = underlying_;
        issuerStatement = issuerStatement_;
        issuer = issuer_;
        maxAttestationAge = maxAttestationAge_;

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name_)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );

        emit IssuerChanged(address(0), issuer_);
    }

    // ─────────────────────────────────────────────────────────────────────────────────
    // the reserve
    // ─────────────────────────────────────────────────────────────────────────────────

    /// @notice Record what the backing addresses held, and at which height of the
    /// underlying chain.
    ///
    /// Strictly increasing height is the whole anti-replay story. Without it the issuer
    /// could keep re-publishing the last good reading after the coins moved, and every
    /// freshness check in this contract would pass on a figure about the past.
    function attest(uint256 reserve, uint64 height, bytes32 ref) external onlyIssuer {
        require(height > attestation.height, "ForgeReceipt: STALE_HEIGHT");
        attestation = Attestation({reserve: reserve, height: height, at: uint64(block.timestamp), ref: ref});
        emit Attested(reserve, height, totalSupply, ref);
        if (reserve < totalSupply) {
            // Not a revert. Bad news that cannot be recorded is bad news that goes on
            // looking like the last good news.
            emit Undercollateralised(reserve, totalSupply, totalSupply - reserve, height);
        }
    }

    /// @notice Replace the published list of backing addresses.
    ///
    /// Replace rather than append: the set changes when custody rotates keys, and an
    /// append-only list would leave a stranger unable to tell which entries still hold
    /// anything. The event carries the count so a watcher sees the change even if it
    /// never reads the array.
    function setReserveAddresses(string[] calldata addrs) external onlyIssuer {
        delete _reserveAddresses;
        for (uint256 i = 0; i < addrs.length; i++) {
            require(bytes(addrs[i]).length > 0, "ForgeReceipt: EMPTY_ADDRESS");
            _reserveAddresses.push(addrs[i]);
        }
        emit ReserveAddressesSet(addrs.length);
    }

    function reserveAddresses() external view returns (string[] memory) {
        return _reserveAddresses;
    }

    function reserveAddressCount() external view returns (uint256) {
        return _reserveAddresses.length;
    }

    function reserveAddressAt(uint256 i) external view returns (string memory) {
        require(i < _reserveAddresses.length, "ForgeReceipt: NO_SUCH_ADDRESS");
        return _reserveAddresses[i];
    }

    /// @notice True while the current attestation is young enough to authorise issuance.
    function attestationIsFresh() public view returns (bool) {
        return attestation.at != 0 && block.timestamp <= uint256(attestation.at) + uint256(maxAttestationAge);
    }

    /// @notice Everything needed to judge this token, in one call.
    /// @return supply tokens outstanding
    /// @return reserve the last attested backing
    /// @return height the underlying-chain height that figure was read at
    /// @return at this chain's timestamp when it was recorded
    /// @return fresh whether it is young enough to authorise issuance
    function coverage()
        external
        view
        returns (uint256 supply, uint256 reserve, uint64 height, uint64 at, bool fresh)
    {
        return (totalSupply, attestation.reserve, attestation.height, attestation.at, attestationIsFresh());
    }

    // ─────────────────────────────────────────────────────────────────────────────────
    // issuance and redemption
    // ─────────────────────────────────────────────────────────────────────────────────

    /// @notice Mint receipts against attested backing.
    /// @dev The two requires are the product. Everything else in this contract exists to
    /// make them mean something.
    function issue(address to, uint256 amount, bytes32 ref) external onlyIssuer {
        require(to != address(0), "ForgeReceipt: ZERO_RECIPIENT");
        require(amount > 0, "ForgeReceipt: ZERO_AMOUNT");
        require(attestationIsFresh(), "ForgeReceipt: STALE_ATTESTATION");
        require(totalSupply + amount <= attestation.reserve, "ForgeReceipt: EXCEEDS_RESERVE");

        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
        emit Issued(to, amount, totalSupply, ref);
    }

    /// @notice Burn receipts and ask for the underlying back.
    ///
    /// The burn happens FIRST and unconditionally. Supply falls the moment the claim is
    /// made, so a redemption in flight can only ever leave the book over-covered, never
    /// under — and a redemption the issuer never pays is visible as burnt supply with no
    /// `RedemptionSettled` against it, which is a harder thing to be quiet about than a
    /// support ticket.
    function redeem(uint256 amount, string calldata payoutAddress) external returns (uint256 id) {
        require(amount > 0, "ForgeReceipt: ZERO_AMOUNT");
        require(balanceOf[msg.sender] >= amount, "ForgeReceipt: INSUFFICIENT_BALANCE");
        uint256 n = bytes(payoutAddress).length;
        require(n > 0 && n <= MAX_PAYOUT_ADDRESS, "ForgeReceipt: BAD_PAYOUT_ADDRESS");

        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        emit Transfer(msg.sender, address(0), amount);

        id = _redemptions.length;
        _redemptions.push(
            Redemption({
                holder: msg.sender,
                amount: amount,
                payoutAddress: payoutAddress,
                requestedAt: uint64(block.timestamp),
                settledTxid: bytes32(0)
            })
        );
        emit RedemptionRequested(id, msg.sender, amount, payoutAddress);
    }

    /// @notice Record the underlying-chain transaction that paid a redemption.
    /// @dev Recording is all this can do. The contract cannot verify a Litecoin
    /// transaction, and a `require` that pretended to would be the most dangerous line in
    /// the file. What it buys is that the claim is public, permanent and checkable by
    /// anyone who can read the other chain.
    function settleRedemption(uint256 id, bytes32 txid) external onlyIssuer {
        require(id < _redemptions.length, "ForgeReceipt: NO_SUCH_REDEMPTION");
        require(txid != bytes32(0), "ForgeReceipt: ZERO_TXID");
        require(_redemptions[id].settledTxid == bytes32(0), "ForgeReceipt: ALREADY_SETTLED");
        _redemptions[id].settledTxid = txid;
        emit RedemptionSettled(id, txid);
    }

    function redemptionCount() external view returns (uint256) {
        return _redemptions.length;
    }

    function redemption(uint256 id)
        external
        view
        returns (address holder, uint256 amount, string memory payoutAddress, uint64 requestedAt, bytes32 settledTxid)
    {
        require(id < _redemptions.length, "ForgeReceipt: NO_SUCH_REDEMPTION");
        Redemption storage r = _redemptions[id];
        return (r.holder, r.amount, r.payoutAddress, r.requestedAt, r.settledTxid);
    }

    /// @notice Redemptions burnt but not yet recorded as paid.
    /// @dev O(n) and deliberately not cached: this is a view a stranger runs, not a path
    /// the issuer pays gas for, and a cached counter is one more number the issuer would
    /// be trusted to keep honest.
    function unsettledRedemptions() external view returns (uint256 count, uint256 amount) {
        for (uint256 i = 0; i < _redemptions.length; i++) {
            if (_redemptions[i].settledTxid == bytes32(0)) {
                count++;
                amount += _redemptions[i].amount;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────────
    // the issuer role
    // ─────────────────────────────────────────────────────────────────────────────────

    /// @notice Two-step, because §2's trap 2 is the estate's own scar: `feeToSetter` on a
    /// V2 factory is set in one call and can only be moved by the key that holds it, so
    /// one fat-fingered address is unrecoverable. Here the successor must call
    /// `acceptIssuer` from the address itself before it takes effect, which makes an
    /// address nobody holds a no-op instead of a disaster.
    function beginIssuerHandover(address next) external onlyIssuer {
        require(next != address(0), "ForgeReceipt: ZERO_ISSUER");
        pendingIssuer = next;
        emit IssuerHandoverBegun(msg.sender, next);
    }

    function acceptIssuer() external {
        require(msg.sender == pendingIssuer, "ForgeReceipt: NOT_PENDING_ISSUER");
        address from = issuer;
        issuer = pendingIssuer;
        pendingIssuer = address(0);
        emit IssuerChanged(from, issuer);
    }

    // ─────────────────────────────────────────────────────────────────────────────────
    // ERC-20 mechanics
    // ─────────────────────────────────────────────────────────────────────────────────

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
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= value;
        }
        _transfer(from, to, value);
        return true;
    }

    /// @dev Transfers to `address(0)` are refused rather than treated as a burn. Burning
    /// through `transfer` would move supply without a redemption record, which is exactly
    /// the accounting hole `redeem` exists to close.
    function _transfer(address from, address to, uint256 value) private {
        require(to != address(0), "ForgeReceipt: ZERO_RECIPIENT");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        require(deadline >= block.timestamp, "ForgeReceipt: EXPIRED");
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
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0) && recovered == owner, "ForgeReceipt: INVALID_SIGNATURE");
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }
}
