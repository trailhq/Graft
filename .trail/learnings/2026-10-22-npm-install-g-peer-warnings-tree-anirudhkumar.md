---
title: "npm install -g peer warnings: tree-sitter-swift is vendored now"
author: Anirudhkumar-nanonets
date: 2026-10-22
branch: fix/tree-sitter-swift-peer
touches:
  - package-lock.json
  - package.json
  - src/graph/native.ts
  - test/graph-native-fallback.test.ts
  - scripts/vendor-grammars.mjs
  - test/package-peers.test.ts
---

## Decided
- `npm i -g` printed a 21-line "ERESOLVE overriding peer dependency" block: tree-sitter-swift 0.7.1 asks for tree-sitter ^0.22.1, we ship 0.21.1. The repo's `overrides` hid it locally; npm applies overrides only to the project it runs in, never to people installing the package.
- Fix: tree-sitter-swift is a devDependency. `npm run build` runs scripts/vendor-grammars.mjs, which copies its six prebuilt binaries, node-types.json and LICENSE into dist/vendor/tree-sitter-swift/. native.ts `requireGrammar` loads from there, and from node_modules when running from src/. A packed tarball's global install prints 0 npm warnings and is ~73 MB smaller (no tree-sitter-swift src, no tree-sitter-cli).
- test/package-peers.test.ts fails when any dependency's tree-sitter peer doesn't accept the tree-sitter we ship.

## Tried and ruled out
- tree-sitter 0.22: go, java, kotlin, php, r and typescript all peer ^0.21, and npm warns on mismatched optional peers too. A real global install went from 21 to 106-127 warning lines. kotlin's latest (0.3.8) still wants ^0.21.
- tree-sitter-swift 0.6.0 (peer ^0.21.1): its binding.gyp waits on a nested node_modules/tree-sitter-cli and fails to compile in a hoisted install.
- Publishing a fork with a wider peer range: needs @trailhq npm publish rights; vendoring needs none.
- Testing with `npm install --package-lock-only` into a root project: it doesn't print the peer warning. Only a real `npm i -g --prefix <scratch> <tarball>` reproduces it.

## Watch out
- On a platform with no Swift prebuild (Alpine/musl, FreeBSD), Swift files go to the WASM breadth tier, and the fallback notice names no package for Swift, since no install flag would help.
- To bump tree-sitter-swift: bump the devDependency, rebuild, and check the global install from a packed tarball.
- The funding line on `npm i -g` comes from dotenv's `funding` field; only the installer's own npm config can hide it.
