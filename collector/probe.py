#!/usr/bin/env python3
"""Probe 3: how the KY SOS profile loads officers; how search rows link to profiles."""
import re, urllib.parse, urllib.request, http.cookiejar
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def get(url, data=None, ct='application/x-www-form-urlencoded'):
    h = {'User-Agent': UA}
    if data: h['Content-Type'] = ct
    with op.open(urllib.request.Request(url, data=data, headers=h), timeout=120) as r:
        return r.geturl(), r.read().decode('utf-8', 'replace')
u, prof = get('https://sosbes.sos.ky.gov/BusSearchNProfile/Profile.aspx?ctr=1053155')
for m in re.finditer(r'<script[^>]*>(.*?)</script>', prof, re.S):
    s = m.group(1)
    if re.search(r'asmx|ajax|fetch\(|WebMethod|Officer|Representative|ctr', s, re.I):
        print('--- inline script ---'); print(s[:4000])
for src in re.findall(r'<script[^>]*src="([^"]+)"', prof):
    print('script src', src)
    if 'jquery' in src.lower() or 'bootstrap' in src.lower() or 'googletag' in src: continue
    try:
        u2, js = get(urllib.parse.urljoin(u, src))
        for mm in re.finditer(r'.{0,300}(asmx|ajax|Officer|Representative).{0,500}', js, re.I):
            print('   JS:', mm.group(0)[:800])
    except Exception as e:
        print('   fail', e)
i = prof.find('Loading...')
print('--- html near Loading ---'); print(prof[i - 2500:i + 600])
S = 'https://sosbes.sos.ky.gov/BusSearchNProfile/search.aspx'
u, html = get(S)
form = {m.group(1): m.group(2) for m in re.finditer(r'<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"', html)}
form.update({'ctl00$MainContent$ddlSearchBy': 'Business Name or Organization Number', 'ctl00$MainContent$txtSearch': 'Bluegrass Natural Resources', 'ctl00$MainContent$BSearch': 'Search'})
u, res = get(S, urllib.parse.urlencode(form).encode())
i = res.find('BLUEGRASS NATURAL RESOURCES LLC')
print('--- search row html ---'); print(res[i - 1500:i + 400])
