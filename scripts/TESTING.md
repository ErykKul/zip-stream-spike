# Automated checks

Run `node scripts/smoke.mjs` from the repository root after rebuilding the
frontend snapshot. It starts a local static server at the same subdirectory
shape as GitHub Pages and opens Chromium. The test:

1. Clicks the page's quick check and saves the browser's completed download.
2. Reads every ZIP entry with Python's independent ZIP reader, including its
   CRC and central-directory checks.
3. Selects that saved file in the page and requires successful verification.
4. Checks that the verifier rejects a corrupt payload and a truncated archive.
5. Repeats the download with the MessageChannel transport forced, covering the
   fallback used by browsers without transferable streams.

The default is 64 MiB per download. This checks correctness and the user flow;
it does **not** establish memory usage or support for downloads larger than RAM.
`node scripts/smoke.mjs --zip64` instead generates 5 GiB + 64 MiB per download
and requires a valid entry larger than 4 GiB. That checks ZIP64 correctness,
also without making a claim about RAM usage.
The ZIP64 run skips the altered-copy fixtures; run the default small check to
exercise corruption and truncation rejection.

Requirements are Node.js, Python 3, Playwright, and a Chromium browser. The
script uses a locally installed `playwright` package or the sibling
`dataverse-frontend/node_modules/playwright` package. Optional settings:

- `PLAYWRIGHT_MODULE`: path to Playwright's `index.mjs`.
- `BROWSER_EXECUTABLE_PATH`: browser executable; defaults to system Chromium
  when present, otherwise Playwright's managed Chromium.
- `HEADLESS=0`: show the browser; a graphical display or Xvfb is required.
- `SPIKE_URL`: test an already hosted page instead of starting the local server.
- `SPIKE_ARTIFACT_ROOT`: download directory, relative to the repo or absolute.
- `PYTHON`: Python 3 executable.

Download artifacts go into `.smoke-downloads/` on the workspace filesystem and
are removed after each run. Use a real disk for large tests: `/tmp` can be a RAM
filesystem. The script needs room for the downloaded archives and one altered
copy at a time. Headless/automated Chromium is not a replacement for testing the
actual Chrome, Chromium, Edge, Opera, Firefox and Safari versions with their
normal download managers and browser settings.

## Recorded checks — 2026-09-14

Engine build `f5093478233d8b19`, frontend source
`5855877c3c6c2a9fcbf9c8be7ad0a5bc97599047`:

- Build and all five unit tests passed. The copied frontend files and worker
  matched their source hashes.
- Chromium 153.0.8010.36 passed the 64 MiB smoke test locally and on the live
  GitHub Pages site, with both automatic and forced MessageChannel transports.
  Independent ZIP reading and saved-file verification passed; the small checks
  rejected corruption and truncation.
- Chromium passed 5 GiB + 64 MiB ZIP64 downloads with both transports. Each saved
  archive was 5,435,818,422 bytes, including one 5 GiB entry. Independent ZIP
  reading/CRC and the page's full SHA-256/CRC verification passed.
- Firefox 155.0.1 passed a 64 MiB native download, independent ZIP reading/CRC,
  and the page's saved-file verification using transferable streams. Wrong-file
  rejection and recovery after reloading the page were also checked. This was
  a separate WebDriver run, not the Chromium smoke command above.
- Desktop and mobile layouts were visually checked.

A subsequent UI regression check covers changing the memory observation while
saved-file verification is pending. This previously mislabeled the result as
"Test did not pass" even though the verifier kept running. The small Chromium
automatic-transport run passed with the corrected pending label, final saved-ZIP
verification, independent ZIP reading, and corruption/truncation rejection. This
fix does not change the frontend engine or its fingerprint.

The test machine had 128 GiB RAM, so these results establish correctness and
ZIP64 behavior, **not** a successful larger-than-RAM download. Normal-browser
RAM-preset results, Safari, background-tab behavior, sleep/wake, and real server
integration remain separate observations to collect.

## Automatic combined checks — 2026-09-14

Current engine `b247577d88111321`, exact frontend source
`fc73d4eced3f46583012f787973d0f4c437a8c54`, mechanism fingerprint
`5821e415b808e43c`:

- All 18 unit cases passed (5 verifier, 13 scenario cases).
- Chromium 153.0.8010.36 passed the complete automatic sequence in an actual
  hidden tab using standard ChromeDriver under Xvfb, with background-disabling
  switches excluded and default download permissions. The 64 MiB native ZIP
  completed after 721,014 ms and passed independent Python CRC plus the page's
  SHA-256/CRC verification. All five suite checks passed; 714 visibility samples
  were hidden, none visible before completion. This tests lifetime and recovery,
  not a payload larger than RAM.
- Native browser cancellation passed on both transferred streams and forced
  MessageChannel after the frontend cancellation fixes, without unhandled
  rejections. Plain 64 MiB native download, corruption/truncation rejection,
  verification progress labels and the desktop/mobile layouts passed checks.
- Firefox 155 passed the revised internal-consumer preflight, automatic Retry,
  exact 3 MiB resume, 45-second source pause and Stop during the final hold, with
  one native ZIP created and no automatic restart. A complete long run on the
  final helper build is still being verified; this prefix is not an integrity
  pass for an unfinished archive.
- Firefox native download-backend checks confirmed Page Stop stops the download.
  Cancel in the download backend stopped the download immediately but reached
  the frontend only after its pending read resumed, about 47.33 seconds in the
  deliberate quiet scenario. Only one additional 256 KiB chunk was generated.
- **Firefox browser offline/online recovery failed** in a temporary profile:
  five seconds offline during source silence caused the destination stream to
  fail on resumption. The frontend reported the failure and did not claim a
  verified ZIP. This remains a limitation, distinct from retrying synthetic
  HTTP/body failures or testing real Dataverse network requests.

The older chained-timer background fixture was stopped as inconclusive after
Chromium throttled its synthetic source heavily. A native cancellation preflight
was also replaced because it triggered Chrome's multiple-download permission
and blocked the main stream. The current internal consumer avoids that gate
without changing the main ZIP's native download path or granting permissions.

See [interruption automation](INTERRUPTIONS.md) for commands and boundaries.
