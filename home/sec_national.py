#!/usr/bin/env python3
"""People's Case File - national public-company collector (runs on Lu's PC).

SEC blocks GitHub's servers, so this runs at home. Python 3 standard library only.

    python home/sec_national.py            full run (first run: a few hours; weekly after: much less)
    python home/sec_national.py --limit 25 quick test on 25 companies

What it builds, for every US-listed public company (SEC company_tickers_exchange.json):
  - who it is: name, tickers, CIK, industry, state of incorporation, HQ city/state, former names
  - subsidiaries: parsed from the latest annual report's subsidiary list (10-K Exhibit 21; 20-F Exhibit 8)
  - mines: MSHA mine IDs from the latest mine safety disclosure (Exhibit 95)
  - who runs it: directors, officers and 10% owners from insider filings (Forms 3/4/5, SEC bulk data sets)
  - big owners: who filed 5%-owner reports about it (Schedule 13D / 13G)
  - links to the latest annual report and proxy statement (board and pay)
It links all of that to what is already on the map (families by exact name, mines by MSHA ID).

Every raw SEC document it reads is kept on the data drive with a SHA-256 (the project's archive copy).
Output goes to <data_dir>/publish/sec; run.py pushes it to the repo's sec-data branch (data stays out of main),
and the daily site build copies it to site/sec/.

Rules (same as the rest of the project): public records only; companies and officials in their corporate
roles only; never home addresses (insider data sets include street addresses - they are never read);
secretaries / assistants / clerks / organizers stay hidden; every item carries its filing link and dates.
"""
import configparser, csv, ctypes, datetime as dt, hashlib, html, io, json, os, re, sys, time, urllib.error, urllib.request, zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETTINGS = os.environ.get('PCF_SETTINGS') or os.path.join(os.path.dirname(REPO), 'private', 'settings.ini')
LIVE = 'https://buildbeyond1889.github.io/peoples-case-file/data/'
SEC = 'https://www.sec.gov'
TODAY = dt.date.today().isoformat()
HIDE_TITLES = re.compile(r'secretary|assistant|asst|organizer|incorporator|clerk|registered agent', re.I)
SUFFIX = re.compile(r'\b(llc|l\.l\.c|inc|incorporated|co|corp|corporation|company|ltd|limited|lp|llp|plc|the|of|s\.a|sa|ag|nv|bv|gmbh)\b\.?', re.I)


APP_SUFFIX = re.compile(r'\b(llc|l\.l\.c|inc|incorporated|co|corp|corporation|company|ltd|lp|llp|the|of)\b\.?', re.I)


def norm(n):
    return ' '.join(re.findall(r'[a-z0-9]+', SUFFIX.sub(' ', (n or '').lower())))


def norm_app(n):   # the map's own name key (app.js normName), used for local.json
    return ' '.join(re.findall(r'[a-z0-9]+', APP_SUFFIX.sub(' ', (n or '').lower())))


# ---------------------------------------------------------------- settings, logging, keep-awake
def settings():
    if not os.path.exists(SETTINGS):
        sys.exit(f'Missing settings file: {SETTINGS}')
    cp = configparser.ConfigParser()
    cp.read_string('[s]\n' + open(SETTINGS, encoding='utf-8-sig').read())
    s = dict(cp['s'])
    if '@' not in s.get('contact_email', ''):
        sys.exit('Put your contact email in private\\settings.ini (SEC rejects requests without a real one).')
    return s


CFG = settings()
DATA = os.path.join(CFG.get('data_dir') or os.path.join(os.path.dirname(REPO), 'data'), 'sec')
RAW = os.path.join(DATA, 'raw')
OUT = os.path.join(os.path.dirname(DATA), 'publish', 'sec')   # published to the sec-data branch by run.py
for d in (DATA, RAW, os.path.join(DATA, 'logs')):
    os.makedirs(d, exist_ok=True)
UA = 'PeoplesCaseFile ' + CFG['contact_email'].strip()
LOG = open(os.path.join(DATA, 'logs', f'sec-{TODAY}.log'), 'a', encoding='utf-8')


