#!/usr/bin/env bash
# Obtain the Ethereum reference test corpus.
#
# Two things live side by side (see node/test/conformance/README.md):
#
#   fixtures/   a small representative subset, COMMITTED, so `node
#               test/conformance/runner.js` works offline and CI has a fast gate.
#   vectors/    the full upstream corpus, GITIGNORED, fetched by this script.
#
# The corpus is split across two upstream repositories:
#
#   ethereum/tests        RLPTests, TrieTests            (branch: develop)
#   ethereum/legacytests  VMTests, GeneralStateTests     (branch: master)
#
# VMTests and GeneralStateTests were moved out of ethereum/tests into the
# `LegacyTests` submodule; ethereum/tests itself no longer carries them at the
# top level. Cloning ethereum/tests alone gets you RLP and trie vectors only.
#
# Usage:
#   ./scripts/fetch-vectors.sh              # the suites we gate on (~200 MB)
#   ./scripts/fetch-vectors.sh --full       # everything, including blockchain tests
#   ./scripts/fetch-vectors.sh --vendor     # re-download the committed fixtures/ subset
#   ./scripts/fetch-vectors.sh --clean      # remove vectors/
#   ./scripts/fetch-vectors.sh --check      # report what is present, fetch nothing

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$HERE/../test/conformance"
VECTORS="$CONF/vectors"
FIXTURES="$CONF/fixtures"

TESTS_REPO="https://github.com/ethereum/tests.git"
TESTS_REF="develop"
LEGACY_REPO="https://github.com/ethereum/legacytests.git"
LEGACY_REF="master"
LEGACY_RAW="https://raw.githubusercontent.com/ethereum/legacytests/$LEGACY_REF"
TESTS_RAW="https://raw.githubusercontent.com/ethereum/tests/$TESTS_REF"

