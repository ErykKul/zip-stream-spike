# Automated checks

Run `node scripts/smoke.mjs` from the repository root after rebuilding the
frontend snapshot. It starts a local static server at the same subdirectory
shape as GitHub Pages and opens Chromium. The test:

1. Checks the six small worker protocol variants, then clicks the page's quick check and saves the browser's completed download.
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

- `--firefox`: use Playwright’s managed Firefox (its version is printed; this is
  not automatically the installed system Firefox).
- `--exact-length`, `--hold-worker`, `--transfer-chunks`: enable the corresponding
  native-download comparison settings. Prefer one change at a time for diagnosis.
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

## Protocol-2 validation, 2026-09-15

Frontend `59979b6280e0249815b0763e2289be23f84da76e`, mechanism
`c5d21c7bc3f5ef69`. Initial runs used engine `c470cb8ccfe643d2`; the final
`909b1d8ad8fd66bd` build additionally bounds the internal protocol consumer's
wait. The copied production mechanism is identical in both builds.

- Frontend: 124 focused Cypress tests (78 hook, 38 sink, 8 actual-worker protocol),
  TypeScript, targeted ESLint/Prettier and the standalone production build passed.
- All 18 spike unit cases passed.
- Chromium 153.0.8010.36 saved and verified 64 MiB using automatic transport and
  forced MessageChannel. The six protocol comparisons passed; altered/truncated
  files were rejected. Repeat, Start new test, reload and leaving-page cleanup
  passed. Both transports also saved/verified with exact length, extended worker
  event lifetime and transferred fallback chunks enabled together. These are
  correctness checks, not isolated performance comparisons.
- Firefox 155.0.1, through standard GeckoDriver in isolated headless profiles,
  saved/verified 64 MiB after HTTP/body errors, exact automatic retry and 45-second
  silence. Both transferable streams and MessageChannel passed; the latter also
  enabled the three optional settings. Repeat reached worker completion on both;
  those repeat files were not separately verified. No physical disconnect was
  performed. Playwright's older managed Firefox 141 separately passed both
  transports, protocol checks, damaged-file rejection and session-reset controls.
- Chromium's 5 GiB + 64 MiB ZIP64 check passed independent CRC/ZIP reading and
  page SHA-256/CRC verification: 5,435,818,422 archive bytes, two entries, including
  one larger than 4 GiB.
- The final engine build passed the automatic Chromium small-download check,
  all six protocol comparisons, independent integrity, damaged-file rejection
  and session-reset controls. Desktop/mobile layouts were checked visually.

- Chromium's full RAM-button sequence passed in an actual hidden tab: source
  lifetime 721 seconds, all six suite checks, independent CRC and page SHA-256/CRC
  verified. All 714 visibility samples before completion were hidden. This used
  the initial adapter build, with the same production mechanism as the final
  build. All assertions and the final report completed; the surrounding Xvfb
  shell exited 143 during cleanup.

A compact [validation record](../automation_results/2026-09-15.json) retains
browser versions, options, integrity results and build IDs.

No 35 GiB manual pass, total-memory measurement, Safari/macOS pass or
physical-offline/sleep recovery claim follows from this automation. Eryk later
provided a separate [Safari 17.6 macOS VM 35 GiB pass](../browser_results/README.md);
that manual report uses the final build. Earlier
manual browser reports keep their original source/build identifiers.

## Earlier checks — 2026-09-14

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

Earlier engine `b247577d88111321`, exact frontend source
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
- Forced MessageChannel passed the same complete hidden-tab sequence in a
  separate Chromium profile: 721,012 ms, all five checks and independent CRC plus
  saved-file SHA-256/CRC passed, 714 hidden samples and none visible.
- Firefox 155.0.1 passed the full final sequence in an isolated headless profile:
  720,019 ms source duration, 64 MiB, all five checks, independent Python CRC and
  saved-file SHA-256/CRC verification. Page Stop also passed. This is not a
  Firefox background-tab or larger-than-RAM claim.
- Live GitHub Pages validation in Firefox confirmed the deployed helper/scope,
  internal cancellation, automatic Retry and exact resume, 45-second silence,
  one native ZIP and Stop without restart. No unhandled rejection occurred.
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

## Frontend automatic response-body retries

Frontend `61c6b12451f369efe22cef58a99a24d6b2ded85f`, engine
`87b57ddca34b6944`: the frontend now retries broken or short ranged bodies using
its existing retry limit and delay (three retries, 500 ms by default). The
harness no longer invokes Retry automatically. Suite v2 requires the resumed
offset with no paused/manual-decision state; exhausting retries fails the check.

All 18 unit cases passed. Firefox 155.0.1 and Chromium 153.0.8010.36 verified
64 MiB native ZIPs after the injected HTTP/body failures and 45-second silence,
with independent CRC and page SHA-256/CRC checks, and no Retry action. Chromium
passed both transports, including the separate offline/online, page cancel/leave
guard and native cancellation cases. These are small recovery checks, not a new
larger-than-RAM or full twelve-minute suite result.