def log(*a):
    line = time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a)
    print(line.encode('ascii', 'replace').decode(), flush=True)
    LOG.write(line + '\n'); LOG.flush()


def keep_awake(on=True):
    if os.name == 'nt':   # Windows: don't sleep mid-run
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | (0x00000001 if on else 0))


# ---------------------------------------------------------------- polite fetching with an on-disk archive
_last = [0.0]
STATS = {'requests': 0, 'cached': 0, 'failed': 0}


def fetch(url, cache=True, tries=5):
    """GET a SEC URL. Cached copies live under RAW (that cache IS the archive). Returns (bytes, meta) or (None, None)."""
    key = re.sub(r'[^A-Za-z0-9._-]+', '_', url.split('://', 1)[1])[-180:]
    path = os.path.join(RAW, key[:2], key)
    if cache and os.path.exists(path):
        STATS['cached'] += 1
        meta = json.load(open(path + '.json')) if os.path.exists(path + '.json') else {}
        return open(path, 'rb').read(), meta
    for i in range(tries):
        wait = 0.125 - (time.time() - _last[0])   # stay at or under 8 requests a second (SEC allows 10)
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate'})
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
                if r.headers.get('Content-Encoding') == 'gzip':
                    import gzip; body = gzip.decompress(body)
            STATS['requests'] += 1
            meta = {'url': url, 'pulled': TODAY, 'sha256': hashlib.sha256(body).hexdigest(), 'bytes': len(body)}
            if cache:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                open(path, 'wb').write(body)
                json.dump(meta, open(path + '.json', 'w'))
            return body, meta
        except urllib.error.HTTPError as e:
            if e.code == 404:
                STATS['failed'] += 1
                return None, None
            pause = 60 if e.code in (403, 429) else 5 * (i + 1)
            log(f'  HTTP {e.code} on {url[:90]} - waiting {pause}s')
            time.sleep(pause)
        except Exception as e:
            log(f'  {type(e).__name__} on {url[:90]} - retrying')
            time.sleep(5 * (i + 1))
    STATS['failed'] += 1
    return None, None


def fetch_json(url, cache=False):
    b, _ = fetch(url, cache=cache)
    try:
        return json.loads(b) if b else None
    except ValueError:
        return None


def download(url, path, max_age_days=6):
    """Big file straight to disk (bulk zips). Skips if a fresh copy exists."""
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < max_age_days * 86400:
        return True
    log('Downloading', url)
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=600) as r, open(path + '.part', 'wb') as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        os.replace(path + '.part', path)
        return True
    except Exception as e:
        log('  download failed:', e)
        return os.path.exists(path)


# ---------------------------------------------------------------- text helpers
def to_text(b):
    t = b.decode('utf-8', 'ignore') if isinstance(b, bytes) else b
    t = re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>', ' ', t)
    return t


def strip_tags(s):
    s = re.sub(r'(?s)<[^>]+>', ' ', s)
    return re.sub(r'\s+', ' ', html.unescape(s)).strip()


US_STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia',
             'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts',
             'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
             'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island',
             'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia',
             'Wisconsin', 'Wyoming', 'District of Columbia', 'Puerto Rico', 'Guam', 'U.S. Virgin Islands']
