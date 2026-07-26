//! hearthd — Hearth production node core (CLI / benchmark).
//!
//! Thin binary over the `hearthd` library. Runs a self-check that exercises
//! every module (crypto, ledger, mempool, difficulty, P2P framing, Tab channels)
//! then benchmarks the Homefire proof-of-work.
//!
//! The JS `node/` client is the runnable reference for the full networked node
//! while this core grows to parity — see docs/why-two-implementations.md.

use hearthd::sha256::hex;
use hearthd::{crypto, difficulty, ledger, mempool, netmsg, pow, tab};
use std::collections::HashMap;
use std::io::Write;
use std::time::Instant;

fn self_check() {
    let e = ledger::SPARKS_PER_EMBER as f64;

    println!("core self-check");
    println!(
        "  emission ... @1 {:.4}  @5y {:.4}  tail {:.1} EMBER/blk",
        ledger::subsidy(1) as f64 / e,
        ledger::subsidy((5.0 * ledger::BLOCKS_PER_YEAR) as u64) as f64 / e,
        ledger::TAIL_EMBER
    );

    // crypto + ledger: coinbase to a real key, then a *signed* spend of it
    let miner = crypto::KeyPair::generate();
    println!("  crypto ..... key -> {} (checksummed) ✓", miner.address());
    let mut utxo: HashMap<String, ledger::TxOut> = HashMap::new();
    let cb = ledger::coinbase(1, &miner.address(), 0);
    ledger::apply(&cb, &mut utxo);
    println!(
        "  ledger ..... 1 coinbase -> supply {:.4} EMBER across {} utxo(s), commons split ✓",
        ledger::supply(&utxo) as f64 / e,
        utxo.len()
    );

    let mut spend = ledger::Tx {
        kind: ledger::TxKind::Normal,
        height: 2,
        inputs: vec![ledger::TxIn {
            txid: cb.id(),
            vout: 0,
            pubkey: miner.public().to_vec(),
            sig: vec![],
        }],
        outputs: vec![ledger::TxOut {
            address: crypto::KeyPair::generate().address(),
            amount: cb.outputs[0].amount - ledger::BASE_FEE_SPARKS,
        }],
    };
    let msg = spend.canonical();
    spend.inputs[0].sig = miner.sign(&msg).to_vec();
    match ledger::validate_normal(&spend, &utxo) {
        Ok(fee) => println!("  tx ......... signed spend valid, fee {fee} sparks (burned) ✓"),
        Err(err) => println!("  tx ......... unexpected reject: {err}"),
    }

    // mempool: admit the signed spend
    let mut mp = mempool::Mempool::new();
    let _ = mp.add(spend, &utxo);
    println!("  mempool .... {} tx admitted ✓", mp.len());

    // difficulty: fast blocks should raise the bits
    let nb = difficulty::next_bits(20, &[5, 5, 5, 5], 15, 8, 40);
    println!("  difficulty . 4 blocks @5s vs 15s target: 20 bits -> {nb} bits");

    // p2p: encode/parse a wire message
    let m = netmsg::Msg::Hello(1);
    println!(
        "  p2p ........ {:?} <-> \"{}\"  ✓",
        netmsg::Msg::parse(&m.encode()).unwrap(),
        m.encode()
    );

    // tab: open a channel and settle payments off-chain
    let (alice, bob) = (crypto::KeyPair::generate(), crypto::KeyPair::generate());
    let mut ch = tab::Channel::open(&alice, &bob, 100 * ledger::SPARKS_PER_EMBER, 0);
    ch.pay(&alice, 30 * ledger::SPARKS_PER_EMBER).unwrap();
    ch.pay(&bob, 10 * ledger::SPARKS_PER_EMBER).unwrap();
    let (a_bal, b_bal) = ch.balances();
    println!(
        "  tab ........ channel settled off-chain: alice {:.1} / bob {:.1} EMBER (nonce {}) ✓",
        a_bal as f64 / e,
        b_bal as f64 / e,
        ch.nonce()
    );
    println!();
}

fn main() {
    let target_bits: u32 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(12);

    self_check();

    println!("hearthd (rust core) — Homefire PoW");
    println!(
        "scratchpad {} KiB · {} walk steps · target {} leading zero bits\ntending the fire...\n",
        pow::SCRATCH_KIB,
        pow::WALK_STEPS,
        target_bits
    );

    // stand-in header; the full node commits prev hash, merkle root, height,
    // timestamp, difficulty and the coinbase key here.
    let header = b"HEARTH-rust-demo-header";

    let start = Instant::now();
    let mut nonce: u64 = 0;
    loop {
        let mut seed = Vec::with_capacity(header.len() + 8);
        seed.extend_from_slice(header);
        seed.extend_from_slice(&nonce.to_le_bytes());
        let digest = pow::homefire(&seed);

        if pow::meets(&digest, target_bits) {
            let secs = start.elapsed().as_secs_f64();
            println!("\n\nBLOCK FOUND");
            println!("  nonce ...... {nonce}");
            println!("  attempts ... {} in {:.2}s", nonce + 1, secs);
            println!("  hashrate ... {:.0} H/s", (nonce as f64 + 1.0) / secs);
            println!("  digest ..... {}", hex(&digest));
            break;
        }

        nonce += 1;
        if nonce.is_multiple_of(500) {
            let secs = start.elapsed().as_secs_f64();
            print!("\r  {nonce} attempts · {:.0} H/s   ", nonce as f64 / secs);
            std::io::stdout().flush().ok();
        }
    }
}