# --- the vendored subset ------------------------------------------------------
# Kept deliberately small and deliberately diverse: every one of the four shapes,
# plus the awkward cases (deletes, secure keys, an expected exception, a fixture
# with no Shanghai post at all, and out-of-order transaction indexes).
# Paths are <upstream-repo>|<path-in-repo>|<path-under-fixtures>.
VENDORED=(
  # --- RLPTests: the complete published set; both files are tiny -------------
  "tests|RLPTests/rlptest.json|RLPTests/rlptest.json"
  "tests|RLPTests/invalidRLPTest.json|RLPTests/invalidRLPTest.json"

  # --- TrieTests: the complete published set, plain + secure, ordered + any ---
  "tests|TrieTests/trietest.json|TrieTests/trietest.json"
  "tests|TrieTests/trieanyorder.json|TrieTests/trieanyorder.json"
  "tests|TrieTests/trietest_secureTrie.json|TrieTests/trietest_secureTrie.json"
  "tests|TrieTests/trieanyorder_secureTrie.json|TrieTests/trieanyorder_secureTrie.json"
  "tests|TrieTests/hex_encoded_securetrie_test.json|TrieTests/hex_encoded_securetrie_test.json"
  # Not a root fixture at all — it asserts next/prev traversal. Vendored so the
  # loader's "skip a shape I do not understand, loudly" path stays covered.
  "tests|TrieTests/trietestnextprev.json|TrieTests/trietestnextprev.json"

  # --- VMTests: one or two per opcode family, incl. exception cases ----------
  "legacy|Constantinople/VMTests/vmArithmeticTest/add0.json|VMTests/vmArithmeticTest/add0.json"
  "legacy|Constantinople/VMTests/vmArithmeticTest/exp7.json|VMTests/vmArithmeticTest/exp7.json"
  "legacy|Constantinople/VMTests/vmArithmeticTest/mulUnderFlow.json|VMTests/vmArithmeticTest/mulUnderFlow.json"
  "legacy|Constantinople/VMTests/vmArithmeticTest/stop.json|VMTests/vmArithmeticTest/stop.json"
  "legacy|Constantinople/VMTests/vmBitwiseLogicOperation/and1.json|VMTests/vmBitwiseLogicOperation/and1.json"
  "legacy|Constantinople/VMTests/vmBitwiseLogicOperation/iszeo2.json|VMTests/vmBitwiseLogicOperation/iszeo2.json"
  "legacy|Constantinople/VMTests/vmPushDupSwapTest/push1.json|VMTests/vmPushDupSwapTest/push1.json"
  "legacy|Constantinople/VMTests/vmPushDupSwapTest/push32Undefined.json|VMTests/vmPushDupSwapTest/push32Undefined.json"
  "legacy|Constantinople/VMTests/vmPushDupSwapTest/dup2error.json|VMTests/vmPushDupSwapTest/dup2error.json"
  "legacy|Constantinople/VMTests/vmSha3Test/sha3_3.json|VMTests/vmSha3Test/sha3_3.json"
  "legacy|Constantinople/VMTests/vmLogTest/log0_logMemsizeTooHigh.json|VMTests/vmLogTest/log0_logMemsizeTooHigh.json"
  "legacy|Constantinople/VMTests/vmEnvironmentalInfo/caller.json|VMTests/vmEnvironmentalInfo/caller.json"
  "legacy|Constantinople/VMTests/vmEnvironmentalInfo/calldatacopyUnderFlow.json|VMTests/vmEnvironmentalInfo/calldatacopyUnderFlow.json"
  "legacy|Constantinople/VMTests/vmBlockInfoTest/number.json|VMTests/vmBlockInfoTest/number.json"
  "legacy|Constantinople/VMTests/vmBlockInfoTest/coinbase.json|VMTests/vmBlockInfoTest/coinbase.json"
  "legacy|Constantinople/VMTests/vmSystemOperations/return1.json|VMTests/vmSystemOperations/return1.json"
  "legacy|Constantinople/VMTests/vmSystemOperations/suicide0.json|VMTests/vmSystemOperations/suicide0.json"

  # --- GeneralStateTests -----------------------------------------------------
  "legacy|Cancun/GeneralStateTests/stExample/add11.json|GeneralStateTests/stExample/add11.json"
  "legacy|Cancun/GeneralStateTests/stExample/indexesOmitExample.json|GeneralStateTests/stExample/indexesOmitExample.json"
  "legacy|Cancun/GeneralStateTests/stExample/invalidTr.json|GeneralStateTests/stExample/invalidTr.json"
  "legacy|Cancun/GeneralStateTests/stLogTests/log0_emptyMem.json|GeneralStateTests/stLogTests/log0_emptyMem.json"
  "legacy|Cancun/GeneralStateTests/stChainId/chainId.json|GeneralStateTests/stChainId/chainId.json"
  "legacy|Cancun/GeneralStateTests/stRevertTest/RevertPrefoundEmpty.json|GeneralStateTests/stRevertTest/RevertPrefoundEmpty.json"
  "legacy|Cancun/GeneralStateTests/stCreateTest/CreateTransactionCallData.json|GeneralStateTests/stCreateTest/CreateTransactionCallData.json"
  "legacy|Cancun/GeneralStateTests/stTransactionTest/HighGasPrice.json|GeneralStateTests/stTransactionTest/HighGasPrice.json"
  # The only fixture in the whole corpus using retesteth's `0x:bigint 0x…`
  # escape, for a transaction value that will not fit in 256 bits.
  "legacy|Cancun/GeneralStateTests/stTransactionTest/ValueOverflowParis.json|GeneralStateTests/stTransactionTest/ValueOverflowParis.json"
  "legacy|Cancun/GeneralStateTests/stArgsZeroOneBalance/jumpNonConst.json|GeneralStateTests/stArgsZeroOneBalance/jumpNonConst.json"
  "legacy|Cancun/GeneralStateTests/stQuadraticComplexityTest/Create1000Shnghai.json|GeneralStateTests/stQuadraticComplexityTest/Create1000Shnghai.json"
  "legacy|Cancun/GeneralStateTests/Shanghai/stEIP3855-push0/push0Gas.json|GeneralStateTests/Shanghai/stEIP3855-push0/push0Gas.json"
  "legacy|Cancun/GeneralStateTests/Shanghai/stEIP3855-push0/push0Gas2.json|GeneralStateTests/Shanghai/stEIP3855-push0/push0Gas2.json"
  "legacy|Cancun/GeneralStateTests/stEIP2930/transactionCosts.json|GeneralStateTests/stEIP2930/transactionCosts.json"
)

