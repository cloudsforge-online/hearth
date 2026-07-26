# What & why

<!-- What does this change and why? Link any related issue. -->

## Type
- [ ] Bug fix
- [ ] Feature
- [ ] Docs
- [ ] Refactor / chore

## Checklist
- [ ] `node/`: `node test/unit.js && node test/e2e.js` pass
- [ ] `rust/hearthd/`: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` pass (if touched)
- [ ] `web/`: `node --check` on changed JS (if touched)
- [ ] Docs updated (README / docs/) if behavior changed
- [ ] No new third-party dependency in the Rust core (or clearly justified)

## Notes for reviewers
<!-- Anything to look at closely, trade-offs, follow-ups. -->