COUNTRIES = ['United States', 'USA', 'U.S.', 'Canada', 'Mexico', 'Brazil', 'Argentina', 'Chile', 'Colombia', 'Peru', 'United Kingdom',
             'England', 'England and Wales', 'Scotland', 'Wales', 'Northern Ireland', 'Ireland', 'France', 'Germany', 'Netherlands',
             'The Netherlands', 'Belgium', 'Luxembourg', 'Switzerland', 'Austria', 'Italy', 'Spain', 'Portugal', 'Sweden', 'Norway',
             'Denmark', 'Finland', 'Poland', 'Czech Republic', 'Hungary', 'Romania', 'Greece', 'Turkey', 'Israel', 'United Arab Emirates',
             'Saudi Arabia', 'Qatar', 'South Africa', 'Nigeria', 'Kenya', 'Egypt', 'Morocco', 'Ghana', 'India', 'China',
             "People's Republic of China", 'PRC', 'Hong Kong', 'Taiwan', 'Japan', 'Korea', 'South Korea', 'Republic of Korea', 'Singapore',
             'Malaysia', 'Indonesia', 'Thailand', 'Vietnam', 'Philippines', 'Australia', 'New Zealand', 'Cayman Islands', 'Bermuda',
             'British Virgin Islands', 'Bahamas', 'Barbados', 'Jersey', 'Guernsey', 'Isle of Man', 'Gibraltar', 'Malta', 'Cyprus',
             'Mauritius', 'Panama', 'Curacao', 'Liechtenstein', 'Monaco', 'Russia', 'Ukraine', 'Kazakhstan', 'Mongolia', 'Peru',
             'Ecuador', 'Venezuela', 'Uruguay', 'Costa Rica', 'Guatemala', 'Honduras', 'Dominican Republic', 'Jamaica', 'Trinidad and Tobago',
             'Iceland', 'Estonia', 'Latvia', 'Lithuania', 'Slovakia', 'Slovenia', 'Croatia', 'Serbia', 'Bulgaria', 'Pakistan', 'Bangladesh',
             'Sri Lanka', 'Ghana', 'Tanzania', 'Zambia', 'Zimbabwe', 'Botswana', 'Namibia', 'Mozambique', 'Angola', 'Congo',
             'Democratic Republic of the Congo', 'Sudan', 'South Sudan', 'Ethiopia', 'Uganda', 'Rwanda', 'Mali', 'Burkina Faso', 'Guinea',
             'Papua New Guinea', 'Fiji', 'Marshall Islands', 'Liberia', 'Labuan', 'Macau', 'Delaware, USA']
JURS = sorted(set(US_STATES + COUNTRIES), key=len, reverse=True)
JUR_END = re.compile(r'^(.{3,200}?)[\s,;:\-–—\t(]+(?:a |an )?(' + '|'.join(re.escape(j) for j in JURS) +
                     r')(?:\s+(?:corporation|limited liability company|limited partnership|general partnership|partnership|company|trust|statutory trust))?\s*\)?\s*[.;]?\s*$', re.I)
PAREN = re.compile(r'^(.{3,200}?)\s*\(([^()]{2,60})\)\s*[.;]?$')
HEADERS = re.compile(r'^(name|names|subsidiar|jurisdiction|state or|state of|place of|country|exhibit|list of|significant|percent|%|ownership|'
                     r'wholly|entity|entities|legal name|company name|organized|incorporat|the following|registrant|page|\d+$|\*|note|domestic|foreign|'
                     r'as of|parent|owned|directly|indirectly|all of the|other subsidiar|omitted|pursuant)', re.I)


def parse_subsidiaries(raw):
    """Best-effort reading of an Exhibit 21 / Exhibit 8 subsidiary list. Returns [{n: name, j: jurisdiction}]."""
    t = to_text(raw)
    rows = []
    if re.search(r'(?i)<tr', t):
        for tr in re.findall(r'(?is)<tr[^>]*>(.*?)</tr>', t):
            cells = [strip_tags(c) for c in re.findall(r'(?is)<t[dh][^>]*>(.*?)</t[dh]>', tr)]
            cells = [c for c in cells if c and not re.fullmatch(r'[\d.%\s()*†‡]+', c)]
            if cells:
                rows.append(cells)
        t = re.sub(r'(?is)<table.*?</table>', '\n', t)
    t = re.sub(r'(?i)<br\s*/?>|</(p|div|li|h\d)>', '\n', t)
    for line in strip_tags_lines(t):
        rows.append([line])
    out, seen = [], set()
    for cells in rows:
        name, jur = cells[0], (cells[-1] if len(cells) > 1 else '')
        if len(cells) == 1:
            m = PAREN.match(name) or JUR_END.match(name)
            if m:
                name, jur = m.group(1), m.group(2)
        name = re.sub(r'^[\s\-•·*\d.)]+(?=[A-Za-z])', '', name).strip(' ,;:-–—*')
        name = re.sub(r'\s*\(?\d{1,3}(\.\d+)?%\)?.*$', '', name).strip(' ,;:')
        jur = re.sub(r'\s*\d{1,3}(\.\d+)?%.*$', '', jur).strip(' ,;:()')
        if len(jur) > 60 or jur == name:
            jur = ''
        if not (3 <= len(name) <= 160) or not re.search(r'[A-Za-z]{2}', name) or HEADERS.match(name):
            continue
        if len(name.split()) > 14:   # a sentence, not a company name
            continue
        k = norm(name)
        if not k or k in seen:
            continue
        seen.add(k)
        out.append({'n': name, 'j': jur} if jur else {'n': name})
    return out[:4000]


