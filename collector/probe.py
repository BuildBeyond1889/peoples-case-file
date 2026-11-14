#!/usr/bin/env python3
"""Probe 4: press the KY SOS profile's officer button (full postback) and parse the officers."""
import re, urllib.parse, urllib.request, http.cookiejar
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def get(url, data=None):
    h = {'User-Agent': UA}
    if data: h['Content-Type'] = 'application/x-www-form-urlencoded'
    with op.open(urllib.request.Request(url, data=data, headers=h), timeout=120) as r:
        return r.geturl(), r.read().decode('utf-8', 'replace')
for ctr in ('1307323', '1053155'):
    url = f'https://sosbes.sos.ky.gov/BusSearchNProfile/Profile.aspx/?ctr={ctr}'
    u, prof = get(url)
    btns = re.findall(r'<input type="submit" name="([^"]+)" value="([^"]+)"', prof)
    print('\n###', ctr, u, 'buttons', btns)
    form = {m.group(1): m.group(2) for m in re.finditer(r'<input type="hidden" name="([^"]+)"[^>]*value="([^"]*)"', prof)}
    for name, val in btns:
        if not re.search(r'Officer|Repres|Member|Manager', name + val, re.I):
            continue
        f = dict(form); f[name] = val
        u2, page = get(u, urllib.parse.urlencode(f).encode())
        i = page.find(name.split('$')[-1].replace('Btn', ''))
        txt = re.sub(r'[ \t]+', ' ', re.sub(r'<[^>]+>', ' | ', page))
        j = max(txt.find('Current Officers'), txt.find('Officers'), txt.find('Representatives'))
        print('pressed', name, len(page))
        k = txt.find('Registered Agent')
        print(re.sub(r'(\s*\|\s*)+', ' | ', txt[k:k + 3000]))
