# Streaming download spike

Standalone test page for the streaming zip download design in
IQSS/dataverse-frontend#898. Open the page over HTTPS, pick a size and rate,
and watch the browser's download list: a file that appears early and grows
is streaming; one that appears only when generation ends was buffered.

- A: service worker stream (transferable stream or MessageChannel), keepalive ping, optional early close
- B: OPFS spool (createWritable, or a sync access handle in a worker where that is missing)

`run.mjs` drives the page in Chromium or Firefox on Linux and reports file growth and renderer memory.
