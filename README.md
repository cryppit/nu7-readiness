# NU7 readiness

Which Zcash wallets, libraries, bridges and swaps are ready for NU7, from public evidence only.

NU7 activated on Mainnet at block **3,543,405** on 6 November 2026 ([ZIP 259](https://zips.z.cash/zip-0259)). From
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

## Can my wallet send after NU7?

The page has a picker of wallets and apps. Pick one and it answers in plain words from that row's status: **Yes**
(with the version to have), **Not yet** (with what to do, and that a refused or rejected send moves nothing, so the
ZEC is not lost), **Not clear** (Watch) or **Unknown** (a lookup failed). A row is in the picker when it has a `user`
block in [`targets.json`](targets.json):

| Key | Meaning |
|---|---|
| `label` | The name in the picker (required) |
| `update` | The version to have, e.g. "Edge 4.52.3 or later" |
| `caveat` | A limit shown with a Yes |
| `pending` + `checked` | The fix is merged but not in a release users can install yet; the answer is Not yet until this is removed |
| `advice` | What to do while it can't send (a default is used when this is missing) |

## What does my wallet's error mean?

Paste the error a wallet or node showed and the page explains it: NU7's version 4 rejection ("transaction version 4 not
supported by the network upgrade Nu7"), consensus branch ID errors (it names the IDs it finds, NU7's `0x77190AD9`,
NU6.3's `0x37A5165B` and the earlier ones, and says whether the wallet or the node is behind), software too old to read
NU7's branch ID, expiry errors, and Zebra's end-of-support message. Every message it matches is quoted from Zebra 7.0.0,
zcashd or librustzcash source, cited next to the pattern in [`nu7.js`](nu7.js). Anything else gets a plain "not
recognised" answer.

Both run in the browser from the board's own data: no new requests, nothing you pick or paste leaves the page. The page
also lists upcoming deadlines (Zebra 7.0.0's end-of-support height from its source constants, and NU8 only as proposed
until it is scheduled).

## Run it

Python 3 standard library and Node 18 or later, no installs.

```sh
python3 -m unittest -v test_check   # checker tests
node --test nu7.test.js             # page logic tests (send answer, error decoder, deadlines)
python3 check.py                    # writes data/status.json (set GITHUB_TOKEN for a higher GitHub rate limit)
python3 -m http.server              # then open http://localhost:8000
```

GitHub Actions runs both test suites and the checker on an hourly schedule (GitHub often runs it only every few hours) and on every push, and publishes the page to GitHub Pages.

## Corrections

Open an issue with the evidence (a PR, a release, a commit or a maintainer statement) and the row will be updated.

## Disclosure

Run by [Cryppit](https://github.com/cryppit). Cryppit filed some of the linked items: shapeshift/web #12794 and
vultisig-android #6115. Its grant request for the Vultisig/SwapKit swap path (ZCG #513) was withdrawn on 8 Nov, because
Vultisig is doing that work itself.

## Licence

MIT
