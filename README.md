# Large ZIP browser check

**Open [the test page](https://erykkul.github.io/zip-stream-spike/) in the browser
you want to test. Choose your computer’s RAM size and leave the automatic check running.**

This experiment tests the ZIP downloader used by
[Dataverse frontend PR #898](https://github.com/IQSS/dataverse-frontend/pull/898).
The page runs the actual frontend React download hook, ZIP encoder, and
service-worker sink. It generates synthetic file data locally, so no Dataverse
server, account, large source file, or upload is needed.

## Run a test

1. Choose the button matching your installed RAM, or the next size up. On a
   **32 GB RAM** machine, choose **32 GB**: it creates a ZIP containing **35 GiB**
   of data. Make sure the disk has enough free space.
2. The button runs the stopping check, then downloads your large ZIP with
   automatic recovery, pauses, and at least 12 minutes of stream lifetime.
   **No Retry click or separate diagnostic is needed.** Only the final ZIP is
   saved as a browser download. Keep its suggested unique filename.
3. Leave the page open and the computer awake, with developer tools closed.
   You can use another tab or application while it runs. Wait for the final
   browser download to finish.
4. Click **Choose saved ZIP to verify**, and select the completed download.
   The page checks the archive structure and every entry’s SHA-256 and CRC-32
   using small reads in a worker. It needs no extraction or extra copy.
5. **Copy result** or **Save result**, send it to the person collecting results,
   and repeat in the next browser. Delete the ZIP when finished.

| RAM button | ZIP payload |
| --- | --- |
| 4 GB | 5 GiB |
| 8 GB | 9 GiB |
| 16 GB | 18 GiB |
| 24 GB | 27 GiB |
| 32 GB | 35 GiB |
| 48 GB | 53 GiB |
| 64 GB | 70 GiB |
| 96 GB | 105 GiB |
| 128 GB | 140 GiB |

The payload is approximately 9% above the selected memory size, rounded up to
whole GiB. ZIP headers add a little more. A GiB is 1,024³ bytes. Runs include
5 GiB entries to exercise ZIP64 file sizes and archive offsets.

Try Edge, Opera, Chrome, Chromium, Firefox, and actual Safari on macOS where
available. Engine similarity does not replace testing each installed browser.
An optional memory observation can be added to the result. The page records
the full user agent, frontend commit, engine build, selected size, transfer path,
duration, and saved-file verification. Results stay in the browser; they are not
sent to a server. The latest interrupted run is retained when storage is available.

## What counts as a result?

**“Ready to verify” means the browser consumed the stream.** A web page cannot
automatically inspect the browser’s Downloads folder or observe its final disk
flush. Generation reaching 100%, an apparent file size, or a service-worker
capability check is not a verified download.

**“ZIP verified” means the saved file has the expected structure and contents.**
A verified archive larger than physical RAM is evidence that this browser and
machine can complete this pipeline at that size. It does not prove a particular
peak RAM bound, absence of buffering, or absence of swap/disk backing. The
optional browser heap reading excludes other browser processes and caches.

A failed or interrupted run remains inconclusive about its cause. The page
does not diagnose crashes as out-of-memory failures. A small test establishes
correctness at its size, not large-download support.

## How closely does this match Dataverse?

See [PROVENANCE.md](PROVENANCE.md) and [provenance.json](provenance.json) for the
exact source commit, file hashes, dependency versions, and adaptations. The
production code is copied unchanged into `vendor/frontend/`; the build refuses
changed snapshots. The only data-source substitution is a narrowly scoped
synthetic `fetch` handler returning streamed range responses.

The default run keeps the frontend’s transport selection, incremental hashes,
10 MiB ranges, `client-zip` encoder, MessageChannel fallback, and keepalive.
The harness injects source failures and invokes the actual frontend Retry and
Cancel actions automatically; it does not replace their implementation. The
worker is under `reusable-components/`, outside the page’s
scope, matching the embedded JSF layout. If the frontend chooses its Blob
fallback, the complete check stops as inconclusive because it requires streaming.
The plain Advanced check retains the production 2 GiB buffered cap. There is no
OPFS alternative, custom ZIP writer, or hidden large-memory fallback added here.

This test does **not** establish behavior against real Dataverse servers:
authentication, storage CORS, S3 redirects, URL expiry, tree enumeration, real network
failures and sleep/wake need separate checks. Background visibility is recorded
for this run; a foreground result does not establish hidden-tab behavior.

## Development and publishing

The repository is a static GitHub Pages site served from the root of `main`.
Generated browser bundles are committed so the published test needs no CDN or
runtime package installation. The upstream source and dependency licenses are
retained with the snapshot and bundles.

```sh
npm install
npm run build
npm test
python3 -m http.server 8765
```

Open `http://localhost:8765/`. In the combined Dataverse workspace the build can
use the sibling frontend’s installed dependencies, with exact version checks.
To update the source snapshot, follow [PROVENANCE.md](PROVENANCE.md).

[Browser smoke testing](scripts/TESTING.md) covers real downloads on Chromium,
both transport paths, independent ZIP validation, and rejection of corruption
and truncation. Its optional ZIP64 run exercises an entry larger than 4 GiB.
Smoke-test success is not a substitute for each tester’s larger-than-RAM run.

## What the automatic sequence checks

Each RAM button performs the same sequence:

1. Start an internal stream through the actual ZIP hook, encoder, sink and
   service worker. Cancel while its source read is waiting and check both the
   frontend abort signal and consumer failure. This probe creates no saved file.
2. Start the selected large ZIP. Return one simulated HTTP 503 and interrupt a
   response after 3 MiB. The harness invokes the actual Retry action and checks
   the resumed request starts at exactly 3 MiB.
3. Pause source bytes for 45 seconds, then transfer at the pipeline's normal
   speed. Before the final chunk, keep the stream open until its active source
   lifetime reaches **12 minutes**. A naturally longer transfer needs no extra
   lifetime wait. Source generation has a **45-minute ceiling**; reaching it is
   inconclusive. Verification takes additional time.
4. Ask you to select the final saved ZIP and verify its complete structure,
   SHA-256 and CRC-32. The browser does not let a web page read Downloads
   automatically, so this final file selection is required.

“Browser ZIP check passed” requires all automatic checks and saved-file
integrity to succeed. It includes the injected faults, automatic decisions, exact resumed
range, source pause, lifetime evidence, and visibility changes. Ordinary range
request logs are sampled in large runs; exact request counters are retained.

**The automatic stopping check uses an internal stream consumer.** A page cannot inspect
native download-manager controls, test its own actual network disconnection, or
confirm a reload dialog without user interaction. Those checks use separate
browser automation or explicit manual observations. They are listed as outside
the page's automatic result, not silently counted as passes. Real Dataverse
credentials, CORS, storage requests and sleep/wake also need integration checks.

Existing 35 GiB integrity results remain historical evidence for their recorded
frontend version. Repeating a RAM-button run now collects the combined evidence
on the updated cancellation handling. For a fast setup check, Advanced offers
an unpaced 64 MiB ZIP without interruptions or the 12-minute duration floor.

See [interruption automation](scripts/INTERRUPTIONS.md) for the browser checks.
The small recovery, cancellation, and old paced-background scenarios remain
available through the testing API. The old paced-background scenario uses
chained JavaScript timers: hidden Chromium can throttle those source timers
heavily after five minutes. Its nominal duration is not a reliable model of a
real network source; use the complete unpaced sequence for lifetime evidence.

During a background run, keep only one test tab open in each browser application;
other test tabs may keep its shared worker active. Different browser applications
can run together, but compete for CPU and disk resources. A deadline is checked
when the browser can execute code; sleep or suspension can delay it.

## Earlier experiment

The September 11 spike generated raw `.bin` streams and explored OPFS. Its
results are retained in [HISTORY.md](HISTORY.md), with their limits made explicit.
Those observations are not results for this ZIP harness. The old scripts remain
available in Git history at `7351fc3`; their unused controls and copies have
been removed from the active page.
