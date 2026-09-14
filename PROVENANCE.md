# What this experiment runs

`engine.js` bundles the actual `useStreamingZipDownload` React hook and its
dependency closure from IQSS/dataverse-frontend commit
`fc73d4eced3f46583012f787973d0f4c437a8c54` (PR #898). The hook runs in a hidden React
root, just as a component would use it. Its source, `zipStreamSink`, size limits,
formatting dependency and unload guard are copied byte for byte under
`vendor/frontend/`. The service worker is an unchanged copy of the frontend
`public/zip-download-sw.js`.

`provenance.json` records the frontend commit, SHA-256 of every copied source,
dependency versions, test pattern and build identifier. `engine.js.map` includes
the bundled source for inspection. The build refuses modified snapshot files or
dependency versions that differ from `package.json`.

The upstream Apache-2.0 license is preserved at `vendor/frontend/LICENSE`.
Full dependency license texts are in `licenses/`; esbuild also emits its bundled
third-party notices alongside the JavaScript bundles. React, React DOM,
Scheduler and all ZIP/checksum runtime dependencies are pinned to the versions
installed in the frontend checkout.

## Production path exercised

1. The normal frontend `resolveZipSink` registers and probes the worker, selects
   streaming when available, and otherwise selects its existing Blob fallback.
2. The actual hook requests each synthetic entry sequentially, using its default
   10 MiB range size and incremental SHA-256 verification.
3. The actual `client-zip` 2.5.0 encoder writes ZIP headers, stored payloads, data
   descriptors, central directory and ZIP64 records.
4. The actual sink chooses transferable streams or the MessageChannel fallback,
   acknowledges registration, navigates a hidden iframe, sends its normal
   keepalive messages, and follows browser backpressure.
5. The browser downloads the ZIP. The test page is outside the service worker's
   `reusable-components/` scope, matching the embedded JSF placement.

The synthetic server is a narrowly scoped `fetch` interceptor in the test page.
Only the test run's exact synthetic URLs are handled; other requests retain the
browser's fetch implementation. It returns real `Response`/`ReadableStream`
objects with status 206 and `Content-Range` for the hook's range requests. It
allocates one 256 KiB chunk on demand. There is no prebuilt Blob, source file,
in-memory ZIP, OPFS spool, alternative ZIP encoder or replacement download sink
on the streaming path. If the production resolver chooses its Blob fallback,
the result explicitly says `buffered-blob`; the production 2 GiB limit still
applies.

Every large run includes 5 GiB entries, exercising the ZIP64 representation for
an individual entry as well as offsets beyond 4 GiB. Remaining bytes use
powers-of-two MiB entries. Each entry repeats a deterministic 256 KiB pattern;
the encoder uses STORE, so it writes the full requested payload size. Native
Node SHA-256 computes the expected entry checksums during the build, with
bounded memory. No preliminary browser pass over the large payload is needed.

`start({transferStreams: false, ...})` forces the actual MessageChannel sink for
automation and diagnostics. Such a run is explicitly marked diagnostic. The
normal RAM buttons do not override the production transport decision.

## Automatic sequence and diagnostic scenarios

The RAM buttons call `startSuite`, which first runs a 64 MiB cancellation check,
then `start({scenario: 'complete', ...})` with the selected payload. This adds
source errors, frontend automatic retry, 45 seconds of silence and a final-chunk hold to
at least 12 minutes, with a 45-minute source ceiling. `checkCancellation` invokes
the actual hook cancellation during a pending source read. A pass requires the
frontend fetch AbortSignal to abort while that read is pending; disposing the
synthetic source alone cannot pass. Signal listeners are removed as each range
response ends. The probe supplies the existing sink's `navigate` option with a
controlled helper iframe under `reusable-components/`. That iframe fetches and
consumes the real worker's ZIP response instead of starting a native download;
consumer failure is required too. The helper is included in the build hash.
This avoids Chrome's multiple-download gate and creates just one native saved
ZIP: the main payload, whose default navigation and sink are unchanged.
Native download-manager cancellation is separately tested by browser automation;
it cannot be inferred from this internal-consumer probe.

`start({scenario: 'recovery' | 'background' | 'cancel', ...})` retains the smaller
64 MiB diagnostics for browser automation. It refuses
a buffered sink because that would not test service-worker behavior. Omitting
`scenario`, as the Advanced setup check does, leaves the source unpaced and fault-free.

`src/scenarios.mjs` defines the fixed durations, one-time errors, exact resumed
offset expectation, and time limits. Its injectable clock is used only by unit
tests; the browser engine exposes no timing override. `retry()` forwards the
actual hook's `retryCurrent()` decision. The frontend's retry counts, delay,
range size, keepalive and worker source are unchanged. Events and visibility
changes are included in the result. Pending synthetic reads and diagnostic
timers are cleaned up on stop or completion.

The harness also records a stable `frontendMechanismId`, derived from the copied
frontend files and runtime dependency versions. `buildId` additionally includes
the diagnostic adapter and build inputs, so it changes when the harness changes.
Earlier results without `frontendMechanismId` can be matched by their frontend
commit and dependency versions against the retained source-hash provenance.
The earlier large ZIPs remain valid evidence for their recorded source version.
The current snapshot adds two frontend cancellation fixes: rejected source-reader
cancellation is handled, and client-zip's unhandled call to the input generator's
`throw()` is caught specifically on cancellation. Ordinary source/read failures
still propagate through the frontend recovery flow. These fixes are in local
frontend commits `5d5ce8d5b` and `fc73d4ece`; the dependency versions and download
worker are unchanged. This test repository contains the exact source even before
those frontend commits are pushed for PR re-review.

Fault injection checks the frontend's response to those exact source failures.
It is not an actual Internet outage. Browser offline/online automation probes
the destination stream separately, with source bytes still generated locally.
Cancellation and unload dialogs require either native-browser automation or
explicit tester observations; a page result alone cannot inspect those controls.
A source-complete event must still be followed by saved-file verification for
an integrity pass. Timeouts and unavailable streaming sinks are inconclusive.

## What a successful result establishes

The hook's `done` state means its source ZIP stream has been consumed by the
browser transport. It is not a disk flush or browser download-manager
completion signal. The page cannot observe those signals directly.

After the browser has finished, the tester selects the saved ZIP. A dedicated
worker reads its end records and bounded central directory, validates the exact
expected entry plan and size, then reads each entry in 4 MiB slices. It checks
SHA-256 against independent build-time vectors, ZIP CRC-32, local headers, data
descriptors, entry boundaries, central directory and ZIP64 records. It rejects
truncation, corrupt bytes, an incorrect test size and a different ZIP. The whole
saved file is never read into an ArrayBuffer. Verification reads the file again
and takes additional time.

A complete, verified ZIP larger than the machine's physical RAM demonstrates
that this browser can complete this pipeline at the tested size. It does not
prove zero buffering, a specific RAM ceiling, or the absence of operating
system paging. Browser/OS memory observations are useful additional evidence.

## Boundaries

Synthetic fetch does not test real Dataverse servers, remote network throughput,
CORS, S3 redirects, expired credentials, authorization, range refusal, network
failure recovery, dataset selection, restricted files or classic server ZIP
limits. Those require separate frontend/integration tests and answers. A
browser crash or a stuck download remains a failed/incomplete manual test even
if the page previously reported stream completion. Safari must be tested in
real Safari on macOS; another engine or emulation does not replace that test.

## Rebuilding

With the committed snapshot, install the exact versions in `package.json`, then
run `npm run build` and `npm test`. In the combined workspace the build can use
the sibling `dataverse-frontend/node_modules` when this repository has none;
it still checks all dependency versions. Committed bundles make GitHub Pages
self-contained, without CDN imports or a build needed on the host.

To deliberately update the frontend version, first check out the desired clean
frontend commit and run `npm run sync-frontend -- ../dataverse-frontend`, then
rebuild, test, and review the source/provenance changes. The sync script refuses
uncommitted modifications in its selected source files. Update this document's
commit reference when changing that snapshot.

The complete suite no longer invokes Retry for the frontend. It requires exact
byte resumption with no paused/manual-decision state; exhausted automatic
recovery fails the check. Production defaults remain three retries and a 500 ms
delay. Earlier v1 suite reports included a harness-invoked Retry and remain
evidence for that older behavior.
