'use strict';
/* Conformance tests for legacy transactions. Zero-dependency mini harness.
 * Run: node test/transaction.js
 *
 * Every vector here came from somewhere else. Nothing in this file is a value
 * this implementation produced and was then declared correct, because a test
 * written that way passes for exactly as long as the bug survives.
 *
 *   MAINNET_TXS         the six transactions of Ethereum mainnet block
 *                       4,400,116, with the sender and hash the network agreed
 *                       on and the header's own transactionsRoot. One end-to-
 *                       end check over real bytes catches more encoding
 *                       mistakes at once than any amount of hand-built input:
 *                       an off-by-one in a scalar, a wrong signing hash, a
 *                       recovery-id mix-up and a mis-ordered field all show up
 *                       as the same loud mismatch.
 *   EIP155_EXAMPLE      the worked example from EIP-155 itself, including the
 *                       exact signed bytes, so RFC 6979 signing is pinned and
 *                       not merely round-tripped.
 *   MULTICALL3          the canonical presigned Multicall3 deployment — the
 *                       reason spec §3 requires pre-155 transactions at all.
 *   TT_VECTORS          53 cases lifted verbatim from ethereum/tests
 *                       TransactionTests (develop), covering all 30 Shanghai
 *                       result families, copied in so the suite is offline and
 *                       pinned exactly as test/trie.js does.
 *
 * If node/test/conformance/vectors/tests/TransactionTests exists — that is,
 * after scripts/fetch-vectors.sh — the FULL 212-case corpus is run as well.
 *
 * MUTATION-TESTED. Each of these was introduced in src/chain/transaction.js and
 * confirmed to drop the score, so the suite is known to be load-bearing rather
 * than merely green. Checks lost, out of 167:
 *
 *   signing v = recoveryId + chainId * 2 + 36            4
 *   decoding the chain id as (v - 36) >> 1              54
 *   accepting a leading-zero scalar                     14
 *   dropping the EIP-2 low-s check                       1
 *   signing over 6 fields even when protected           11
 *   rejecting unprotected (pre-155) transactions        24
 *   address = the FIRST 20 bytes of the keccak          19
 *   widening the nonce from 64 to 256 bits               1
 *   left-padding a short `to` instead of rejecting       3
 *   skipping the intrinsic-gas floor                     4
 *
 * The two that lose a single check are worth naming: both are rules that only
 * one input in the world distinguishes, and both were SURVIVORS until an
 * assertion was added for them — the nonce width until the rejection CODES
 * were pinned (2^64 and 2^64-1 are rejected by different rules and only the
 * code tells them apart), and low-s until the test proved the high-s twin
 * recovers to the same sender rather than merely failing.
 */

const fs = require('fs');
const path = require('path');

const T = require('../src/chain/transaction');
const RLP = require('../src/crypto/rlp');
const secp = require('../src/crypto/secp256k1');
const { keccak256 } = require('../src/crypto/keccak');
const { Trie, MemoryDB, EMPTY_TRIE_ROOT } = require('../src/state/trie');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
/* A group is a thunk so a throw is scored and the run continues; a decoder
 * that throws where it should return is exactly as wrong as one that returns
 * the wrong thing, and aborting would hide every check after the first. */
function group(name, fn) {
  console.log('• ' + name);
  try { fn(); } catch (e) { fail++; console.log(`  ✗ ${name}: threw — ${e.message}`); }
}
const hex = b => '0x' + Buffer.from(b).toString('hex');

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

const MAINNET_TXS = [
  { hash: '0x425c90832ef0a101b53a4800101726ddd8d7346a563aba78e846ddca8383d7f6',
    from: '0x678a4e4257aa2a5b2698b2b1f3db5799311a8872',
    nonce: '0x1d', gasPrice: '0x4e3b29200', gasLimit: '0x5dc0',
    to: '0x5c7d9be2a543202ea37a9c2f54141966c2f04c35', value: '0x470de4df820000',
    data: '0x',
    v: '0x26', r: '0x60c914db0fcb9f2e61f8d7821c83e3f2cd4fe97dfeaa81877a240a2a869da1f4', s: '0x68c837003c2427713a22188c858d33ddd74255e156048318143457cb88762301' },
  { hash: '0xbe85c837ac66a576d82aa09880e4cfe21256a4d94929d0a28ae5fa4678b843ee',
    from: '0xa1cd6183abd34b842b9515965213595e51b32bbd',
    nonce: '0x1', gasPrice: '0x4e3b29200', gasLimit: '0x91fc',
    to: '0x8f8221afbb33998d8584a2b05749ba73c37a938a', value: '0x0',
    data: '0xa9059cbb000000000000000000000000f8aa4529adb1b65fb6e6d5d90a0e226d9607ec2a00000000000000000000000000000000000000000000071b8ff2a10222540000',
    v: '0x25', r: '0x452237b7575445cc3fc239d998df820f9cdc19a62f0e39762649b228249ebb70', s: '0x3669eb73e8bc9df1c547c90ee440f4a70f199b8da723cdac5b9791e6d475310b' },
  { hash: '0x1660046964649b0e796422ce76c95837f0bf169cfe00e6b6033bda16166f13fb',
    from: '0x4bb96091ee9d802ed039c4d1a5f6216f90f81b01',
    nonce: '0x3f50c', gasPrice: '0x2540be400', gasLimit: '0xc350',
    to: '0xed9d5f1d604bfadde8ebd203db680c3b42d2493f', value: '0x2acde5ac90bc86d2',
    data: '0x',
    v: '0x25', r: '0x7269dac42a153759ab6a80664f95adccb62b84f5c2bdc7b6b39627dd0d3986f9', s: '0x2c7910ae4f526539c6f8f6e99bfe4e22187b66bcfdd89ab4925b69b0065d4f65' },
  { hash: '0x4e53998268400c072193a8f296b3c3213c08e5424d9fd3b8828c7f01cc88e726',
    from: '0x52bc44d5378309ee2abf1539bf71de1b7d7be3b5',
    nonce: '0x343b24', gasPrice: '0xee6b2800', gasLimit: '0xc350',
    to: '0x8f510f3b268a798f9840d68061a2baf15fd2ff58', value: '0x2c83df4a09190e0',
    data: '0x',
    v: '0x25', r: '0x26e69123827e222b95d25cec4c6678f12af405fcdc99a80a87907a0138cfbf18', s: '0x463f5c2b191649af6402b8fccc75e3da8f6db3c0dfb9e737246d1c1c0466c7fe' },
  { hash: '0x73df61746009bc4b41bee2882bef7bf9ac54544400e9200da6d545eec4e45b90',
    from: '0x52bc44d5378309ee2abf1539bf71de1b7d7be3b5',
    nonce: '0x343b25', gasPrice: '0xee6b2800', gasLimit: '0xc350',
    to: '0x2726f3c2043012b8162485b6475ecdbdfaea20a0', value: '0x2cefb4350858800',
    data: '0x',
    v: '0x25', r: '0x33e49dd0cec39ba5ecb70ef69940a3ccf2cf602db9ee876c6121eb01db4042ec', s: '0x2334f290746f5d82b9efbfc102e648657afcca2f6eee94bd44d3b2e1a99b7f33' },
  { hash: '0x815084af55e0b4757ff12c7b1cff924ec10097e77594841c8cd97b70b39b323c',
    from: '0x52bc44d5378309ee2abf1539bf71de1b7d7be3b5',
    nonce: '0x343b26', gasPrice: '0xee6b2800', gasLimit: '0xc350',
    to: '0x8e7c508164e36e9d89c3005bbfdea3c96e1e3ab2', value: '0x2d600b2828e9bc0',
    data: '0x',
    v: '0x26', r: '0xc9fdf3d646944c9e73111e2ce0df2d0b3b8fc8f4e631d5744219a406ff7d9723', s: '0x71734972b9b5ca66f932a1389fe21cf28ff96f9fd57e5e88756432e6090b0bb3' },
];
const MAINNET_TX_ROOT = '0x828c904499d8654ef218ef4a45d243667db0e06d64db825b8cd7fc7977c93a79';

