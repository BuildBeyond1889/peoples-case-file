#!/usr/bin/env python3
"""Probe 11: ACS table-based summary files (no key) - reachable? size? row format?"""
import urllib.request, re
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
for yr in (2024, 2023):
    base = f'https://www2.census.gov/programs-surveys/acs/summary_file/{yr}/table-based-SF/data/5YRData/'
    try:
        with urllib.request.urlopen(urllib.request.Request(base, headers={'User-Agent': UA}), timeout=60) as r:
            html = r.read().decode('latin-1')
        names = re.findall(r'href="(acsdt5y\d{4}-(?:b01001|c17002)\.dat)"', html)
        print(yr, 'listing ok', names)
        for n in names:
            req = urllib.request.Request(base + n, headers={'User-Agent': UA}, method='HEAD')
            with urllib.request.urlopen(req, timeout=60) as r:
                print('  ', n, r.headers.get('Content-Length'))
            with urllib.request.urlopen(urllib.request.Request(base + n, headers={'User-Agent': UA, 'Range': 'bytes=0-1500'}), timeout=60) as r:
                print('  head:', r.read().decode('latin-1')[:700])
        break
    except Exception as e:
        print(yr, repr(e))
