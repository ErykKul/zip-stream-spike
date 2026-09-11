# Streaming download spike

Standalone test page for the streaming zip download design in
IQSS/dataverse-frontend#898. Hosted at <https://erykkul.github.io/zip-stream-spike/>.

## Running the check

Press the button for this machine's memory: 8, 16, 32, 64 or 128 GB. The page
then streams **1.25x that much** through a service worker to your Downloads
folder, hashing it with SHA-256 as it goes, and shows a live counter.

That size is the point. A browser that held the file in memory could not finish
a download larger than the machine's RAM, so completing it is the proof, and it
is proof that survives the hashing too, since a hash that needed the whole file
buffered would fail for the same reason. At the end the page prints the SHA-256
of what it streamed along with the command to check the saved file, so you can
confirm the bytes on disk are the bytes that went through.

While it runs, the page also asks you to read the browser's memory in Activity
Monitor (macOS) or the browser's own task manager (Chromium) and answer with one
of three buttons. Press **Copy result** at the end and send the block back.

**Quick 4 GB check** exercises the plumbing without proving anything about
memory. `?totalMb=512&rateMbs=50` overrides its size and rate.

Two things are recorded without you doing anything. If the tab dies mid-run,
reopening the page reports how far it got, which is itself the answer. And if
the browser stops pulling for more than 15 seconds, the result says so.

Do not use the file size in the download list. Browsers pre-allocate the file to
its full announced `Content-Length`, and some do not refresh the panel while it
is open, so that number proves nothing either way.

`vendor/noble-hashes/` is a copy of the SHA-2 modules from
[@noble/hashes](https://github.com/paulmillr/noble-hashes) 2.4.0, the same
library the frontend uses, so the page hashes incrementally exactly as the real
implementation does.

Everything else lives under **Advanced**, collapsed by default:

- A: service worker stream (transferable stream or MessageChannel), keepalive ping, optional early close
- B: OPFS spool (createWritable, or a sync access handle in a worker where that is missing)

`run.mjs`, `run_selenium.py` and `run_firefox.py` drive the Advanced controls in
Chromium or Firefox on Linux and report file growth and renderer memory.

## Results, Linux, 2026-09-11

Chromium 140 (system, via Selenium and Chrome's own download manager) and Firefox 155 (system, via Selenium). Playwright's Firefox build cannot run service workers, so it was not used for the SW tests.

| Check | Chromium | Firefox |
|---|---|---|
| SW stream, transferable stream, 1 GB at 1 MB/s, keepalive on | complete, file visible on disk from the first sample and growing | complete, `.part` visible from t=0 and growing |
| Same, keepalive off | complete after 17 min | stalls at ~30 s; Firefox finalises a 30 MB `test.bin` as complete |
| MessageChannel path (forced) | complete | complete |
| Stream errored mid-run (abort) | download failed, partial file removed | download failed, `.part` left behind |
| Stream closed early, half of announced Content-Length | file renamed to `test.bin`, reported complete | file renamed to `test.bin`, reported complete |
| OPFS spool | `createWritable`, then download from the disk-backed File | `createWritable`, same |
| Renderer memory over 1 GB | 434 to 498 MB, flat | 610 MB, warm-up peak 1040 MB in the first 4 min, then 625 to 680 MB, flat |

## Results, macOS Safari, 2026-09-11

Safari 18.2 (`Version/18.2 Safari/605.1.15`) on macOS, one-button check, 4 GB at 50 MB/s.

| Check | Result |
|---|---|
| Service worker registered and controlling | yes |
| Transferable `ReadableStream` | **no**, the MessageChannel path is what Safari uses |
| OPFS | `createSyncAccessHandle` only, no `createWritable`, so the worker path |
| 4 GB through the service worker | completed in 82 s, no stall, stream closed cleanly |
| Download list during the run | listed with a normal, advancing size indicator |

Desktop Safari therefore needs no size cap on the service worker path, but it
does need the MessageChannel fallback and, if anything ever spools to OPFS
there, a sync access handle in a worker.

Consequences for the implementation:

- The keepalive is mandatory. Firefox kills the worker at about 30 s and turns the truncation into a "complete" download.
- Content-Length is not a safety net in either browser for service-worker responses: a cleanly closed short stream is accepted as complete. The only protection against a truncated zip is to never close the stream cleanly on failure; error it, and both browsers mark the download failed.
- Content-Length still gives the download manager a progress bar, so it is worth sending when exact.
