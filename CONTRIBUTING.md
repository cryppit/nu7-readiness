# Contributing

Corrections are the most useful thing you can send. If a row is wrong for a project you work on, open an issue or a
pull request with a link to the source, and it will be fixed the same day.

## Ground rules

- **Read-only.** `check.py` only reads public data. No change may add keys, tokens beyond the Actions token, or anything
  that posts or writes outside this repository.
- **Every row links its evidence.** A status comes from a signal: an issue, a pull request, a release or a pattern in a
  source file. A claim with no public source does not go on the board.
- **A failed lookup never counts either way.** If the check can't read a source, the row says so.
- **Say what changes for a user.** Notes are plain words: what breaks, for whom, and what fixes it.

## Development

Python 3 standard library only, no dependencies.

```bash
python3 -m unittest   # the tests
python3 check.py      # one real check against public sources
```

Rows live in `targets.json`. Write the failing test first for any change to `check.py`.

## Pull requests

For commits, branches and review, follow [librustzcash's contribution guidelines](https://github.com/zcash/librustzcash/blob/main/CONTRIBUTING.md),
the reference style for Zcash projects, adapted to Python where they are Rust-specific.

Keep one change per pull request, and link the evidence for any row you change. By contributing you agree that your
contribution is licensed under the licence of this repository.
