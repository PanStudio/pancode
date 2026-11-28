# PanHub signing keys

`signing.json` is the key certificate: an envelope of type `pancode.hub.keys.v1` that lists the CI signing keys allowed to sign the PanHub index, each with a validity window, and the key ids it revokes. A higher `sequence` replaces a lower one, so a newer certificate can revoke a key.

The certificate is signed by the PanHub root key. The root private key is held offline by the maintainer; its public half is compiled into PanCode (`src/domains/resources/hub-keys.ts`). The maintainer issues certificates with `node scripts/hub-root.mjs certify`.

When the repository variable `HUB_SIGNING` is `on`, CI (`.github/workflows/hub-index.yml`) signs each index change with a certified key and publishes `index.yaml`, `index.envelope.json` and this certificate as assets of the `hub-index` release.

To verify a certificate: `node scripts/hub-root.mjs verify --certificate hub/keys/signing.json`.

To verify a published index: `node scripts/hub-sign.mjs verify --envelope index.envelope.json --index hub/index.yaml --certificate hub/keys/signing.json`. Without `--root-pub`, both use the root keys compiled into PanCode.
