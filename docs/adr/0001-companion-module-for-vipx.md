# 0001. Control the Evertz VIP-X from Bitfocus Companion as a Companion module

- **Status:** accepted
- **Date:** 2025-09-22 (module code, 22e256e); the repo was created from the Companion module template on 2023-10-24 (9b70ef1)
- **Deciders:** Caleb
- **Backfilled:** yes, 2026-11-24, from the GitHub fork relationship (parent `bitfocus/companion-module-evertz-vipx`), `git log` (9b70ef1, d8f1572, 22e256e, acf1cf5), `companion/manifest.json`, `package.json`, `main.js`, `companion/HELP.md`
- **Related:** ADR 0002

## Context

Operators run Bitfocus Companion (Stream Deck control). The goal is VIP-X multiviewer control from it: "list & load snapshots, manage layouts/windows/inputs" (`package.json` description; `companion/manifest.json` description). This repo is a fork of `bitfocus/companion-module-evertz-vipx`, the Bitfocus-hosted repo for the module. Its first commit (9b70ef1, 2023-10-24) is the Bitfocus module template, and Bitfocus's bot added the "Companion Module Checks" workflow (d8f1572, 2024-12-19). Caleb's implementation is 22e256e and acf1cf5 (2025-09-22/23).

## Options considered

None recorded. Rationale not recorded at the time.

## Decision

The VIP-X control is a Companion module:
- `companion/manifest.json`: id `evertz-vipx`, runtime `node18` with the `nodejs-ipc` API, entrypoint `../main.js`, MIT licence, manufacturer Evertz.
- `package.json`: an ES module (`"type": "module"`) depending only on `@companion-module/base` ^1.13.2.
- `main.js` defines `EvertzVIPXInstance extends InstanceBase`, started with `runEntrypoint`. Actions, feedbacks, variables and upgrade scripts are in `actions.js`, `feedbacks.js`, `variables.js` and `upgrades.js`.

## Consequences

- The module runs inside Companion and follows Companion's module API and release process. `manifest.json`'s repository and bugs URLs point at the Bitfocus repo, which is where Companion publishes the module from.
- Only what the VIP-X control API exposes can be offered (ADR 0002). `companion/HELP.md` says saving snapshots is not possible from the module.
- `package-lock.json` is gitignored, so dependency resolution is not pinned beyond the `^1.13.2` range.
- `README.md` is still the template placeholder (`companion-module-[replace with module name]`); the user docs are in `companion/HELP.md`.
