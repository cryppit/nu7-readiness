# NU7 readiness

Which Zcash wallets, libraries, bridges and swaps are ready for NU7, from public evidence only.

NU7 activates on Mainnet at block **3,543,405** (around 5–6 November 2026, [ZIP 259](https://zips.z.cash/zip-0259)). From
that block every version 4 transaction is invalid, and signers need the new consensus branch ID `0x77190AD9`. This board
re-checks each project several times a day and shows what the evidence says, with a link for every claim.

## How a status is decided

Each row in [`targets.json`](targets.json) lists signals. The checker reads each one and the row gets the strongest
evidence it has:

| Status | When |
|---|---|
| Fixed | A fix PR is merged, a release is published, the source contains the NU7 change, or every blocking issue was closed as done |
| In review | A fix PR is open |
| Broken | A blocking issue is open, or the source still shows the problem, and no fix is open |
| Watch | Only a dated report, a conflicting source, or a related change |
| Unknown | A lookup failed; a failed lookup never counts as fixed or broken |

"Fixed" means fixed upstream. A release to users or a contract deploy can still be pending, and the row's note says so.

Signal kinds: `blocker` (an issue), `fix` (a pull request), `release` (`owner/repo@tag`), `code` (`owner/repo:path` on the
default branch, with a pattern that means fixed or broken), `context` (shown, never decides) and `manual` (a dated note
with a link).

## Run it

Python 3 standard library only.

```sh
python3 -m unittest -v test_check   # tests
python3 check.py                    # writes data/status.json (set GITHUB_TOKEN for a higher GitHub rate limit)
python3 -m http.server              # then open http://localhost:8000
```

GitHub Actions runs the tests and the checker on an hourly schedule (GitHub often runs it only every few hours) and on every push, and publishes the page to GitHub Pages.

## Corrections

Open an issue with the evidence (a PR, a release, a commit or a maintainer statement) and the row will be updated.

## Disclosure

Run by [Cryppit](https://github.com/cryppit). Cryppit filed some linked items (vultisig-android #6115, grant application
ZCG #513) and has a grant application in review for the Vultisig/SwapKit swap path.

## Licence

MIT
