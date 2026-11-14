#!/usr/bin/env python3
"""Site-only deploys: copy the current live data files instead of re-collecting everything."""
import json, os, time, urllib.request
BASE = 'https://buildbeyond1889.github.io/peoples-case-file/data/'
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'site', 'data')
os.makedirs(OUT, exist_ok=True)
def get(name):
    raw = urllib.request.urlopen(urllib.request.Request(f'{BASE}{name}?t={int(time.time())}', headers={'Cache-Control': 'no-cache'}), timeout=120).read()
    open(os.path.join(OUT, name), 'wb').write(raw)
    return raw
idx = json.loads(get('index.json'))
for f in list(idx.get('layers', {}).values()) + ['families.json', 'water.json', 'money.json', 'summary.json']:
    try:
        get(f)
        print('copied', f)
    except Exception as e:
        print('skip', f, repr(e))
