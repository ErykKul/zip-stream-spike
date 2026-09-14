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
