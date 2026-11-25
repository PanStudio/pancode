# PanHub listing terms

These terms say what a PanHub listing promises, which licenses a listed pack may carry, what a pack owner agrees to,
and how a listing is taken down or a pack revoked. They apply to every community listing in PanHub and to the
first-party packs that ship with PanCode.

## What a listing is

A listing is a short record that points PanCode at a pack in its owner's own public repository: the repository, one
exact commit, the directory inside it, and a cryptographic digest of that directory's contents.

- **Pinned, after the owner pushed it.** A listing names a commit that its owner has already pushed to the public
  repository it names. PanHub never lists a branch, a tag or an unpublished commit. PanCode installs exactly that
  commit and refuses the pack when its contents do not match the listed digest, so a later push to the same
  repository changes nothing until a new listing is reviewed and accepted.
- **Released.** Listings reach PanCode in the index bundled with each release after the change is accepted. A signed
  index that reaches installations between releases is planned. These terms are not part of the index and changing
  them changes no listing.

## What the owner agrees to

By asking for a listing, the owner of a pack confirms that:

- they own the repository the listing names, or have its owner's permission to list it;
- they have the right to publish the pack under the license the listing states, and the pack's license file says the
  same;
- the pack does what its description says, and asks for no capability it does not use;
- they will ask for the listing to be withdrawn, or tell the maintainer, if any of this stops being true or they learn
  of a security problem in the listed commit.

The listing record itself is a contribution to the PanCode repository under [CLA.md](../CLA.md). The pack it points to
is not: it stays in the owner's repository, under the owner's copyright and license, and the owner can remove it there
at any time.

## Publisher

The publisher of a community listing is the GitHub account or organization that owns the repository it names. The
publisher name `pancode` is reserved for first-party packs, and no community listing may use it. A pack installed from
one publisher is never silently replaced by a pack of the same name from another.

## Not an endorsement

A listing says only that the pack passed the checks for its tier on the day it was accepted. It is not an endorsement,
a security audit or a support promise, and it never makes a community pack first-party. Community packs are not part
of PanCode and are not covered by its license or by its maintainer's support. A pack may say that it works with
PanCode; it may not use the PanCode name or marks in a way that suggests the maintainer made, owns or approved it.

## Licenses

The pack's own license governs its code, data and text; the PanCode License does not reach it. Every community listing
states the pack's license as an SPDX license identifier or SPDX expression, matching the license file in the pack. A
pack without a stated license is not listed.

These licenses qualify a pack for the verified tier: `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`,
`MPL-2.0`, `CC-BY-4.0` and `CC0-1.0`. A pack under any other license can be listed only in the listed tier, and PanCode
shows its license identifier plainly next to the pack, so an operator reads it before installing.

First-party packs are published by `pancode` under the PanCode License 1.0 (`LicenseRef-PanCode-1.0`), like the rest of
PanCode.

## Tiers

| Tier | Which packs | How PanCode treats them |
| --- | --- | --- |
| core | First-party packs, publisher `pancode`, shipped with PanCode | Trusted. |
| verified | Community packs that pass the full review, under a license from the list above | Trusted. |
| listed | Community packs with a valid record, a reachable commit and a matching digest | Untrusted: skills and tool servers stay held until the operator trusts them. |

A pack moves from listed to verified only through a new review. The maintainer may lower a pack's tier at any time.

## Takedown

A listing is taken down by removing it from PanHub. Copies already installed keep working unless the pack is also
revoked. The maintainer takes a listing down when its owner asks, when its repository or commit can no longer be
reached, or when it stops passing the checks for its tier.

## Revocation

Revocation is stronger than takedown: it tells every PanCode installation that updates to stop using a pack. The maintainer revokes
a listed commit when it is harmful, for example when it carries malicious code, a serious vulnerability or content the
owner had no right to publish. A revocation names the pack's digest, the reason and the date, and travels in the index
bundled with the next release.

When PanCode next loads a revoked pack, it stops loading it, tells the operator which pack was revoked, when and why,
and refuses to install it again. A revocation keeps applying when the index is old or PanCode is offline. The pack's
files stay on disk until the operator removes them.

Revocation is by digest. A fixed pack is a new commit with a new digest, and it returns only through a new listing and
a new review.

## Security

For a security reason the maintainer may take down or revoke any listing at once, without notice to its owner. The
owner is told afterwards when that is safe.