log() { printf '  %s\n' "$*"; }
die() { printf 'fetch-vectors: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }

do_check() {
  echo "conformance corpus"
  if [ -d "$FIXTURES" ]; then
    log "fixtures/  $(find "$FIXTURES" -name '*.json' | wc -l | tr -d ' ') files, $(du -sh "$FIXTURES" | cut -f1)  (committed)"
  else
    log "fixtures/  MISSING"
  fi
  if [ -d "$VECTORS" ]; then
    log "vectors/   $(find "$VECTORS" -name '*.json' | wc -l | tr -d ' ') files, $(du -sh "$VECTORS" | cut -f1)  (gitignored)"
  else
    log "vectors/   not fetched — run ./scripts/fetch-vectors.sh"
  fi
}

do_clean() {
  rm -rf "$VECTORS"
  log "removed $VECTORS"
}

fetch_one() {
  local repo="$1" src="$2" dest="$3"
  local base
  case "$repo" in
    tests)  base="$TESTS_RAW" ;;
    legacy) base="$LEGACY_RAW" ;;
    *) die "unknown repo key '$repo'" ;;
  esac
  mkdir -p "$(dirname "$dest")"
  if ! curl -fsSL --retry 3 --max-time 60 -o "$dest.part" "$base/$src"; then
    rm -f "$dest.part"
    die "could not download $base/$src"
  fi
  # Refuse to write anything that is not valid JSON: a captive-portal HTML page
  # silently vendored as a fixture would be worse than no fixture at all.
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$dest.part" \
    || { rm -f "$dest.part"; die "$src did not download as valid JSON"; }
  mv "$dest.part" "$dest"
}

do_vendor() {
  need curl; need node
  echo "re-downloading the committed fixtures/ subset (${#VENDORED[@]} files)"
  for entry in "${VENDORED[@]}"; do
    IFS='|' read -r repo src dest <<<"$entry"
    fetch_one "$repo" "$src" "$FIXTURES/$dest"
    log "$dest"
  done
  echo
  log "done — review 'git diff' before committing; upstream does regenerate fixtures"
}

clone_sparse() {
  local repo="$1" ref="$2" dir="$3"; shift 3
  if [ -d "$dir/.git" ]; then
    log "updating $(basename "$dir")"
    git -C "$dir" fetch --depth=1 origin "$ref" >/dev/null 2>&1
    git -C "$dir" checkout -q FETCH_HEAD
    return
  fi
  git clone --depth=1 --filter=blob:none --sparse --branch "$ref" "$repo" "$dir"
  if [ "$#" -gt 0 ]; then
    git -C "$dir" sparse-checkout set "$@"
  else
    git -C "$dir" sparse-checkout disable
  fi
}

do_fetch() {
  need git
  local full="${1:-}"
  mkdir -p "$VECTORS"
  echo "fetching the reference corpus into $VECTORS"
  echo "(this directory is gitignored; the committed subset lives in fixtures/)"
  echo

  if [ -n "$full" ]; then
    clone_sparse "$TESTS_REPO" "$TESTS_REF" "$VECTORS/tests"
    clone_sparse "$LEGACY_REPO" "$LEGACY_REF" "$VECTORS/legacytests"
  else
    clone_sparse "$TESTS_REPO" "$TESTS_REF" "$VECTORS/tests" RLPTests TrieTests
    clone_sparse "$LEGACY_REPO" "$LEGACY_REF" "$VECTORS/legacytests" \
      Constantinople/VMTests Cancun/GeneralStateTests
  fi

  # The loader infers the suite from a path segment, so expose the four suite
  # roots directly under vectors/ with symlinks rather than copying ~200 MB.
  ln -sfn "$VECTORS/tests/RLPTests"                       "$VECTORS/RLPTests"
  ln -sfn "$VECTORS/tests/TrieTests"                      "$VECTORS/TrieTests"
  ln -sfn "$VECTORS/legacytests/Constantinople/VMTests"   "$VECTORS/VMTests"
  ln -sfn "$VECTORS/legacytests/Cancun/GeneralStateTests" "$VECTORS/GeneralStateTests"

  echo
  do_check
  echo
  log "run: node test/conformance/runner.js --impl=<your impl> --dir=test/conformance/vectors"
}

case "${1:-}" in
  --clean)  do_clean ;;
  --check)  do_check ;;
  --vendor) do_vendor ;;
  --full)   do_fetch full ;;
  ''|--default) do_fetch ;;
  --help|-h)
    sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *) die "unknown option $1 (try --help)" ;;
esac