const MULTICALL3_PRESIGNED =
'0x' +
  'f90f538085174876e800830f42408080b90f00608060405234801561001057600080fd5b50610ee08061002060003960' +
  '00f3fe6080604052600436106100f35760003560e01c80634d2301cc1161008a578063a8b0574e11610059578063a8b0' +
  '574e1461025a578063bce38bd714610275578063c3077fa914610288578063ee82ac5e1461029b57600080fd5b80634d' +
  '2301cc146101ec57806372425d9d1461022157806382ad56cb1461023457806386d516e81461024757600080fd5b8063' +
  '3408e470116100c65780633408e47014610191578063399542e9146101a45780633e64a696146101c657806342cbb15c' +
  '146101d957600080fd5b80630f28c97d146100f8578063174dea711461011a578063252dba421461013a57806327e86d' +
  '6e1461015b575b600080fd5b34801561010457600080fd5b50425b6040519081526020015b60405180910390f35b6101' +
  '2d610128366004610a85565b6102ba565b6040516101119190610bbe565b61014d610148366004610a85565b6104ef56' +
  '5b604051610111929190610bd8565b34801561016757600080fd5b50437fffffffffffffffffffffffffffffffffffff' +
  'ffffffffffffffffffffffffffff0140610107565b34801561019d57600080fd5b5046610107565b6101b76101b23660' +
  '04610c60565b610690565b60405161011193929190610cba565b3480156101d257600080fd5b5048610107565b348015' +
  '6101e557600080fd5b5043610107565b3480156101f857600080fd5b50610107610207366004610ce2565b73ffffffff' +
  'ffffffffffffffffffffffffffffffff163190565b34801561022d57600080fd5b5044610107565b61012d6102423660' +
  '04610a85565b6106ab565b34801561025357600080fd5b5045610107565b34801561026657600080fd5b506040514181' +
  '52602001610111565b61012d610283366004610c60565b61085a565b6101b7610296366004610a85565b610a1a565b34' +
  '80156102a757600080fd5b506101076102b6366004610d18565b4090565b60606000828067ffffffffffffffff811115' +
  '6102d8576102d8610d31565b60405190808252806020026020018201604052801561031e57816020015b604080518082' +
  '0190915260008152606060208201528152602001906001900390816102f65790505b5092503660005b82811015610477' +
  '57600085828151811061034157610341610d60565b6020026020010151905087878381811061035d5761035d610d6056' +
  '5b905060200281019061036f9190610d8f565b6040810135958601959093506103886020850185610ce2565b73ffffff' +
  'ffffffffffffffffffffffffffffffffff16816103ac6060870187610dcd565b6040516103ba929190610e32565b6000' +
  '6040518083038185875af1925050503d80600081146103f7576040519150601f19603f3d011682016040523d82523d60' +
  '00602084013e6103fc565b606091505b50602080850191909152901515808452908501351761046d577f08c379a00000' +
  '0000000000000000000000000000000000000000000000000000600052602060045260176024527f4d756c746963616c' +
  '6c333a2063616c6c206661696c656400000000000000000060445260846000fd5b5050600101610325565b5082341461' +
  '04e6576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152' +
  '601a60248201527f4d756c746963616c6c333a2076616c7565206d69736d617463680000000000006044820152606401' +
  '5b60405180910390fd5b50505092915050565b436060828067ffffffffffffffff81111561050c5761050c610d31565b' +
  '60405190808252806020026020018201604052801561053f57816020015b606081526020019060019003908161052a57' +
  '90505b5091503660005b8281101561068657600087878381811061056257610562610d60565b90506020028101906105' +
  '749190610e42565b92506105836020840184610ce2565b73ffffffffffffffffffffffffffffffffffffffff166105a6' +
  '6020850185610dcd565b6040516105b4929190610e32565b6000604051808303816000865af19150503d806000811461' +
  '05f1576040519150601f19603f3d011682016040523d82523d6000602084013e6105f6565b606091505b508684815181' +
  '1061060957610609610d60565b602090810291909101015290508061067d576040517f08c379a0000000000000000000' +
  '00000000000000000000000000000000000000815260206004820152601760248201527f4d756c746963616c6c333a20' +
  '63616c6c206661696c656400000000000000000060448201526064016104dd565b50600101610546565b505050925092' +
  '9050565b43804060606106a086868661085a565b905093509350939050565b6060818067ffffffffffffffff81111561' +
  '06c7576106c7610d31565b60405190808252806020026020018201604052801561070d57816020015b60408051808201' +
  '90915260008152606060208201528152602001906001900390816106e55790505b5091503660005b828110156104e657' +
  '600084828151811061073057610730610d60565b6020026020010151905086868381811061074c5761074c610d60565b' +
  '905060200281019061075e9190610e76565b925061076d6020840184610ce2565b73ffffffffffffffffffffffffffff' +
  'ffffffffffff166107906040850185610dcd565b60405161079e929190610e32565b6000604051808303816000865af1' +
  '9150503d80600081146107db576040519150601f19603f3d011682016040523d82523d6000602084013e6107e0565b60' +
  '6091505b506020808401919091529015158083529084013517610851577f08c379a00000000000000000000000000000' +
  '0000000000000000000000000000600052602060045260176024527f4d756c746963616c6c333a2063616c6c20666169' +
  '6c656400000000000000000060445260646000fd5b50600101610714565b6060818067ffffffffffffffff8111156108' +
  '7657610876610d31565b6040519080825280602002602001820160405280156108bc57816020015b6040805180820190' +
  '915260008152606060208201528152602001906001900390816108945790505b5091503660005b82811015610a105760' +
  '008482815181106108df576108df610d60565b602002602001015190508686838181106108fb576108fb610d60565b90' +
  '5060200281019061090d9190610e42565b925061091c6020840184610ce2565b73ffffffffffffffffffffffffffffff' +
  'ffffffffff1661093f6020850185610dcd565b60405161094d929190610e32565b6000604051808303816000865af191' +
  '50503d806000811461098a576040519150601f19603f3d011682016040523d82523d6000602084013e61098f565b6060' +
  '91505b506020830152151581528715610a07578051610a07576040517f08c379a0000000000000000000000000000000' +
  '00000000000000000000000000815260206004820152601760248201527f4d756c746963616c6c333a2063616c6c2066' +
  '61696c656400000000000000000060448201526064016104dd565b506001016108c3565b5050509392505050565b6000' +
  '806060610a2b60018686610690565b919790965090945092505050565b60008083601f840112610a4b57600080fd5b50' +
  '813567ffffffffffffffff811115610a6357600080fd5b6020830191508360208260051b8501011115610a7e57600080' +
  'fd5b9250929050565b60008060208385031215610a9857600080fd5b823567ffffffffffffffff811115610aaf576000' +
  '80fd5b610abb85828601610a39565b90969095509350505050565b6000815180845260005b81811015610aed57602081' +
  '850181015186830182015201610ad1565b81811115610aff576000602083870101525b50601f017fffffffffffffffff' +
  'ffffffffffffffffffffffffffffffffffffffffffffffe0169290920160200192915050565b60008282518085526020' +
  '8086019550808260051b84010181860160005b84811015610bb1578583037fffffffffffffffffffffffffffffffffff' +
  'ffffffffffffffffffffffffffffe001895281518051151584528401516040858501819052610b9d81860183610ac756' +
  '5b9a86019a9450505090830190600101610b4f565b5090979650505050505050565b602081526000610bd16020830184' +
  '610b32565b9392505050565b600060408201848352602060408185015281855180845260608601915060608160051b87' +
  '0101935082870160005b82811015610c52577fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' +
  'ffffa0888703018452610c40868351610ac7565b95509284019290840190600101610c06565b50939897505050505050' +
  '5050565b600080600060408486031215610c7557600080fd5b83358015158114610c8557600080fd5b92506020840135' +
  '67ffffffffffffffff811115610ca157600080fd5b610cad86828701610a39565b9497909650939450505050565b8381' +
  '52826020820152606060408201526000610cd96060830184610b32565b95945050505050565b60006020828403121561' +
  '0cf457600080fd5b813573ffffffffffffffffffffffffffffffffffffffff81168114610bd157600080fd5b60006020' +
  '8284031215610d2a57600080fd5b5035919050565b7f4e487b7100000000000000000000000000000000000000000000' +
  '000000000000600052604160045260246000fd5b7f4e487b710000000000000000000000000000000000000000000000' +
  '0000000000600052603260045260246000fd5b600082357fffffffffffffffffffffffffffffffffffffffffffffffff' +
  'ffffffffffffff81833603018112610dc357600080fd5b9190910192915050565b60008083357fffffffffffffffffff' +
  'ffffffffffffffffffffffffffffffffffffffffffffe1843603018112610e0257600080fd5b83018035915067ffffff' +
  'ffffffffff821115610e1d57600080fd5b602001915036819003821315610a7e57600080fd5b81838237600091019081' +
  '52919050565b600082357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc18336030181' +
  '12610dc357600080fd5b600082357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa183' +
  '3603018112610dc357600080fdfea2646970667358221220bb2b5c71a328032f97c676ae39a1ec2148d3e5d6f73d95e9' +
  'b17910152d61f16264736f6c634300080c00331ca0edce47092c0f398cebf3ffc267f05c8e7076e3b89445e0fe50f633' +
  '2273d4569ba01b0b9d000e19b24c5869b0fc3b22b0d6fa47cd63316875cbbd577d76e6fde086';
