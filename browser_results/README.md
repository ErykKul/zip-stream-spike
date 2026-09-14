# Browser results

Manual Linux results from 2026-09-14 on a laptop with 32 GB RAM. Each completed
run saved and verified a 35 GiB payload in seven ZIP64 entries using SHA-256 and
ZIP CRC-32. All five suite checks passed: cancellation, retry/resume, source
silence, stream lifetime and saved-ZIP verification.

## Current suite v2

Frontend source `61c6b12451f369efe22cef58a99a24d6b2ded85f`, engine
`87b57ddca34b6944`, mechanism `37059c310dcca21e`. These runs test production
automatic body retries. Window modes were not recorded.

| Browser | Completed report | Memory selector in export |
| --- | --- | --- |
| Chrome 153 | [Verified ZIP](dataverse-zip-result-1789397827504.json) | `roughly-flat` |
| Chromium 152 | [Verified ZIP](dataverse-zip-result-1789398501810.json) | `roughly-flat` |
| Edge 153 | [Verified ZIP](dataverse-zip-result-1789397539487.json) | `roughly-flat` |
| Firefox 155 | [Verified ZIP](dataverse-zip-result-1789394546209.json) | `not-measured` |
| Opera 135 | [Verified ZIP](dataverse-zip-result-1789397601232.json) | `roughly-flat` |

Eryk observed total system RAM reaching about **10 GB while testing three
browsers concurrently**, with up to five browsers open. This includes ordinary
browser/application memory. The Firefox v2 export retains its `not-measured`
selector; the separate system observation does not change the raw report.
Overlapping runs are not isolated performance benchmarks.

**Safari on macOS remains outstanding.** Ask Julian first.

## Earlier and intermediate exports

- [Firefox v1](dataverse-zip-result-1789389592223.json) is a completed 35 GiB pass
  from source `fc73d4ece`, engine `b247577d88111321`. That suite invoked Retry;
  keep it distinct from v2's production automatic retry evidence.
- [Chrome during verification](dataverse-zip-result-1789397633261.json) has
  `verified: false` because verification was still running. It has the same run
  and filename as the [completed Chrome report](dataverse-zip-result-1789397827504.json).
  It is neither a separate run nor a recorded failure.

The raw exports are unchanged. These are synthetic-source tests; real
Dataverse/storage integration, sleep/wake and the previously observed Firefox
offline/online loss of the download destination remain separate open checks.
