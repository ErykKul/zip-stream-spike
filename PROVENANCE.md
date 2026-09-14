# What this experiment runs

`engine.js` bundles the actual `useStreamingZipDownload` React hook and its
dependency closure from IQSS/dataverse-frontend commit
`5855877c3c6c2a9fcbf9c8be7ad0a5bc97599047` (PR #898). The hook runs in a hidden React
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