/* The presigned payload published at github.com/mds1/multicall. Deployed from
 * a made-up signature by an address nobody controls, which is why it lands at
 * 0xcA11… on every chain that will accept an unprotected transaction. */
const MULTICALL3_SENDER = '0x05f32b3cc3888453ff71b01135b34ff8e41263f2';
const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11';

/* EIP-155's own worked example. NOTE: the EIP publishes a signing hash of
 * "0xdaf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db3cc1408392",
 * which is 65 hex digits — a typo that has been in the document since 2016.
 * The signed transaction below is the authoritative half and is byte-exact, so
 * that is what is asserted; the hash is checked only through it. */
const EIP155_EXAMPLE = {
  privateKey: '0x4646464646464646464646464646464646464646464646464646464646464646',
  chainId: 1,
  tx: { nonce: 9, gasPrice: 20000000000n, gasLimit: 21000, value: 10n ** 18n, data: '0x',
        to: '0x3535353535353535353535353535353535353535' },
  signingData: '0xec098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080018080',
  signed: '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a7640000' +
          '8025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f76' +
          '1aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83',
  sender: '0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f',
};

/* ethereum/tests TransactionTests, `result.Shanghai`. `reject` names the
 * upstream TransactionException family; the assertion is that we reject, since
 * the exception TAXONOMY is retesteth's and not consensus — what is consensus
 * is accept-or-not, and for the accepted ones the hash, sender and intrinsic
 * gas. Vectors are run with chainId 1, the corpus's chain. */
