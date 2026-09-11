# Drives the spike page in the system Firefox or Chromium through Selenium, so the browser's own
# download manager decides what is complete. usage: run_selenium.py <firefox|chromium> <mode> <totalMB> <rateMBs> [keepalive] [transferable] [shortClose]
import json, os, re, subprocess, sys, time
from selenium import webdriver
from selenium.webdriver.firefox.options import Options as FirefoxOptions
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.common.by import By

browser, mode, total_mb, rate = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
keepalive = sys.argv[5] if len(sys.argv) > 5 else '1'
transferable = sys.argv[6] if len(sys.argv) > 6 else '1'
short_close = sys.argv[7] if len(sys.argv) > 7 else '0'
base = os.environ.get('SPIKE_URL', 'http://localhost:8765/')
dl_dir = f'/tmp/claude-1000/spike-dl-{browser}-{mode}-{int(time.time())}'
os.makedirs(dl_dir, exist_ok=True)

if browser == 'firefox':
    opts = FirefoxOptions()
    opts.binary_location = '/usr/bin/firefox'
    for k, v in {
        'browser.download.folderList': 2, 'browser.download.dir': dl_dir, 'browser.download.useDownloadDir': True,
        'browser.download.manager.showWhenStarting': False, 'browser.download.alwaysOpenPanel': False,
        'browser.helperApps.neverAsk.saveToDisk': 'application/octet-stream',
        'browser.download.improvements_to_download_panel': True, 'dom.serviceWorkers.enabled': True,
    }.items():
        opts.set_preference(k, v)
    driver = webdriver.Firefox(options=opts)
else:
    opts = ChromeOptions()
    opts.binary_location = '/usr/bin/chromium'
    opts.add_argument('--no-sandbox')
    opts.add_experimental_option('prefs', {'download.default_directory': dl_dir, 'download.prompt_for_download': False, 'safebrowsing.enabled': False})
    driver = webdriver.Chrome(options=opts)
log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)

def dir_bytes():
    return sum(os.path.getsize(os.path.join(dl_dir, f)) for f in os.listdir(dl_dir))
def content_rss_mb():
    pattern = '-contentproc' if browser == 'firefox' else 'type=renderer'
    out = subprocess.run(f"ps -eo rss,args | grep -F -- '{pattern}' | grep -v grep | awk '{{s+=$1}} END {{print s+0}}'", shell=True, capture_output=True, text=True).stdout.strip()
    return round(int(out or 0) / 1024)
def text(id_):
    try: return driver.find_element(By.ID, id_).text
    except Exception: return '?'

driver.get(base)
for _ in range(60):
    if re.search(r'controlled|failed|no \(', text('swAvail')): break
    time.sleep(0.5)
log('page:', text('swAvail'), '| transferable:', text('xferAvail'), '| opfs:', text('opfsAvail'))

def set_checkbox(id_, on):
    el = driver.find_element(By.ID, id_)
    if el.is_selected() != on: el.click()
driver.execute_script("document.getElementById('totalMb').value = arguments[0]; document.getElementById('rateMbs').value = arguments[1]", total_mb, rate)
set_checkbox('keepalive', keepalive == '1'); set_checkbox('transferable', transferable == '1'); set_checkbox('shortClose', short_close == '1')

driver.find_element(By.ID, 'startOpfs' if mode == 'opfs' else 'startSw').click()
t0 = time.time()
total_bytes = float(total_mb) * 1048576
expected = total_bytes / (float(rate) * 1048576)
abort_at = max(20, expected * 0.3) if mode == 'abort' else float('inf')
aborted = False
first_growth = None
samples = []
while True:
    elapsed = time.time() - t0
    generated = text('opfsBytes' if mode == 'opfs' else 'swBytes')
    status = text('opfsStatus' if mode == 'opfs' else 'swStatus')
    on_disk = dir_bytes()
    files = sorted(os.listdir(dl_dir))
    rss = content_rss_mb()
    samples.append(rss)
    if first_growth is None and on_disk > 0: first_growth = {'elapsed': round(elapsed), 'generated': generated}
    log(f't={round(elapsed)}s generated={generated} onDisk={on_disk/1048576:.1f}MB files={files} contentRSS={rss}MB status="{status}"')
    if not aborted and elapsed >= abort_at:
        driver.find_element(By.ID, 'abortSw').click(); aborted = True; log('ABORT clicked')
    if re.search(r'done|failed|errored|cancelled|download triggered', status) and elapsed > 5: break
    if elapsed > expected + 600: log('giving up'); break
    time.sleep(15)
# let Firefox finalise the file (rename from .part)
time.sleep(5)
files = sorted(os.listdir(dl_dir))
outcome = 'no file' if not files else f'files={files} finalOnDisk={dir_bytes()/1048576:.1f}MB ' + ('(partial file left behind: incomplete or failed)' if any(f.endswith('.part') or f.endswith('.crdownload') for f in files) else '(complete file present)')
log('RESULT', json.dumps({'browser': browser, 'mode': mode, 'totalMB': total_mb, 'rateMBs': rate, 'keepalive': keepalive, 'transferable': transferable, 'shortClose': short_close,
                          'firstGrowth': first_growth, 'outcome': outcome, 'rssMinMB': min(samples), 'rssMaxMB': max(samples)}))
driver.quit()
