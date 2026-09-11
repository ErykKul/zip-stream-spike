# Streaming download spike

Standalone test page for the streaming zip download design in
IQSS/dataverse-frontend#898. Hosted at <https://erykkul.github.io/zip-stream-spike/>.

## Running the check

Open the page and press **Run the check**. It streams 4 GB through a service
worker to your Downloads folder at 50 MB/s, so it takes about 80 seconds.
After a few seconds the page tells you where to read this browser's memory
(Activity Monitor on macOS, the browser's own task manager on Chromium) and
asks whether that number stays flat or climbs along with the counter. That
answer is the whole test: flat memory while gigabytes go past means the bytes
were handed to disk as they arrived. Press **Copy result** at the end and send
the block back.

Do not use the file size in the download list. Browsers pre-allocate the file
to its full announced `Content-Length`, and some do not refresh the panel while
it is open, so that number proves nothing either way.

Two things are recorded without you having to do anything. If the tab dies
mid-run, reopening the page reports how far it got, which is itself the answer:
running out of memory means it was not streaming. And if the browser stops
pulling for more than 15 seconds, the result says so.

`?totalMb=512&rateMbs=50` overrides the size and rate for a quicker run.

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
