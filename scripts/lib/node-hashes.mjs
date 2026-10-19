// SHA-256 of the official Node.js release files the desktop app is built on (scripts/package.mjs),
// copied from each release's SHASUMS256.txt after checking that file's signature against the
// Node.js release keys (https://github.com/nodejs/release-keys):
//   gpgv --keyring release-keys/gpg/pubring.kbx SHASUMS256.txt.sig SHASUMS256.txt
// For these versions a download (from nodejs.org or LYREN_NODE_MIRROR) and the cached copy are
// checked against these values only, so a mirror or the cache is merely a transport. Add the
// version in .nvmrc here when it changes (a test checks it): releases are built with that version
// and LYREN_NODE_PINNED_ONLY=1 (.github/workflows/release.yml). Other versions fall back to
// SHASUMS256.txt fetched from https://nodejs.org (see node-dist.mjs).
//
// v24.19.0: SHASUMS256.txt signed by 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356 (a Node.js release key, as listed
// in the README of github.com/nodejs/node).

export const PINNED_SHA256 = {
  'v24.19.0': {
    'win-x64/node.exe': '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237',
    'win-arm64/node.exe': '3958e4bb3f2d4ef37c938215dfc65a9d3c9d839b5060fec103bd2345fa78e951',
    'node-v24.19.0-linux-x64.tar.gz': 'f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4',
    'node-v24.19.0-linux-arm64.tar.gz': 'd28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f',
  },
};
