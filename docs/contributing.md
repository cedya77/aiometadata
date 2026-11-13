# Contributing

Thanks for your interest in contributing.

This repository is maintained with limited review time, so we use a strict contribution process to keep reviews fair, fast, and useful.

## Licenses and the contributor agreement

AIOMetadata is under two licenses: the core under AGPL-3.0-or-later, and the
v4 feature modules under FSL-1.1-ALv2 (Jellyfin server, trackers, dashboard).
[`LICENSING.md`](../LICENSING.md) lists which paths are which. Contributions to
both parts are welcome.

- **Sign the CLA.** Before your first pull request can merge, you sign the
  [Contributor License Agreement](CLA.md) by commenting the sentence the CLA
  bot asks for. You keep your copyright and give the maintainer a license that
  lets the project keep publishing your work under its licenses, including
  future ones. Everyone named in a `Co-authored-by` trailer signs too: the bot
  checks every author in the pull request.
- **Add the license header.** Every source file starts with an SPDX header.
  `npm run check:licenses -- --fix` writes the right one for the file's path.
  A new file under an FSL path, or a new FSL module, also needs its path in
  `LICENSING.md`.
- **Only contribute what you may.** Don't copy code from other projects unless
  its license allows it and you say so in the pull request.

## Before you open a pull request

For anything beyond a tiny typo, documentation fix, or clearly isolated bugfix, **open an issue first and wait for maintainer confirmation before starting work**.

Pull requests may be closed without review when they:
- are not linked to an issue that was already discussed or approved;
- bundle several unrelated changes together;
- are too large for efficient review;
- do not explain the problem, approach, and test plan;
- appear mechanically generated, mass-edited, or not understood by the author;
- do not follow the repository's coding, testing, or documentation standards.

## Scope rules

Please keep pull requests small and focused.

Good pull requests usually:
- solve one problem;
- touch the smallest practical set of files;
- include tests when behavior changes;
- include docs when user-facing behavior changes;
- explain tradeoffs and limitations.

Please avoid drive-by feature additions unless a maintainer has explicitly asked for them.

## AI-assisted changes

AI assistance is not banned, but accountability is required.

If you use AI tools in any part of your change, you must still:
- understand every changed line;
- verify the behavior yourself;
- be able to explain the approach and tradeoffs in review;
- fix follow-up review comments yourself;
- ensure no generated content violates licensing or project rules.

PRs that look bulk-generated, lack clear reasoning, or cannot be defended in review may be closed.

## First-time contributors

If this is your first contribution here:
- start with a small issue;
- do not open multiple PRs at once;
- expect extra review scrutiny on broad or invasive changes.

Maintainers may ask first-time contributors to split large PRs or start with a smaller issue.

## Pull request checklist

Before marking a PR ready for review, make sure you have:
- linked the related issue in the PR body;
- explained the problem and solution clearly;
- described how the change was tested;
- added or updated tests when needed;
- added or updated documentation when needed;
- kept the diff focused and reviewable.
- signed the CLA, and checked that new files carry the license header (`npm run check:licenses`).

## Fast-path exceptions

These changes usually do **not** need an issue first:
- typo fixes;
- spelling/grammar fixes;
- narrow documentation clarifications;
- very small, obvious test-only fixes.

Even for these, please keep the PR tightly scoped.

## Review expectations

Maintainers may close PRs that are:
- inactive after review feedback;
- missing required context or checklist items;
- significantly larger than requested;
- misaligned with project direction.

Closing a PR is not a judgment on the contributor. It is often just a review-capacity decision.