def strip_tags_lines(t):
    for ln in re.sub(r'(?s)<[^>]+>', ' ', t).split('\n'):
        ln = re.sub(r'\s+', ' ', html.unescape(ln)).strip()
        if ln:
            yield ln


MINE_ID = re.compile(r'(?<![\d$.,-])(\d{2})-?(\d{5})(?![\d,.%-])')


def parse_mine_ids(raw):
    t = strip_tags(to_text(raw))
    if not re.search(r'(?i)msha|mine safety|mine id', t):
        return []
    ids = {a + b for a, b in MINE_ID.findall(t) if 1 <= int(a) <= 56}
    return sorted(ids)


def filing_index(cik, acc):
    """Documents in one filing: [(type, url, description)] plus the filer/subject names from the index page."""
    url = f'{SEC}/Archives/edgar/data/{int(cik)}/{acc.replace("-", "")}/{acc}-index.htm'
    b, _ = fetch(url)
    if not b:
        return [], {}, url
    t = b.decode('utf-8', 'ignore')
    docs = []
    for tr in re.findall(r'(?is)<tr[^>]*>(.*?)</tr>', t):
        tds = re.findall(r'(?is)<td[^>]*>(.*?)</td>', tr)
        a = re.search(r'href="([^"]+)"', tr)
        if len(tds) >= 4 and a:
            docs.append((strip_tags(tds[3]).upper(), SEC + a.group(1).replace('/ix?doc=', ''), strip_tags(tds[1])))
    names = {}
    for nm, role in re.findall(r'(?is)<span class="companyName">\s*(.*?)\s*\((Filed by|Subject|Reporting|Filer|Issuer)\)', t):
        names.setdefault(role.lower(), []).append(strip_tags(re.sub(r'(?is)<a.*', '', nm)))
    return docs, names, url


# ---------------------------------------------------------------- the companies
def company_list(limit=None):
    j = fetch_json(f'{SEC}/files/company_tickers_exchange.json')
    if not j:
        sys.exit('Could not read the SEC company list. Check the email in settings.ini and your internet.')
    f = j['fields']
    cos = {}
    for row in j['data']:
        r = dict(zip(f, row))
        c = cos.setdefault(int(r['cik']), {'cik': int(r['cik']), 'name': r['name'], 'tickers': [], 'exchanges': []})
        if r.get('ticker') and r['ticker'] not in c['tickers']:
            c['tickers'].append(r['ticker'])
        if r.get('exchange') and r['exchange'] not in c['exchanges']:
            c['exchanges'].append(r['exchange'])
    out = sorted(cos.values(), key=lambda c: c['cik'])
    return out[:limit] if limit else out


def submissions(ciks, use_zip):
    """CIK -> submissions JSON, from SEC's nightly bulk zip (or one request per company for small test runs)."""
    zpath = os.path.join(DATA, 'submissions.zip')
    if use_zip and download(f'{SEC}/Archives/edgar/daily-index/bulkdata/submissions.zip', zpath):
        z = zipfile.ZipFile(zpath)
        names = set(z.namelist())
        for cik in ciks:
            n = f'CIK{cik:010d}.json'
            if n in names:
                yield cik, json.loads(z.read(n))
        return
    for cik in ciks:
        yield cik, fetch_json(f'https://data.sec.gov/submissions/CIK{cik:010d}.json')


def recent(sub):
    r = (sub.get('filings') or {}).get('recent') or {}
    keys = ['accessionNumber', 'filingDate', 'form', 'primaryDocument', 'reportDate']
    return [dict(zip(keys, v)) for v in zip(*[r.get(k, []) for k in keys])]


