# Large ZIP browser check

**Open [the test page](https://erykkul.github.io/zip-stream-spike/) in the browser
you want to test. Choose your computer’s RAM size and let it download.**

This experiment tests the ZIP downloader used by
[Dataverse frontend PR #898](https://github.com/IQSS/dataverse-frontend/pull/898).
The page runs the actual frontend React download hook, ZIP encoder, and
service-worker sink. It generates synthetic file data locally, so no Dataverse
server, account, large source file, or upload is needed.

## Run a test

1. Choose the button matching your installed RAM, or the next size up. On a
   **32 GB RAM** machine, choose **32 GB**: it creates a ZIP containing **35 GiB**
   of data. Make sure the disk has enough free space. A small 64 MiB setup check
   is available too.
2. Leave the page open and the computer awake. If the browser asks where to save
   the ZIP, choose a folder on disk and keep its suggested unique filename.
   Wait for the browser download to finish.
3. Click **Choose saved ZIP to verify**, and select the completed download.
   The page checks the archive structure and every entry’s SHA-256 and CRC-32
   using small reads in a worker. It needs no extraction or extra copy.
4. **Copy result** or **Save result**, send it to the person collecting results,
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
10 MiB ranges, `client-zip` encoder, MessageChannel fallback, keepalive, and
error handling. The worker is under `reusable-components/`, outside the page’s
scope, matching the embedded JSF layout. If the frontend chooses its Blob
fallback, the result records it and the existing 2 GiB cap applies. There is no
OPFS alternative, custom ZIP writer, or hidden large-memory fallback added here.

This test does **not** establish behavior against real Dataverse servers:
authentication, storage CORS, S3 redirects, URL expiry, tree enumeration, network
failures, background-tab throttling, and sleep/wake need separate checks.

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

## Earlier experiment

The September 11 spike generated raw `.bin` streams and explored OPFS. Its
results are retained in [HISTORY.md](HISTORY.md), with their limits made explicit.
Those observations are not results for this ZIP harness. The old scripts remain
available in Git history at `7351fc3`; their unused controls and copies have
been removed from the active page.
