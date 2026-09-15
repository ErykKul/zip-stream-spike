# Browser results

Manual saved-ZIP results, grouped by the frontend and test build actually run.
The environment descriptions below include tester observations; raw exports are
preserved unchanged.

## Suite v3: Safari in a macOS VM, 2026-09-15

[Safari 17.6: verified 35 GiB ZIP](2026-09-15-safari-17.6-macos-vm-35gib.json),
reported by Eryk as a Safari run in a macOS VM. Frontend `59979b628`, engine
`909b1d8ad8fd66bd`, mechanism `c5d21c7bc3f5ef69`, matching revision 7.

- All six suite checks passed: protocol, cancellation, automatic retry/resume,
  45-second source silence, stream lifetime and saved-ZIP verification.
- Seven ZIP64 entries passed SHA-256 and CRC-32. ZIP bytes **37,580,965,226**
  agree with the worker's completion count; payload is exactly **35 GiB**.
- The native ZIP used automatically selected **MessageChannel**, cloned chunks,
  no declared Content-Length and no extended worker-event lifetime. No special
  native-download setting was needed. All five available internal protocol
  comparisons passed; transferable streams were not available in this run.
- Download checks took **12m00s**, including a final **2m42s** lifetime hold;
  saved-file verification took **5m11s**. Recorded hidden intervals total
  **8m06s**, longest **5m05s**. Timer gaps are not evidence of system sleep.
- The **32 GB RAM button** was selected. Actual assigned VM RAM and the macOS
  version are awaiting clarification. `memoryObservation` is `not-measured`;
  this export supplies no RAM measurement. Its user-agent macOS string is not
  an independently recorded operating-system version.

This is a saved-ZIP pass in Safari itself, running in a VM. Julian's separately
requested Mac result is still pending; no result is attributed to him.

## Suite v2: Linux, 2026-09-14

These runs used a laptop with 32 GB RAM. Each saved and verified 35 GiB in seven
ZIP64 entries with SHA-256/CRC-32, and passed all five suite-v2 checks.

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
