# Streaming download spike

Standalone test page for the streaming zip download design in
IQSS/dataverse-frontend#898. Open the page over HTTPS, pick a size and rate,
and watch the browser's download list: a file that appears early and grows
is streaming; one that appears only when generation ends was buffered.

- A: service worker stream (transferable stream or MessageChannel), keepalive ping, optional early close
- B: OPFS spool (createWritable, or a sync access handle in a worker where that is missing)

`run.mjs` drives the page in Chromium or Firefox on Linux and reports file growth and renderer memory.

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

Consequences for the implementation:

- The keepalive is mandatory. Firefox kills the worker at about 30 s and turns the truncation into a "complete" download.
- Content-Length is not a safety net in either browser for service-worker responses: a cleanly closed short stream is accepted as complete. The only protection against a truncated zip is to never close the stream cleanly on failure; error it, and both browsers mark the download failed.
- Content-Length still gives the download manager a progress bar, so it is worth sending when exact.
