#!/usr/bin/env python3
"""Probe 5: public-comment sources (KY DEP pending approvals, KY pending mine permits GIS, Michigan EGLE notices)."""
import json, re, urllib.parse, urllib.request
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
def get(url, data=None, headers=None):
    h = {'User-Agent': UA, **(headers or {})}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=90) as r:
            return r.status, r.geturl(), r.read().decode('utf-8', 'replace')
    except Exception as e:
        return repr(e), url, ''
def txt(h): return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' | ', h))
print('== 1. KY DEP eSearch pending approvals ==')
s, u, h = get('https://dep.gateway.ky.gov/eSearch/Approvals/Pending')
print(s, u, len(h))
print('scripts', re.findall(r'<script[^>]*src="([^"]+)"', h)[:15])
print('forms', re.findall(r'<form[^>]*>', h)[:5])
print('urls in page', sorted(set(re.findall(r'["\'](/[A-Za-z0-9_/\-]*(?:api|Api|Search|search|Pending|Get|Data|data)[A-Za-z0-9_/\-?=&.]*)["\']', h)))[:40])
t = txt(h); i = t.find('Comment'); print(t[max(0, i - 1500):i + 2500])
for src in re.findall(r'<script[^>]*src="([^"]+)"', h):
    if any(k in src.lower() for k in ('jquery', 'bootstrap', 'gtag', 'google', 'modernizr')): continue
    s2, u2, js = get(urllib.parse.urljoin(u, src))
    for m in re.finditer(r'.{0,200}(url\s*:|fetch\(|\$\.(?:get|post|ajax)|/api/|Pending|Approvals).{0,300}', js):
        print('  JS', src, '::', m.group(0)[:500])
print('\n== 2. KY GIS services with Pending ==')
for base in ('https://kygisserver.ky.gov/arcgis/rest/services', 'https://eppcgis.ky.gov/arcgis/rest/services'):
    s, u, h = get(base + '?f=json')
    try:
        j = json.loads(h); folders = j.get('folders', [])
        print(base, 'folders', folders)
        for f in folders:
            if not re.search(r'Mine|WGS84WM|DMP|EEC|Natural', f, re.I): continue
            s, u, h2 = get(f'{base}/{f}?f=json')
            names = [x['name'] for x in json.loads(h2).get('services', [])]
            print('  ', f, [n for n in names if re.search(r'Pend|Permit|Mine|Notice|Applic', n, re.I)])
    except Exception as e:
        print(base, s, e, h[:200])
print('\n== 3. Michigan EGLE public notice calendar ==')
s, u, h = get('https://www.michigan.gov/egle/outreach/public-notice-calendar')
print(s, u, len(h))
print('feeds', re.findall(r'href="([^"]*(?:rss|feed|ics|json|api)[^"]*)"', h, re.I)[:15])
print('data attrs', re.findall(r'data-(?:url|endpoint|api|source|search)[a-z-]*="([^"]+)"', h)[:15])
print('scripts', [x for x in re.findall(r'<script[^>]*src="([^"]+)"', h)][:20])
links = re.findall(r'href="(/egle/outreach/public-notice-calendar/\d{4}/[^"]+)"[^>]*>([^<]*)', h)
print('notice links', len(links), links[:10])
t = txt(h); i = t.find('comment'); print(t[max(0, i - 500):i + 1500])
s, u, h = get('https://www.michigan.gov/egle/outreach/public-notice-calendar/2026/11/09/aqd-pc-mplx')
t = txt(h); i = t.find('public comment period'); print('\nNOTICE PAGE', s, t[max(0, i - 1200):i + 1500])
print('\n== 4. MiEnviro portal ==')
s, u, h = get('https://mienviro.michigan.gov/ncore/external/home')
print(s, u, len(h), re.findall(r'<script[^>]*src="([^"]+)"', h)[:10])
print(sorted(set(re.findall(r'["\'](/ncore/[^"\']+)["\']', h)))[:40])
