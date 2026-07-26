# Security Policy

Hearth is money — security is the product.

## Reporting a vulnerability
**Please do not open a public issue for security problems.**

Report privately via GitHub's *Report a vulnerability* (Security → Advisories)
on this repository. Include:
- a description and impact,
- steps to reproduce (or a proof of concept),
- affected component (`node/`, `rust/hearthd/`, `web/`) and version/commit.

We aim to acknowledge within 72 hours and to coordinate a fix and disclosure
timeline with you. Once the network has a Commons treasury, a funded bug-bounty
program will reward valid consensus, cryptographic, and fund-loss reports.

## Scope of note
This repository is **pre-mainnet**. The Rust core keeps a deliberately small,
dependency-free trusted computing base; the production Homefire VM and consensus
still require independent audits before any launch (see
[docs/roadmap.md](docs/roadmap.md), Phase 5).

## Supported versions
Until mainnet, only `main` is supported.
