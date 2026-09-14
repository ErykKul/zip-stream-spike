# Bounded interruption diagnostics

The production ZIP hook, sink, and download worker remain byte-for-byte copies of
the frontend. The harness changes the synthetic input to exercise failure paths
with 64 MiB, without repeating a 35 GiB download.

Run the quick Chromium suite from the repository root:

```sh
node scripts/interruptions.mjs
```

It runs the following against automatic transport selection and the forced
MessageChannel path. The expected total is around two to three minutes on an
otherwise idle machine; individual diagnostics have explicit deadlines.

- Inject one HTTP 503 and then a response-body failure after 3 MiB. Click the real
  Retry control, assert that the frontend requests byte offset 3 MiB, wait through
  45 seconds without source bytes, and verify the complete saved ZIP. Verification
  uses both Python's independent ZIP/CRC reader and the page's SHA-256/CRC checks.
- During that source pause, set the browser offline for five seconds and online
  again. This probes the service-worker download transport. The generated source
  stays local, so it does **not** test a real disconnected network request.
- Dismiss the test page's real `beforeunload` dialog, confirm the run remains
  present, then use **Stop test** during a pending source read. Assert that the
  browser's native download fails and the page reports cancellation.
- Cancel through Playwright's native `Download.cancel()` during a pending source
  read. Assert that the native download does not succeed; separately record
  whether the application notices within five seconds. A successful native
  cancellation does not imply that the page also cleaned up promptly.

The suite writes `/tmp/spike-interruptions-report.json` and removes its downloaded
ZIP files. `SPIKE_REPORT` can set another report path. `--automatic-only` and
`--message-channel-only` select one transport; `--native-cancel-only` reruns only
the brief download-manager cancellation checks. Native cancellation must not
produce unhandled Promise rejections; the runner records their reasons and fails
that check if it observes one. `SPIKE_URL` can target the published
page after deployment; omit it for a local server under the same `/zip-stream-spike/`
path as GitHub Pages.

## Complete RAM-button workflow

This exercises the same `startSuite` entry point used by the RAM buttons, with a
64 MiB payload so the automation checks take about 12 minutes. It checks automatic
source cancellation, HTTP and mid-body failures, automatic Retry, exact resumed
offsets, source silence, and a final-chunk hold until the stream has lived for at
least 12 minutes. It verifies the actual saved file afterwards. The automation
has a 15-minute cap and does not establish support for a payload larger than RAM.

```sh
HEADLESS=0 xvfb-run -a node scripts/interruptions.mjs --suite
```

The report goes to `/tmp/spike-suite-report.json`; in-progress state is saved
every 30 seconds. The cancellation assertion requires an abort of the actual
frontend fetch signal during a pending source read, plus an error observed by the
stream consumer. The preflight uses the actual service-worker sink with its
existing navigation seam directed to a controlled-frame fetch consumer. It
creates no native download. The main ZIP uses the normal native download path;
the browser's multiple-download permission is left at its default. Native
download-manager cancellation is checked separately by the quick suite.

The headful mode uses standard ChromeDriver because Playwright enables focus
emulation internally and can keep the document visible even in a background tab.
In a normal desktop session, omit `xvfb-run -a`. ChromeDriver must match the
installed Chromium; set `CHROMEDRIVER` to override `/usr/bin/chromedriver`.
Automatic transport selection is the default; `--message-channel-only` selects
the fallback path.

The runner excludes the driver's background-disabling switches and verifies the
actual browser command line. It opens another tab, asserts that the download page
is hidden, and checks that it stays hidden until download completion. It then
returns to the test page for saved-file verification. Automation remains attached,
so manual results still matter for normal browser policies and OS sleep.

The older `--background` fixture paces 64 MiB using chained synthetic timers.
Chromium's intensive background timer throttling after five minutes can make that
fixture hit its 15-minute deadline even with a working stream. It is retained as a
timer diagnostic, not as the complete browser check. Without `HEADLESS=0`, it uses
Playwright and is only a duration/inactivity check: **a headless run is not
evidence of normal background-tab behavior.** The complete suite avoids chained
source pacing and uses one final hold instead.

The report records source pauses, retry offsets, visibility changes, deadlines,
source cancellation, and final integrity results. A deadline is inconclusive; it
must not be counted as a pass.

## Scope and remaining manual checks

The browser runner checks the spike's navigation guard. Full application and JSF
navigation guards still need their own integration checks. Likewise, synthetic
errors do not establish Dataverse CORS, authentication refresh, presigned URL
expiry, actual server range semantics, or recovery of a real storage connection.
OS sleep and wake also need a manual check; a hidden tab is not equivalent to a
suspended machine.

The runtime uses the system Chromium when available and otherwise Playwright's
managed browser. `BROWSER_EXECUTABLE_PATH`, `PLAYWRIGHT_MODULE`, `PYTHON`,
`SPIKE_ARTIFACT_ROOT`, and `HEADLESS` have the same purpose as in `smoke.mjs`.
No browser flags are used to extend worker lifetimes or disable background
throttling.

## Recorded validation

On 2026-09-14, Chromium 153.0.8010.36/Linux passed native download-manager
cancellation on both transport paths with frontend commit
`fc73d4eced3f46583012f787973d0f4c437a8c54`. The native download stopped, the engine
noticed within about 110 ms, and no unhandled rejection occurred. The check had
previously caught unhandled rejections from client-zip's cancellation adapter;
the frontend fix was verified by rerunning this targeted test.

The same frontend source with harness build `b247577d88111321` passed the complete
suite on both automatic transferable-stream and forced MessageChannel paths,
using separate browser profiles. Each stream lived for 721 seconds in a genuinely
hidden Chromium tab, including an approximately 11-minute final source pause.
Both native 64 MiB archives passed independent ZIP/CRC validation and the page's
SHA-256/CRC verification. Each run recorded 714 hidden visibility samples and zero
visible samples before completion. This is automation evidence with a small
payload, not a larger-than-RAM or manual-browser result.