def doc_url(cik, f):
    return f'{SEC}/Archives/edgar/data/{int(cik)}/{f["accessionNumber"].replace("-", "")}/{f["primaryDocument"]}'


def src(url, filed, meta=None, **kw):
    s = {'url': url, 'filed': filed, 'pulled': (meta or {}).get('pulled', TODAY)}
    if meta and meta.get('sha256'):
        s['sha256'] = meta['sha256']
    s.update(kw)
    return s


ANNUAL = {'10-K': ('EX-21',), '10-K405': ('EX-21',), '10-KT': ('EX-21',), '20-F': ('EX-8',)}
OWNER_FORMS = re.compile(r'^(SC 13[DG]|SCHEDULE 13[DG])(/A)?$')


def build_company(c, sub, insiders):
    fil = recent(sub)
    biz = ((sub.get('addresses') or {}).get('business') or {})
    co = {'cik': c['cik'], 'name': sub.get('name') or c['name'], 'tickers': c['tickers'], 'exchanges': c['exchanges'],
          'sic': sub.get('sic'), 'industry': sub.get('sicDescription'), 'inc': sub.get('stateOfIncorporationDescription') or sub.get('stateOfIncorporation'),
          'hq': ', '.join(x for x in (biz.get('city'), biz.get('stateOrCountryDescription') or biz.get('stateOrCountry')) if x),
          'former': [{'name': f['name'], 'from': (f.get('from') or '')[:10], 'to': (f.get('to') or '')[:10]} for f in (sub.get('formerNames') or [])][:15],
          'edgar': f'{SEC}/cgi-bin/browse-edgar?action=getcompany&CIK={c["cik"]}'}
    # latest annual report -> subsidiaries + mines
    annual = next((f for f in fil if f['form'] in ANNUAL), None)
    if annual:
        co['annual'] = src(doc_url(c['cik'], annual), annual['filingDate'], form=annual['form'], period=annual.get('reportDate'))
        docs, _, idx = filing_index(c['cik'], annual['accessionNumber'])
        for typ, url, _desc in docs:
            if typ.startswith(ANNUAL[annual['form']]) and 'subs' not in co and not url.lower().endswith(('.jpg', '.gif', '.pdf')):
                b, meta = fetch(url)
                subs = parse_subsidiaries(b) if b else []
                if subs:
                    co['subs'] = subs
                    co['subs_src'] = src(url, annual['filingDate'], meta, form=annual['form'], exhibit=typ, index=idx)
            if typ.startswith('EX-95') and 'mines' not in co:
                b, meta = fetch(url)
                ids = parse_mine_ids(b) if b else []
                if ids:
                    co['mines'] = ids
                    co['mines_src'] = src(url, annual['filingDate'], meta, form=annual['form'], exhibit=typ)
    # proxy statement (board, pay)
    proxy = next((f for f in fil if f['form'] in ('DEF 14A', 'DEFA14A')), None)
    if proxy:
        co['proxy'] = src(doc_url(c['cik'], proxy), proxy['filingDate'], form=proxy['form'])
    # 5% owner reports about this company (last 3 years, newest 25)
    since = (dt.date.today() - dt.timedelta(days=3 * 365)).isoformat()
    owners = {}
    for f in [f for f in fil if OWNER_FORMS.match(f['form']) and f['filingDate'] >= since][:25]:
        _, names, idx = filing_index(c['cik'], f['accessionNumber'])
        for nm in names.get('filed by', []) + names.get('reporting', []) + names.get('filer', []):
            if norm(nm) == norm(co['name']):
                continue
            o = owners.setdefault(norm(nm), {'name': nm, 'filings': 0, 'first': f['filingDate'], 'last': f['filingDate'], 'form': f['form'], 'url': idx})
            o['filings'] += 1
            o['first'] = min(o['first'], f['filingDate'])
            if f['filingDate'] >= o['last']:
                o.update(last=f['filingDate'], form=f['form'], url=idx)
    if owners:
        co['owners'] = sorted(owners.values(), key=lambda o: o['last'], reverse=True)
    # insiders (bulk data sets)
    ins = insiders.get(c['cik'])
    if ins:
        co['people'] = sorted(ins.values(), key=lambda p: (not p['director'], not p['officer'], p['last']), reverse=False)
        co['people'].sort(key=lambda p: p['last'], reverse=True)
        co['people'].sort(key=lambda p: (0 if p['officer'] or p['director'] else 1))
    co['checked'] = TODAY
    return co


