# Earlier raw-stream experiment

These are historical observations reported by the previous README at commit
`7351fc3` (2026-09-11). They were not rerun while rebuilding the ZIP harness.
The older code generated raw `check.bin` / `test.bin` downloads, rather than
running the Dataverse ZIP encoder and hook. It also explored OPFS, which the
current frontend pipeline does not use.

## Linux observations recorded on September 11

The old README named Chromium 140 and Firefox 155, driven through Selenium.

| Experiment | Chromium observation | Firefox observation |
| --- | --- | --- |
| 1 GiB stream at 1 MiB/s, transferable stream, keepalive enabled | Completed; file appeared during generation | Completed; `.part` appeared during generation |
| Same, keepalive disabled | Completed after about 17 minutes | Stalled near 30 seconds; a short file appeared complete |
| Forced MessageChannel | Completed | Completed |
| Error stream mid-run | Failed download, partial file removed | Failed download, `.part` retained |
| Cleanly close after half the announced Content-Length | Short download appeared complete | Short download appeared complete |
| OPFS spool | `createWritable` path | `createWritable` path |
| Reported renderer RSS during 1 GiB run | 434–498 MB | Initial peak 1,040 MB; later 625–680 MB |

These observations motivated keepalive, explicit stream errors on failure, and
testing both transfer mechanisms. Neither apparent file growth nor
Content-Length alone establishes saved-file integrity. The old scripts used
machine-specific paths and broad process sampling; the reported memory figures
are not a measurement of the current ZIP harness.

## Safari observation recorded on September 11

The old README reported Safari 18.2 (`Version/18.2 Safari/605.1.15`) on macOS:
4 GiB at 50 MiB/s completed in 82 seconds using MessageChannel, without a
reported stall. Transferable ReadableStreams were unavailable. OPFS was reported
to have a sync-access-handle path but no `createWritable`.

That observation did not include a ZIP, a larger-than-installed-RAM run, or
saved ZIP integrity validation. It therefore does **not** establish uncapped
Safari support or a fixed memory bound. Actual Safari testing with the current
harness is still needed.

## Conclusions deliberately not carried forward

- A completed download larger than physical RAM is not proof that no buffering,
  virtual memory, or disk backing was used.
- A crash or reload does not establish out-of-memory as its cause.
- A producer finishing does not establish successful browser download completion.
- The 4 GiB raw-stream Safari observation is not a substitute for current Safari
  ZIP/ZIP64 results.