const TT_VECTORS = [
  ["ttAddress/AddressMoreThan20",
   "0xf860800182520895b94f5374fce5edbc8e2a8697c15331677e6ebf0b1c0a801ca098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa08887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "ADDRESS_TOO_LONG" }],
  ["ttAddress/AddressMoreThan20PrefixedBy0",
   "0xf867367b8252089c0000000000000000095e7baea6a6c7c4c2dfeb977efac326af552d870b121ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a0efffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "ADDRESS_TOO_LONG" }],
  ["ttAddress/AddressLessThan20",
   "0xf8528001825208870b9331677e6ebf0a801ca098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa03887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "ADDRESS_TOO_SHORT" }],
  ["ttWrongRLP/RLPAddressWrongSize",
   "0xf866830ffdc50183adc05390fce5edbc8e2a8697c15331677e6ebf0b870ffdc5fffdc12c801ca098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa08887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "ADDRESS_TOO_SHORT" }],
  ["ttRSValue/TransactionWithRvalueHigh",
   "0xf85f800182520894095e7baea6a6c7c4c2dfeb977efac326af552d870b801ca0fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140a07778cde41a8a37f6a087622b38bc201a8e96bbed8c2907925d204da92411ee9e",
   { reject: "EC_RECOVERY_FAIL" }],
  ["ttSignature/PointAtInfinity",
   "0xf85f011082520894f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f001801ca06f0010ff4c31c2a6d0526c0d414e6cd01ad5d22e15bfff98af23867366b94d87a05413392d556119132da7056f8fb56a9138a36446a8a4ad7159c9d892d9f32284",
   { reject: "EC_RECOVERY_FAIL" }],
  ["ttGasLimit/TransactionWithGasLimitOverflow256",
   "0xf87e8001a101000000000000000000000000000000000000000000000000000000000000000094095e7baea6a6c7c4c2dfeb977efac326af552d870b801ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a0efffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "GASLIMIT_OVERFLOW" }],
  ["ttGasLimit/TransactionWithGasLimitOverflow64",
   "0xf86680018901000000000000000094095e7baea6a6c7c4c2dfeb977efac326af552d870b801ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a01fffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "GASLIMIT_OVERFLOW" }],
  ["ttGasLimit/TransactionWithGasLimitxPriceOverflow",
   "0xf87e80990100000000000000010000000000000001000000000000000288ffffffffffffffff94095e7baea6a6c7c4c2dfeb977efac326af552d8780801ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a01fffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "GASLIMIT_PRICE_PRODUCT_OVERFLOW" }],
  ["ttGasPrice/TransactionWithGasPriceOverflow",
   "0xf88080a101000000000000000000000000000000000000000000000000000000000000000082520894095e7baea6a6c7c4c2dfeb977efac326af552d870b801ca048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a010002cef538bc0c8e21c46080634a93f4d752bc9fe4b546b60ac055e842d342b",
   { reject: "GASPRICE_OVERFLOW" }],
  ["ttData/DataTestNotEnoughGAS",
   "0xf86d800182521c94095e7baea6a6c7c4c2dfeb977efac326af552d870a8e0358ac39584bc98a7c979f984b031ca048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a010002cef538bc0c8e21c46080634a93f4d752bc9fe4b546b60ac055e842d342b",
   { reject: "INTRINSIC_GAS_TOO_LOW" }],
  ["ttEIP2028/DataTestInsufficientGas2028",
   "0xf882800182540794095e7baea6a6c7c4c2dfeb977efac326af552d8780a3deadbeef0000000101010010101010101010101010101aaabbbbbbcccccccddddddddd1ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a01fffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "INTRINSIC_GAS_TOO_LOW" }],
  ["ttRSValue/RightVRSTestF0000000a",
   "0xf861030182c73894b94f5374fce5edbc8e2a8697c15331677e6ebf0b0a8082f028a098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa01887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "INVALID_CHAINID" }],
  ["ttRSValue/RightVRSTestF0000000b",
   "0xf861030182c73894b94f5374fce5edbc8e2a8697c15331677e6ebf0b0a8082f029a098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa01887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "INVALID_CHAINID" }],
  ["ttRSValue/TransactionWithRSvalue0",
   "0xdf800182520894095e7baea6a6c7c4c2dfeb977efac326af552d870b801b8080",
   { reject: "INVALID_SIGNATURE_VRS" }],
  ["ttRSValue/TransactionWithRvalue0",
   "0xf83f800182520894095e7baea6a6c7c4c2dfeb977efac326af552d870b801b80a0efffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "INVALID_SIGNATURE_VRS" }],
  ["ttNonce/TransactionWithHighNonce256",
   "0xf87fa0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0182520894095e7baea6a6c7c4c2dfeb977efac326af552d8780801ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a01fffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "NONCE_OVERFLOW" }],
  ["ttNonce/TransactionWithHighNonce64",
   "0xf868890100000000000000000182520894095e7baea6a6c7c4c2dfeb977efac326af552d8780801ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a01fffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "NONCE_OVERFLOW" }],
  ["ttNonce/TransactionWithHighNonce64Minus1",
   "0xf86788ffffffffffffffff0182520894095e7baea6a6c7c4c2dfeb977efac326af552d8780801ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a01fffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "NONCE_TOO_BIG" }],
  ["ttWrongRLP/RLPExtraRandomByteAtTheEnd",
   "0xf85280018207d0870b9331677e6ebf0a801ca098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa08887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a33ac4",
   { reject: "RLP_ERROR_SIZE" }],
  ["ttWrongRLP/RLPHeaderSizeOverflowInt32",
   "0xff0f0000000000005f030182520894b94f5374fce5edbc8e2a8697c15331677e6ebf0b0a801ca098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa08887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "RLP_ERROR_SIZE" }],
  ["ttWrongRLP/RLPListLengthWithFirstZeros",
   "0xf9005f030182520894b94f5374fce5edbc8e2a8697c15331677e6ebf0b0a801ca098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa08887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "RLP_ERROR_SIZE_LEADING_ZEROS" }],
  ["ttWrongRLP/TRANSCT_data_GivenAsList",
   "0xf86103018207d094b94f5374fce5edbc8e2a8697c15331677e6ebf0b0ac255441ca098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa08887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "RLP_INVALID_DATA" }],
  ["ttWrongRLP/RLPElementIsListWhenItShouldntBe",
   "0xf8698001cc83646f6783676f648363617494095e7baea6a6c7c4c2dfeb977efac326af552d870a801ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a0efffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "RLP_INVALID_GASLIMIT" }],
  ["ttWrongRLP/TRANSCT_gasLimit_GivenAsList",
   "0xf8610301c207d094b94f5374fce5edbc8e2a8697c15331677e6ebf0b0a8255441ca098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa08887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "RLP_INVALID_GASLIMIT" }],
  ["ttWrongRLP/RLPElementIsListWhenItShouldntBe2",
   "0xf86bcc83646f6783676f64836361740182035294095e7baea6a6c7c4c2dfeb977efac326af552d870a801ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a0efffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "RLP_INVALID_NONCE" }],
  ["ttWrongRLP/TRANSCT_rvalue_GivenAsList",
   "0xf86103018207d094b94f5374fce5edbc8e2a8697c15331677e6ebf0b0a8255441ce098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa08887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "RLP_INVALID_SIGNATURE_R" }],
  ["ttWrongRLP/TRANSCT_svalue_GivenAsList",
   "0xf86103018207d094b94f5374fce5edbc8e2a8697c15331677e6ebf0b0a8255441ca098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4ae08887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "RLP_INVALID_SIGNATURE_S" }],
  ["ttWrongRLP/TRANSCT_to_GivenAsList",
   "0xf86103018207d0d4b94f5374fce5edbc8e2a8697c15331677e6ebf0b0a8255441ca098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa08887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "RLP_INVALID_TO" }],
  ["ttWrongRLP/RLPArrayLengthWithFirstZeros",
   "0xf8a20301830186a094b94f5374fce5edbc8e2a8697c15331677e6ebf0b0ab90040ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff1ca098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa08887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "RLP_LEADING_ZEROS_DATA_SIZE" }],
  ["ttGasLimit/TransactionWithLeadingZerosGasLimit",
   "0xf85f800182000194095e7baea6a6c7c4c2dfeb977efac326af552d870b801ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a0efffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "RLP_LEADING_ZEROS_GASLIMIT" }],
  ["ttWrongRLP/RLPgasLimitWithFirstZeros",
   "0xf862800185000000094894095e7baea6a6c7c4c2dfeb977efac326af552d870a801ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a0efffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "RLP_LEADING_ZEROS_GASLIMIT" }],
  ["ttGasPrice/TransactionWithLeadingZerosGasPrice",
   "0xf8618082000182520894095e7baea6a6c7c4c2dfeb977efac326af552d8780801ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a01fffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "RLP_LEADING_ZEROS_GASPRICE" }],
  ["ttWrongRLP/RLPgasPriceWithFirstZeros",
   "0xf862808300000182035294095e7baea6a6c7c4c2dfeb977efac326af552d870a801ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a0efffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "RLP_LEADING_ZEROS_GASPRICE" }],
  ["ttNonce/TransactionWithLeadingZerosNonce",
   "0xf8618200010182520894095e7baea6a6c7c4c2dfeb977efac326af552d870b801ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a0efffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "RLP_LEADING_ZEROS_NONCE" }],
  ["ttNonce/TransactionWithZerosBigInt",
   "0xf85f000182520894095e7baea6a6c7c4c2dfeb977efac326af552d870b801ca048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a010002cef538bc0c8e21c46080634a93f4d752bc9fe4b546b60ac055e842d342b",
   { reject: "RLP_LEADING_ZEROS_NONCE" }],
  ["ttWrongRLP/RLPIncorrectByteEncoding00",
   "0xf86081000182520894b94f5374fce5edbc8e2a8697c15331677e6ebf0b0a801ca098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa08887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "RLP_LEADING_ZEROS_NONCE_SIZE" }],
  ["ttWrongRLP/RLPIncorrectByteEncoding01",
   "0xf86081010182520894b94f5374fce5edbc8e2a8697c15331677e6ebf0b0a801ca098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa08887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "RLP_LEADING_ZEROS_NONCE_SIZE" }],
  ["ttRSValue/TransactionWithRvaluePrefixed00BigInt",
   "0xf85f800182520894095e7baea6a6c7c4c2dfeb977efac326af552d870b801ba00000000000000000000000000000000ebaaedce6af48a03bbfd25e8cd0364141a01fffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "RLP_LEADING_ZEROS_R" }],
  ["ttWrongRLP/TRANSCT_rvalue_Prefixed0000",
   "0xf86303018207d094b94f5374fce5edbc8e2a8697c15331677e6ebf0b0a8255441ca2000098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa08887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "RLP_LEADING_ZEROS_R" }],
  ["ttRSValue/TransactionWithSvaluePrefixed00BigInt",
   "0xf85f800182520894095e7baea6a6c7c4c2dfeb977efac326af552d870b801ba098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa000000000000000000000000000000ef0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "RLP_LEADING_ZEROS_S" }],
  ["ttWrongRLP/TRANSCT_svalue_Prefixed0000",
   "0xf86303018207d094b94f5374fce5edbc8e2a8697c15331677e6ebf0b0a8255441ca098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa200008887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "RLP_LEADING_ZEROS_S" }],
  ["ttRSValue/RightVRSTestVPrefixedBy0",
   "0xf861030182c73894b94f5374fce5edbc8e2a8697c15331677e6ebf0b0a80820028a098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa01887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "RLP_LEADING_ZEROS_V" }],
  ["ttRSValue/RightVRSTestVPrefixedBy0_2",
   "0xf861030182c73894b94f5374fce5edbc8e2a8697c15331677e6ebf0b0a80820029a098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa01887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { reject: "RLP_LEADING_ZEROS_V" }],
  ["ttValue/TransactionWithLeadingZerosValue",
   "0xf861800182520894095e7baea6a6c7c4c2dfeb977efac326af552d87820001801ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a01fffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "RLP_LEADING_ZEROS_VALUE" }],
  ["ttWrongRLP/RLPValueWithFirstZeros",
   "0xf861800182035294095e7baea6a6c7c4c2dfeb977efac326af552d8782000a801ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a0efffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { reject: "RLP_LEADING_ZEROS_VALUE" }],
  ["ttAddress/AddressLessThan20Prefixed0",
   "0xf85f800182520894000000000000000000000000000b9331677e6ebf0a801ca098ff921201554726367d2be8c804a7ff89ccf285ebc57dff8ae4c44b9c19ac4aa01887321be575c8095f789dd4c743dfe42c1820f9231f98a962b210e3ac2452a3",
   { hash: "0x2781a1444a7a4a646bf551f90913054dc47b2f3493d4a82a057445eb9e1c98cf",
    sender: "0x2fbffb0b9f709fd1fa4db9ff7342f2e6b3b2b7a6", intrinsicGas: "0x5208" }],
  ["ttData/DataTestEnoughGAS",
   "0xf86d80018259d894095e7baea6a6c7c4c2dfeb977efac326af552d870a8e0358ac39584bc98a7c979f984b031ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a01fffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { hash: "0xba6950e1a9e03da3dc5a43587cb3eb538ed53f15acc9f5a3876417fe10935be6",
    sender: "0x1e42dc399dc122b1172fa3c3d9a9a0adabf7d026", intrinsicGas: "0x52e8" }],
  ["ttData/DataTestFirstZeroBytes",
   "0xf87c80018261a894095e7baea6a6c7c4c2dfeb977efac326af552d870a9d00000000000000000000000000010000000000000000000000000000001ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a01fffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { hash: "0x95f3e2568d38c188fb288570b588402ff37b8d0330eafc414df637d8003eea0d",
    sender: "0x67719a47cf3e3fe77b89c994d85395ad0f899d86", intrinsicGas: "0x5288" }],
  ["ttData/DataTestLastZeroBytes",
   "0xf87c80018261a894095e7baea6a6c7c4c2dfeb977efac326af552d870a9d01000000000000000000000000000000000000000000000000000000001ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a01fffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { hash: "0x47a86e3d0be8ff2a9868b973ef1b30b4fd1796bb26f6c6e4f92804d6db2db977",
    sender: "0x186f6d666993362b46b3b6c626f55903a439cc8d", intrinsicGas: "0x5288" }],
  ["ttData/DataTestZeroBytes",
   "0xf87c80018261a894095e7baea6a6c7c4c2dfeb977efac326af552d870a9d00000000000000000000000000000000000000000000000000000000001ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a01fffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { hash: "0xf418ca224c8fb22e767fe9814fb27c17ce9dc9eccd9d4973eb8deeb213fd7bf6",
    sender: "0x61adaba383a740078e3efbddf082be05534e5484", intrinsicGas: "0x527c" }],
  ["ttEIP2028/DataTestSufficientGas2028",
   "0xf882800182540894095e7baea6a6c7c4c2dfeb977efac326af552d8780a3deadbeef0000000101010010101010101010101010101aaabbbbbbcccccccddddddddd1ba048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a01fffd310ac743f371de3b9f7f9cb56c0b28ad43601b4ab949f53faa07bd2c804",
   { hash: "0x38e1de3a9f4deebd18c635848a9593e10e8cce5543277ddb985c4507694bec89",
    sender: "0xb42837109dfc0d8686bca0446112c8db63fdd40b", intrinsicGas: "0x5408" }],
  ["ttValue/TransactionWithHighValueOverflow",
   "0xf880800182520894095e7baea6a6c7c4c2dfeb977efac326af552d87a1010000000000000000000000000000000000000000000000000000000000000000801ca048b55bfa915ac795c431978d8a6a992b628d557da5ff759b307d495a36649353a010002cef538bc0c8e21c46080634a93f4d752bc9fe4b546b60ac055e842d342b",
   { reject: "VALUE_OVERFLOW" }],
];

// ---------------------------------------------------------------------------
// Real mainnet transactions, end to end
// ---------------------------------------------------------------------------

group('mainnet block 4,400,116 — six real transactions', () => {
  const encoded = [];
  for (const t of MAINNET_TXS) {
    const raw = T.encode({ nonce: t.nonce, gasPrice: t.gasPrice, gasLimit: t.gasLimit,
      to: t.to, value: t.value, data: t.data, v: t.v, r: t.r, s: t.s });
    encoded.push(raw);
    ok(hex(T.hash(raw)) === t.hash, `${t.hash}: re-encoding reproduces the network's tx hash`);

    const res = T.validate(raw, { chainId: 1 });
    ok(res.ok, `${t.hash}: accepted (${res.ok ? '' : res.code + ' ' + res.error})`);
    if (!res.ok) continue;
    ok(hex(res.sender) === t.from, `${t.hash}: recovers sender ${t.from}`);
    ok(res.tx.protected === true, `${t.hash}: EIP-155 protected`);
    ok(res.tx.chainId === 1, `${t.hash}: v encodes chain id 1`);
    ok(T.encode(res.tx).equals(raw), `${t.hash}: encode(decode(raw)) is byte-identical`);
  }

  /* The transactions trie is the same construction as the receipts trie:
   * non-secure, keyed by rlp(index). Checking it here means the six encodings
   * are pinned collectively as well as individually. */
  const trie = new Trie(new MemoryDB(), EMPTY_TRIE_ROOT, { secure: false });
  encoded.forEach((enc, i) => trie.put(RLP.encode(i), enc));
  ok(hex(trie.root()) === MAINNET_TX_ROOT, 'the six encodings produce the header transactionsRoot');
});

group('EIP-155 worked example', () => {
  const e = EIP155_EXAMPLE;
  const t = T.normalize(e.tx);
  const signData = RLP.encode([t.nonce, t.gasPrice, t.gasLimit, t.to, t.value, t.data, 1n, 0, 0]);
  ok(hex(signData) === e.signingData, 'the signing payload matches the EIP byte for byte');
  ok(hex(T.signingHash(t, 1)) === hex(keccak256(signData)), 'signingHash is keccak over that payload');

  const signed = T.sign(e.tx, e.privateKey, { chainId: e.chainId });
  ok(hex(T.encode(signed)) === e.signed, 'deterministic signing reproduces the published signed transaction');
  ok(signed.v === 37n, 'v = recoveryId(0) + 1 * 2 + 35 = 37');
  ok(hex(T.recoverSender(signed)) === e.sender, 'recovers the published sender');

  const res = T.validate(e.signed, { chainId: 1 });
  ok(res.ok && hex(res.sender) === e.sender, 'and the same through validate()');
});

// ---------------------------------------------------------------------------
// Multicall3 — the reason pre-155 must be accepted (spec §3)
// ---------------------------------------------------------------------------

group('Multicall3 canonical presigned deployment', () => {
  for (const chainId of [1, T.CHAIN_ID]) {
    const res = T.validate(MULTICALL3_PRESIGNED, { chainId, maxBytes: 0 });
    ok(res.ok, `accepted under chain id ${chainId}${res.ok ? '' : ' — ' + res.code}`);
    if (!res.ok) continue;
    ok(res.tx.protected === false && res.tx.v === 28n, `chain id ${chainId}: unprotected, v = 28`);
    ok(hex(res.sender) === MULTICALL3_SENDER, `chain id ${chainId}: sender is the keyless deployer`);
    ok(res.tx.nonce === 0n && res.tx.to === null, `chain id ${chainId}: nonce 0 creation`);
    ok(hex(T.contractAddress(res.sender, res.tx.nonce)) === MULTICALL3_ADDRESS,
      `chain id ${chainId}: lands at ${MULTICALL3_ADDRESS}`);
  }
  /* Chain-independence IS the property. If the two runs above ever disagree,
   * the address moves and every front-end that hard-codes it breaks. */
  const a = T.validate(MULTICALL3_PRESIGNED, { chainId: 1, maxBytes: 0 });
  const b = T.validate(MULTICALL3_PRESIGNED, { chainId: T.CHAIN_ID, maxBytes: 0 });
  ok(a.ok && b.ok && a.hash.equals(b.hash) && a.sender.equals(b.sender),
    'the hash and sender do not depend on the chain id');
});

// ---------------------------------------------------------------------------
// ethereum/tests TransactionTests
// ---------------------------------------------------------------------------

/** One TransactionTests case. Returns true when it behaved as published. */
function runTT(name, txbytes, want) {
  const res = T.validate(txbytes, { chainId: 1, maxBytes: 0 });
  if (want.reject) {
    ok(!res.ok, `${name}: must be rejected (${want.reject})`);
    return !res.ok;
  }
  if (!res.ok) { ok(false, `${name}: must be accepted, got ${res.code} — ${res.error}`); return false; }
  const good = hex(res.hash) === want.hash
    && hex(res.sender) === want.sender
    && res.intrinsicGas === BigInt(want.intrinsicGas)
    && hex(T.encode(res.tx)) === txbytes.toLowerCase();
  ok(good, `${name}: hash/sender/intrinsicGas/round-trip (got ${hex(res.hash)} ${hex(res.sender)} ${res.intrinsicGas})`);
  return good;
}

group(`TransactionTests — ${TT_VECTORS.length} vendored cases`, () => {
  for (const [name, txbytes, want] of TT_VECTORS) runTT(name, txbytes, want);
});

/* The full corpus, when scripts/fetch-vectors.sh has been run. Typed
 * (EIP-2718) transactions are counted and skipped rather than dropped: v1 is
 * legacy-only by decision (spec §3), not by accident. */
group('TransactionTests — full corpus (if fetched)', () => {
  const root = path.join(__dirname, 'conformance/vectors/tests/TransactionTests');
  if (!fs.existsSync(root)) {
    console.log('    (not fetched — run scripts/fetch-vectors.sh for the full 212 cases)');
    return;
  }
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.json')) files.push(p);
    }
  }(root));

  let ran = 0, good = 0, typed = 0, noFork = 0;
  for (const f of files) {
    const json = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const [caseName, body] of Object.entries(json)) {
      if (caseName === '_info') continue;
      const want = (body.result || {}).Shanghai;
      if (!want) { noFork++; continue; }
      const txbytes = body.txbytes || '0x';
      if (parseInt(txbytes.slice(2, 4), 16) < 0xc0) { typed++; continue; }
      const name = path.relative(root, f).replace(/\.json$/, '') + '::' + caseName;
      ran++;
      if (want.exception) {
        const res = T.validate(txbytes, { chainId: 1, maxBytes: 0 });
        if (res.ok) console.log(`  ✗ ${name}: must be rejected (${want.exception})`);
        else good++;
      } else {
        const res = T.validate(txbytes, { chainId: 1, maxBytes: 0 });
        if (res.ok && hex(res.hash) === want.hash && hex(res.sender) === want.sender
          && res.intrinsicGas === BigInt(want.intrinsicGas)
          && hex(T.encode(res.tx)) === txbytes.toLowerCase()) good++;
        else console.log(`  ✗ ${name}: ${res.ok ? 'wrong hash/sender/gas' : res.code + ' — ' + res.error}`);
      }
    }
  }
  console.log(`    ${good}/${ran} corpus cases, ${typed} typed (EIP-2718) skipped, ${noFork} with no Shanghai result`);
  ok(ran > 100, `the corpus ran (${ran} legacy cases)`);
  ok(good === ran, `every corpus case behaved as published (${good}/${ran})`);
});

// ---------------------------------------------------------------------------
// Scalar canonicality — the rule that has no other home (spec §5)
// ---------------------------------------------------------------------------

group('scalar canonicality', () => {
  /* Start from a transaction we know is valid, then re-encode ONE field with a
   * leading zero byte. Everything else is untouched, so a rejection can only
   * be about canonicality. `0x00` and `0x0001` are both non-minimal; the empty
   * string is the canonical zero and must stay valid. */
  const base = T.decode(EIP155_EXAMPLE.signed, { chainId: 1 });
  const FIELDS = ['nonce', 'gasPrice', 'gasLimit', 'value', 'v', 'r', 's'];
  const raw = () => [base.nonce, base.gasPrice, base.gasLimit, base.to, base.value, base.data,
    base.v, base.r, base.s].map(x => (Buffer.isBuffer(x) ? x : RLP.intToBytes(x)));
  const idx = { nonce: 0, gasPrice: 1, gasLimit: 2, value: 4, v: 6, r: 7, s: 8 };

  ok(T.validate(RLP.encode(raw()), { chainId: 1 }).ok, 'the unmutated control is accepted');

  for (const f of FIELDS) {
    const items = raw();
    items[idx[f]] = Buffer.concat([Buffer.from([0]), items[idx[f]]]);
    const res = T.validate(RLP.encode(items), { chainId: 1 });
    ok(!res.ok && res.code === `RLP_LEADING_ZEROS_${f.toUpperCase()}`,
      `a leading zero on ${f} is rejected (got ${res.ok ? 'accepted' : res.code})`);
  }

  /* Zero itself, on a transaction that genuinely carries one. */
  {
    const zero = T.sign({ nonce: 0, gasPrice: 1, gasLimit: 21000, to: '0x' + '11'.repeat(20), value: 0, data: '0x' },
      '0x' + '5a'.repeat(32), { chainId: T.CHAIN_ID });
    const items = RLP.decode(T.encode(zero));
    ok(items[4].length === 0, 'zero encodes as the empty string, not as 0x00');
    ok(T.validate(RLP.encode(items), { chainId: T.CHAIN_ID }).ok, 'and a zero-value transaction is accepted');
    items[4] = Buffer.from([0]);
    ok(!T.validate(RLP.encode(items), { chainId: T.CHAIN_ID }).ok, '0x00 is not a valid encoding of zero');
  }

  /* The consequence, stated directly: one transaction, one encoding. */
  ok(T.encode(base).equals(Buffer.from(EIP155_EXAMPLE.signed.slice(2), 'hex')),
    'encode(decode(raw)) === raw, so a transaction has exactly one encoding');
});

group('field bounds', () => {
  const sign = (over) => {
    const t = T.sign({ nonce: 1, gasPrice: 1, gasLimit: 30000, to: '0x' + '11'.repeat(20), value: 0, data: '0x', ...over },
      '0x' + '02'.repeat(32), { chainId: T.CHAIN_ID });
    return T.encode(t);
  };
  /* Signed with valid fields, then one field is swapped for an out-of-range
   * one. The signature is then meaningless, but the bound must be checked
   * before anything so expensive as recovery is attempted — hence asserting
   * the CODE and not merely the rejection. The codes matter for their own
   * sake too: two of these bounds sit a single value apart and only the code
   * distinguishes "wider than 64 bits" from "the largest 64-bit value". */
  const bad = (fields, code, why) => {
    const items = RLP.decode(sign({}));
    for (const [i, v] of Object.entries(fields)) items[Number(i)] = v;
    const res = T.validate(RLP.encode(items), { chainId: T.CHAIN_ID });
    ok(!res.ok && res.code === code, `${why} (expected ${code}, got ${res.ok ? 'accepted' : res.code})`);
  };
  const be = (n, len) => { const b = Buffer.alloc(len); let v = n; for (let i = len - 1; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };

  bad({ 0: be(1n << 64n, 9) }, 'NONCE_OVERFLOW', 'a nonce of 2^64 is wider than the field');
  bad({ 0: be(T.MAX_UINT64, 8) }, 'NONCE_TOO_BIG', 'a nonce of 2^64-1 fits but could never advance the account past it');
  bad({ 2: be(1n << 64n, 9) }, 'GASLIMIT_OVERFLOW', 'a gasLimit of 2^64 is rejected');
  bad({ 1: be(1n << 256n, 33) }, 'GASPRICE_OVERFLOW', 'a gasPrice of 2^256 is rejected');
  bad({ 4: be(1n << 256n, 33) }, 'VALUE_OVERFLOW', 'a value of 2^256 is rejected');
  bad({ 1: be(1n << 200n, 26), 2: be(1n << 60n, 8) }, 'GASLIMIT_PRICE_PRODUCT_OVERFLOW', 'a maximum fee over 256 bits is rejected');
  bad({ 3: Buffer.alloc(19, 0x11) }, 'ADDRESS_TOO_SHORT', 'a 19-byte `to` is rejected, not left-padded');
  bad({ 3: Buffer.alloc(21, 0x11) }, 'ADDRESS_TOO_LONG', 'a 21-byte `to` is rejected');
  bad({ 7: Buffer.alloc(0) }, 'INVALID_SIGNATURE_VRS', 'r = 0 is rejected');
  bad({ 8: Buffer.alloc(0) }, 'INVALID_SIGNATURE_VRS', 's = 0 is rejected');
  bad({ 7: be(secp.N, 32) }, 'INVALID_SIGNATURE_VRS', 'r = n is rejected');
  bad({ 8: be(secp.N, 32) }, 'INVALID_SIGNATURE_VRS', 's = n is rejected');
  /* 2^64-2 is the largest usable nonce, and it must still work — a bound that
   * is one too tight rejects nothing anyone would notice for a long time. */
  {
    const items = RLP.decode(sign({}));
    items[0] = be(T.MAX_UINT64 - 1n, 8);
    ok(T.validate(RLP.encode(items), { chainId: T.CHAIN_ID }).ok, 'a nonce of 2^64-2 is still accepted');
  }

  /* EIP-2. (r, n-s) verifies over the same message, so a chain accepting both
   * gives every transaction two hashes. The ecrecover PRECOMPILE must not do
   * this — see the note in secp256k1.js — which is why it lives here and not
   * in the curve code. */
  {
    const items = RLP.decode(sign({}));
    const s = BigInt('0x' + items[8].toString('hex'));
    const v = BigInt('0x' + items[6].toString('hex'));
    const base = BigInt(T.CHAIN_ID) * 2n + 35n;
    items[8] = be(secp.N - s, 32);
    items[6] = RLP.intToBytes(base + ((v - base) ^ 1n));   // negating s reflects R, flipping the recovery bit
    const high = T.validate(RLP.encode(items), { chainId: T.CHAIN_ID });
    ok(!high.ok && high.code === 'INVALID_SIGNATURE_VRS', 'the high-s twin of a valid signature is rejected (EIP-2)');

    /* The twin recovers to the SAME sender — which is exactly why it has to be
     * refused rather than tolerated. It is not a broken signature; it is a
     * second, equally valid one, and accepting it would give one transaction
     * two hashes. Proved by flipping back and watching it become valid again,
     * so the rejection above is demonstrably about `s` and nothing else. */
    items[8] = be(s, 32);
    items[6] = RLP.intToBytes(v);
    const low = T.validate(RLP.encode(items), { chainId: T.CHAIN_ID });
    ok(low.ok, 'flipping s back to its low form makes the same transaction valid');
    ok(low.ok && !low.hash.equals(keccak256(RLP.encode([...items.slice(0, 8), be(secp.N - s, 32)]))),
      'the two forms would hash differently — hence one encoding, one signature');
  }

  /* A list where a scalar belongs. RLP cannot object — both are legal RLP. */
  {
    const items = RLP.decode(sign({}));
    items[0] = [];
    ok(!T.validate(RLP.encode(items), { chainId: T.CHAIN_ID }).ok, 'a list in place of the nonce is rejected');
  }
  ok(!T.validate(RLP.encode([1, 2, 3]), { chainId: T.CHAIN_ID }).ok, 'a 3-item list is not a transaction');
  ok(!T.validate(RLP.encode(Buffer.from('hello')), { chainId: T.CHAIN_ID }).ok, 'a byte string is not a transaction');
  ok(!T.validate('0x02f8', { chainId: T.CHAIN_ID }).ok, 'a typed (EIP-2718) envelope is refused by a legacy-only chain');
});

// ---------------------------------------------------------------------------
// EIP-155 on the Hearth chain id
// ---------------------------------------------------------------------------

group('EIP-155 on chain id ' + T.CHAIN_ID, () => {
  const key = '0x' + '4d'.repeat(32);
  const pub = secp.publicKeyFromPrivate(key);
  const me = hex(T.addressFromPublicKey(pub));
  const base = { nonce: 3, gasPrice: 1000000000n, gasLimit: 90000, to: '0x' + 'ab'.repeat(20), value: 12345n, data: '0xc0ffee' };

  const p = T.sign(base, key, { chainId: T.CHAIN_ID });
  ok(p.v === BigInt(T.CHAIN_ID) * 2n + 35n || p.v === BigInt(T.CHAIN_ID) * 2n + 36n,
    `v is ${T.CHAIN_ID}*2+35 or +36 (got ${p.v})`);
  ok(p.v - BigInt(T.CHAIN_ID) * 2n - 35n === BigInt(p.recoveryId), 'v carries the recovery id in its low bit');
  ok(hex(T.recoverSender(p)) === me, 'protected: recovers the signer');
  ok(T.decode(T.encode(p), { chainId: T.CHAIN_ID }).chainId === T.CHAIN_ID, 'protected: v decodes back to the chain id');

  const u = T.sign(base, key, { chainId: null });
  ok(u.v === 27n || u.v === 28n, `unprotected: v is 27 or 28 (got ${u.v})`);
  ok(hex(T.recoverSender(u)) === me, 'unprotected: recovers the same signer');
  ok(T.decode(T.encode(u), { chainId: T.CHAIN_ID }).protected === false, 'unprotected: accepted on this chain');

  /* Replay protection is the point of EIP-155, so it has to be checked and not
   * assumed: the same transaction signed for chain 1 must not be valid here. */
  const elsewhere = T.sign(base, key, { chainId: 1 });
  const res = T.validate(T.encode(elsewhere), { chainId: T.CHAIN_ID });
  ok(!res.ok && res.code === 'INVALID_CHAINID', 'a transaction signed for chain 1 is refused here');
  ok(T.validate(T.encode(elsewhere), { chainId: 1 }).ok, '…and is valid on chain 1');
  ok(!T.encode(p).equals(T.encode(elsewhere)), 'the two chains produce different bytes');

  /* The signing hash must differ in the list LENGTH too, not just the values,
   * so a protected payload can never be read as an unprotected one. */
  const t = T.normalize(base);
  ok(RLP.decode(RLP.encode([t.nonce, t.gasPrice, t.gasLimit, t.to, t.value, t.data])).length === 6, 'unprotected signs 6 fields');
  ok(!T.signingHash(t, T.CHAIN_ID).equals(T.signingHash(t, null)), 'the two signing hashes differ');
});

// ---------------------------------------------------------------------------
// Creation addresses and intrinsic gas
// ---------------------------------------------------------------------------

group('contract addresses', () => {
  /* keccak256(rlp([sender, nonce]))[12:]. The zero-address vectors are the
   * ones every client's test suite carries; the Multicall3 case above is the
   * one that matters in production. */
  const zero = '0x' + '00'.repeat(20);
  ok(hex(T.contractAddress(zero, 0)) === '0xbd770416a3345f91e4b34576cb804a576fa48eb1', 'zero address, nonce 0');
  ok(hex(T.contractAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 0)) === '0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d', 'known vector, nonce 0');
  ok(hex(T.contractAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 1)) === '0x343c43a37d37dff08ae8c4a11544c718abb4fcf8', 'known vector, nonce 1');
  /* Nonce 0 is rlp-encoded as the empty string, not as 0x00 — the same
   * canonicality rule, and getting it wrong moves every first deployment. */
  ok(RLP.encode([Buffer.alloc(20), 0n]).equals(RLP.encode([Buffer.alloc(20), Buffer.alloc(0)])), 'nonce 0 encodes as empty');
});

group('intrinsic gas', () => {
  const call = d => T.intrinsicGas({ nonce: 0, gasPrice: 0, gasLimit: 0, to: '0x' + '11'.repeat(20), value: 0, data: d });
  ok(call('0x') === 21000n, 'a bare transfer costs 21000');
  ok(call('0x00') === 21004n, 'a zero data byte costs 4');
  ok(call('0xff') === 21016n, 'a non-zero data byte costs 16 (EIP-2028)');
  const create = d => T.intrinsicGas({ nonce: 0, gasPrice: 0, gasLimit: 0, to: null, value: 0, data: d });
  ok(create('0x') === 53000n, 'a creation costs 21000 + 32000');
  /* EIP-3860: 2 gas per 32-byte word of initcode, on top of everything else.
   * 32 non-zero bytes = 1 word = 2 gas, plus 32*16 for the bytes. */
  ok(create('0x' + 'ff'.repeat(32)) === 53000n + 512n + 2n, 'plus the EIP-3860 initcode word cost');

  const key = '0x' + '77'.repeat(32);
  const tooLow = T.sign({ nonce: 0, gasPrice: 1, gasLimit: 20999, to: '0x' + '11'.repeat(20), value: 0, data: '0x' }, key, { chainId: T.CHAIN_ID });
  ok(T.validate(T.encode(tooLow), { chainId: T.CHAIN_ID }).code === 'INTRINSIC_GAS_TOO_LOW', 'a gasLimit below intrinsic is rejected');

  /* The EIP-3860 initcode cap: 49152 bytes is the most a creation may carry. */
  const at = n => T.encode(T.sign({ nonce: 0, gasPrice: 1, gasLimit: 30000000, to: null, value: 0, data: Buffer.alloc(n) }, key, { chainId: T.CHAIN_ID }));
  ok(T.validate(at(49152), { chainId: T.CHAIN_ID, maxBytes: 0 }).ok, '49152 bytes of initcode is allowed');
  ok(T.validate(at(49153), { chainId: T.CHAIN_ID, maxBytes: 0 }).code === 'INITCODE_SIZE_EXCEEDED', '49153 bytes is not');
});

group('policy limits', () => {
  /* MAX_TX_BYTES is Hearth policy (spec §3), not an Ethereum consensus rule —
   * which is why the corpus above runs with the cap disabled and why
   * ttData/String10MbData is a valid transaction upstream and too big here. */
  const key = '0x' + '31'.repeat(32);
  const big = T.encode(T.sign({ nonce: 0, gasPrice: 1, gasLimit: 30000000, to: '0x' + '11'.repeat(20), value: 0, data: Buffer.alloc(120000) }, key, { chainId: T.CHAIN_ID }));
  ok(T.validate(big, { chainId: T.CHAIN_ID }).code === 'TX_TOO_LARGE', 'a 120 KB transaction is over MAX_TX_BYTES');
  ok(T.validate(big, { chainId: T.CHAIN_ID, maxBytes: 0 }).ok, '…and is otherwise a perfectly valid transaction');
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} checks`);
process.exit(fail === 0 ? 0 : 1);