# ---------------------------------------------------------------- insiders from SEC's Form 3/4/5 data sets
def quarters(n=5):
    d = dt.date.today()
    y, q = d.year, (d.month - 1) // 3 + 1
    out = []
    for _ in range(n + 1):
        q -= 1
        if q == 0:
            y, q = y - 1, 4
        out.append(f'{y}q{q}')
    return out


def insiders(ciks):
    """issuer CIK -> {person key: {...}} from the last ~5 quarters of Forms 3/4/5. Street addresses are never read."""
    want = set(ciks)
    people = {}
    got = 0
    for qq in quarters():
        zp = os.path.join(DATA, f'{qq}_form345.zip')
        if not download(f'{SEC}/files/structureddata/data/form-345-data-sets/{qq}_form345.zip', zp, max_age_days=3650):
            log('  no insider data set for', qq)
            continue
        try:
            z = zipfile.ZipFile(zp)
        except zipfile.BadZipFile:
            os.remove(zp); continue
        got += 1
        inner = {os.path.basename(n).upper(): n for n in z.namelist()}
        subm = {}
        with z.open(inner['SUBMISSION.TSV']) as fh:
            for r in csv.DictReader(io.TextIOWrapper(fh, 'utf-8', 'ignore'), delimiter='\t'):
                try:
                    ic = int(r.get('ISSUERCIK') or 0)
                except ValueError:
                    continue
                if ic in want:
                    subm[r['ACCESSION_NUMBER']] = (ic, sec_date(r.get('FILING_DATE')), r.get('DOCUMENT_TYPE'))
        with z.open(inner['REPORTINGOWNER.TSV']) as fh:
            for r in csv.DictReader(io.TextIOWrapper(fh, 'utf-8', 'ignore'), delimiter='\t'):
                s = subm.get(r['ACCESSION_NUMBER'])
                if not s:
                    continue
                ic, filed, form = s
                rel = (r.get('RPTOWNER_RELATIONSHIP') or '').lower()
                title = (r.get('RPTOWNER_TITLE') or '').strip()
                if HIDE_TITLES.search(title) and 'director' not in rel and not re.search(r'chief|president|ceo|cfo|coo|chair', title, re.I):
                    continue
                key = r.get('RPTOWNERCIK') or norm(r.get('RPTOWNERNAME'))
                p = people.setdefault(ic, {}).setdefault(key, {'name': r.get('RPTOWNERNAME', '').strip(), 'director': False, 'officer': False,
                                                              'owner10': False, 'title': '', 'first': filed, 'last': filed, 'filings': 0})
                p['director'] |= 'director' in rel
                p['officer'] |= 'officer' in rel
                p['owner10'] |= 'ten' in rel or '10' in rel
                p['filings'] += 1
                p['first'] = min(p['first'], filed)
                if filed >= p['last']:
                    p['last'] = filed
                    p['form'] = form
                    p['url'] = f'{SEC}/Archives/edgar/data/{ic}/{r["ACCESSION_NUMBER"].replace("-", "")}/{r["ACCESSION_NUMBER"]}-index.htm'
                    if title and not HIDE_TITLES.search(title):
                        p['title'] = title
    log(f'  insider data sets read: {got}; companies with insiders: {len(people)}')
    return people


def sec_date(s):
    for fmt in ('%d-%b-%Y', '%Y-%m-%d', '%m/%d/%Y'):
        try:
            return dt.datetime.strptime((s or '').strip().title(), fmt).date().isoformat()
        except ValueError:
            pass
    return (s or '')[:10]


# ---------------------------------------------------------------- output
def write_if_changed(path, obj):
    data = json.dumps(obj, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    if os.path.exists(path) and open(path, encoding='utf-8').read() == data:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'w', encoding='utf-8').write(data)
    return True


def shard(k):
    k = k.replace(' ', '')
    return (k[:2] if len(k) >= 2 else (k + '_'))[:2]


def main():
    args = sys.argv[1:]
    limit = int(args[args.index('--limit') + 1]) if '--limit' in args else None
    keep_awake(True)
    t0 = time.time()
    log(f'=== SEC national run {TODAY}{" (test: " + str(limit) + " companies)" if limit else ""}. Data folder: {DATA}')
    cos = company_list(limit)
    log(f'{len(cos)} listed companies')
    ins = insiders([c['cik'] for c in cos])
    by_cik = {c['cik']: c for c in cos}
    index, subidx, mines, changed, done = [], {}, {}, 0, 0
    for cik, sub in submissions(list(by_cik), use_zip=not limit):
        if not sub:
            continue
        try:
            co = build_company(by_cik[cik], sub, ins)
        except Exception as e:
            log(f'  skipped CIK {cik}: {type(e).__name__} {e}')
            continue
        changed += write_if_changed(os.path.join(OUT, 'c', f'{cik}.json'), co)
        index.append([cik, co['name'], ' '.join(co['tickers']), co.get('hq', ''), co.get('industry') or '',
                      len(co.get('subs', [])), len(co.get('mines', [])), len(co.get('people', []))])
        for s in co.get('subs', []):
            k = norm(s['n'])
            if len(k) >= 3:
                subidx.setdefault(shard(k), {}).setdefault(k, []).append([s['n'], cik, co['name']])
        for m in co.get('mines', []):
            mines.setdefault(m, []).append({'company': co['name'], 'cik': cik, 'form': co['mines_src']['form'],
                                            'filed': co['mines_src']['filed'], 'url': co['mines_src']['url']})
        done += 1
        if done % 100 == 0:
            el = (time.time() - t0) / 60
            log(f'  {done}/{len(cos)} companies · {el:.0f} min · {STATS["requests"]} requests, {STATS["cached"]} from archive')
    for k, v in subidx.items():
        write_if_changed(os.path.join(OUT, 's', f'{k}.json'), v)
    write_if_changed(os.path.join(OUT, 'index.json'), index)
    write_if_changed(os.path.join(OUT, 'mines.json'), mines)
    # our map's families: which public companies list them as subsidiaries (same shape as the old manual sec.json)
    local = {'as_of': TODAY, 'source': 'SEC EDGAR: latest annual-report subsidiary lists (Exhibit 21 / 20-F Exhibit 8) and mine safety disclosures (Exhibit 95)',
             'rules': 'Exhibit 21: exact normalized-name match against the parsed subsidiary list. Exhibit 95: the MSHA mine ID appears in the disclosure.',
             'by_name': {}, 'by_mine': mines}
    fams = fetch_json(LIVE + 'families.json') or []
    for f in fams:
        for n in [f.get('controller')] + [o.get('name') for o in f.get('operators', [])]:
            k = norm(n)
            for subname, cik, coname in (subidx.get(shard(k), {}).get(k, []) if k and len(k) > 4 else []):
                cs = json.load(open(os.path.join(OUT, 'c', f'{cik}.json'), encoding='utf-8'))['subs_src']
                e = local['by_name'].setdefault(norm_app(n), {'name': n, 'listed_by': []})
                if not any(x['cik'] == cik for x in e['listed_by']):
                    e['listed_by'].append({'company': coname, 'cik': cik, 'form': cs['form'], 'exhibit': cs['exhibit'], 'filed': cs['filed'], 'url': cs['url']})
    write_if_changed(os.path.join(OUT, 'local.json'), local)
    meta = {'as_of': TODAY, 'companies': len(index), 'with_subsidiaries': sum(1 for r in index if r[5]),
            'subsidiaries': sum(r[5] for r in index), 'with_mines': sum(1 for r in index if r[6]), 'with_people': sum(1 for r in index if r[7]),
            'map_families_listed': len(local['by_name']), 'test_run': bool(limit), 'minutes': round((time.time() - t0) / 60),
            'requests': STATS['requests'], 'from_archive': STATS['cached'], 'failed': STATS['failed']}
    write_if_changed(os.path.join(OUT, 'meta.json'), meta)
    log('DONE', json.dumps(meta))
    keep_awake(False)


if __name__ == '__main__':
    main()
