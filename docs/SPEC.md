# People's Case File: full spec

Lu said it's "exactly what I am talking about". ★ marks Lu's selections.

**One line:** law-firm-grade case prep, free, for anyone trying to figure out what's going on where they live.

**Who it's for (Lu's three users):**
- **A Flint resident:** "is my water safe, who decided this, who profits?"
- **A Harlan County, KY resident:** coal mines, slurry, water-system violations, who owns the mine and who regulates it.
- **An associate lawyer at an environmental firm:** needs the same evidence fast, with citations that hold up.

It has to be easy enough for the first two and deep enough for the third. One app with two depths: **Simple** (plain answers, big buttons) and **Pro** (every record, filters, exports, citations).

**Where it came from:** Lu asked whether a Meta-kids-case-style "Senate-level" case workup was possible. That's the professional version. Then he broadened it: "imagine if the townspeople in Flint could have access and see where the companies are."

### Features (everything someone could think of)
1. **My address → what's around me:**
   - facilities, permits, violations, toxic releases
   - water system violations and test results
   - mines, wells, pipelines, waste sites
   - who owns each one and who operates it
2. **EJ score (our own EJScreen):** see the section below.
3. **Decision trail:** meeting minutes, agency decisions, public emails and court filings in one timeline.
4. **FOIA / records-request generator:** picks the right agency and drafts the letter. It tracks deadlines and reminds you when a response is due.
5. **Follow the money:**
   - public contracts
   - campaign donations and lobbying
   - corporate parents (SEC filings, OpenCorporates)
   - fines paid vs. profits
6. **Contradiction finder:** what they said publicly vs. what the records show, each with a source and date.
7. **Satellite layers (from Ground Truth):** spills, mining expansion, smoke, flaring and methane plumes, before/after imagery.
8. **Neighbor reports (Ushahidi):** smells, rashes, brown water, dead fish, pinned and dated with photos. Shows patterns across the town.
9. **Health overlay:** CDC PLACES county/tract health estimates, cancer registry data where public, blood-lead data where public.
10. **Prediction:** e.g. a lead-pipe likelihood model (University of Michigan did this for Flint), or flood and contamination risk.
11. **Ask it anything:** plain-English questions answered only from the records, with every sentence cited.
12. **Evidence pack export:** chronology, maps, records and sources as a PDF or zip, for a journalist, a lawyer, an attorney general or a council meeting.
13. **Self-archive:** keeps its own copies of government data, because data disappears (EJScreen, Jan–Feb 2025).
14. **Watch my area:** alerts when a new permit, violation, spill or lawsuit appears near you.
15. **Organize:** share a case file with neighbors, assign tasks (who requests what), and comment on the timeline.
16. **Pro tools:**
    - docket search (CourtListener/RECAP, PACER)
    - entity graph (company ↔ subsidiary ↔ facility ↔ official)
    - damages helpers
    - Bluebook-style citation export
    - a research memo draft

### Data sources (all public)
- **EPA, ECHO:** enforcement and compliance for every regulated facility, with an API.
- **EPA:** TRI (toxic releases), SDWIS (drinking water violations), FRS (facility IDs), RCRAInfo, Superfund/SEMS, AirToxScreen, AirNow.
- **Census ACS:** income and demographics by block group.
- **CDC:** PLACES and SVI.
- **Mining:**
  - MSHA Mine Data Retrieval System (mines, operators, violations, accidents)
  - OSMRE plus state surface-mining permits (key for Harlan County)
- **Oil and gas:** state oil and gas well databases; PHMSA pipeline incidents.
- **Money:** USAspending (federal contracts), state contract portals, FEC and state campaign finance, Senate LDA lobbying filings, SEC EDGAR.
- **Courts:** CourtListener/RECAP, state court portals.
- **Space:** Sentinel-1/2, Landsat, NASA FIRMS, Carbon Mapper.
- **Archives:**
  - Wayback Machine
  - Public Environmental Data Partners (screening-tools.com: EJScreen, CEJST, EJAM, HIFLD Next)
  - Yale EJScreen mirror

### EJScreen: replacement vs. building our own
- **What happened:** EPA took EJScreen offline in early 2025.
- **Who rebuilt it:** Public Environmental Data Partners (PEDP: EDGI, Harvard EELP and others) rebuilt it at screening-tools.com, along with CEJST (v2.1 launched March 24, 2026), EJAM and HIFLD Next. Yale hosts a mirror.
- **New efforts:** the Environmental & Health Data Analysis Trust (EHDAT), co-led by former EPA EJScreen developers, is building new tools.
- **The catch:** these are frozen copies of the last EPA data. The model is 10+ years old, national-only, and uses income thresholds that can make poor neighborhoods in costly cities look fine. It also has no lived-experience layer.
- **Building our own is doable.** EJScreen is a formula over public inputs: each block group's environmental-indicator percentile combined with its demographic index (low income + people of color).
  - **About 13 indicators:** PM2.5, ozone, diesel PM, air-toxics cancer risk, respiratory hazard, traffic proximity, lead paint (pre-1960 housing), Superfund proximity, RMP-facility proximity, hazardous-waste proximity, underground storage tanks, wastewater discharge, drinking-water noncompliance.
  - **How to make it better:**
    - fresher data, pulled automatically
    - local cost-of-living income thresholds
    - add water violations, mines, wells and pipelines
    - add residents' reports
    - show the formula and let pros change the weights
    - open-source everything
    - mirror the inputs so they can't be taken down
- **Name idea:** "Open EJ Score". Never present it as EPA's.

### Guardrails (non-negotiable)
- Public records only.
- Companies and officials in their public roles only. Private individuals are never profiled, and no addresses of private people.
- Every claim has a source, date and confidence. Say "linked to", never "did this".
- Health data is estimates, not diagnoses. "Not legal advice" for residents, plus a "talk to a lawyer / legal aid" button.

### Verified context (Nov 2026)
- **Flint:**
  - the 2014–15 river switch without corrosion control
  - Dr. Mona Hanna-Attisha's blood-lead finding
  - the $626M settlement approved Nov 10, 2021 (~80% for children)
- **Meta youth cases:**
  - New Mexico jury verdict, $375M (Mar 2026)
  - LA jury, $6M vs. Meta and Google (Mar 2026)
  - federal trial in Oakland from Aug 18, 2026 (Judge Yvonne Gonzalez Rogers)

### Mockups
- Phone and laptop screens were made in a Claude Design artifact titled "People's Case File".

### Product shape (Lu, Nov 13 2026)
- **Website first.** The main product is a website; the phone version is the same site installed as a web app (PWA), like Sky Watch.
- **The map is the front door.** Like Google Maps but for accountability: open it anywhere and it loads what's around you, or anywhere you pan, and keeps updating itself.
  - **Library:** MapLibre + OpenStreetMap. Google Maps' API costs money, needs a key, and its terms limit storing data.
  - **Satellite tiles:** free imagery (Esri World Imagery, EOX Sentinel-2 cloudless).
- **Lu's top priority:** the info being right, and gathering as much new AND old material as possible.

### Data engine (how to get it right and get everything)
- **A collector that runs on its own**, e.g. GitHub Actions on a schedule:
  - pulls every source and saves dated snapshots
  - publishes clean files the website reads
- **Why a collector:**
  - It avoids browser CORS blocks.
  - It keeps history even if an agency deletes data.
  - Every refresh adds to our own archive.
- **New (live) sources:**
  - ECHO, TRI, SDWIS, AirNow, PurpleAir community air sensors
  - NASA FIRMS fires; Sentinel-2 every ~5 days
  - state permit notices; court dockets (CourtListener)
  - local news (GDELT); FOIA results (MuckRock)
- **Old (history) sources:**
  - **Land and maps:**
    - Sanborn fire-insurance maps (Library of Congress): old factories, tanneries and gas plants on every block, 1867–1970
    - USGS historical topo maps
    - USGS historical aerial photos
    - Landsat imagery since 1972
  - **Records:**
    - TRI since 1987; ECHO enforcement history
    - old newspapers: Chronicling America (to 1963), plus local library archives
    - the Wayback Machine since 1996
    - old EPA reports and Superfund records of decision
    - MSHA history since the 1970s
- **Accuracy rules:**
  - **Join records by official IDs**, not names: EPA FRS registry ID, MSHA mine ID, PWSID for water systems, SEC CIK.
  - **Every fact keeps** its source link, the date published, the date we pulled it, and an archived copy.
  - **Confidence:**
    - high = an official record
    - medium = two independent sources agree
    - low = a single unofficial source
  - **Disagreements stay visible:** when sources conflict, show both. Never silently pick one.
  - **AI only summarizes or searches stored records,** and every sentence links to its record. It never adds facts.
  - **Freshness stamps** on every panel, plus a "report an error" button.

### Ways to make it better: the full list (Lu: "suggest everything")
Status: concept only. Lu likes the mockups and doesn't want building yet.

**★ LU'S SELECTIONS (Nov 13 2026):**
- **Corporate tree ("definitely"):** both the case-specific tree and a tree of every corporation on the planet.
- **Picked:** all of section 1, all of section 4 ("for fucking sure"), section 5 and section 7 ("for sure").
- **Not picked (kept for later):** sections 2, 3 and 6.

**★★ Corporate tree, the headline feature (Lu: "definitely")**
- **Two views of one engine:**
  - **Case tree:** for whatever is being worked on (a town, a facility, a lawsuit). It shows only the companies, parents, subsidiaries, contractors, officials in their public roles, donors and lobbyists connected to it, with every link sourced.
  - **World tree:** every company on the planet that has public records. Search any company to see its parents, subsidiaries, sister companies, facilities, violations, lawsuits, sanctions and the money around it.
- **Sources (all public):**
  - **GLEIF LEI:** about 2.9M+ legal entities worldwide, free, with "who owns whom" parent data, the backbone.
  - **OpenCorporates:** 200M+ companies from 140+ registries, free for public-benefit use.
  - **SEC EDGAR:** 10-K Exhibit 21 subsidiary lists; 13D/13G large owners.
  - **UK Companies House:** persons with significant control.
  - **Open Ownership register;** EU and other national beneficial-ownership registers where public.
  - **Wikidata** for big groups.
  - **ICIJ Offshore Leaks database (public):** match on companies only, labelled as such.
  - **Sanctions lists:** OFAC, UN, EU, via OpenSanctions.
  - **EPA FRS**, linking facilities to their owner and operator.
  - **MSHA:** mine operators and controllers.
- **How it stays accurate:**
  - **Match on official IDs:** LEI, CIK, company numbers, FRS IDs.
  - **Every edge has** a source, a date, "as of", and confidence.
  - **Ownership changes over time:** a timeline per company shows who owned it when (crucial for "who owned the mine when the spill happened").
  - **Flags:**
    - shells (no employees, shared registered agent)
    - name changes, sudden asset transfers, and bankruptcies used to shed liabilities
  - **People:** only officers and directors as listed in official filings, in their corporate role. No home addresses, no private life.
- **Analysis on top:**
  - total violations, fines and releases rolled up to the parent ("Sample Corp's 41 facilities: 312 violations")
  - parent revenue vs. penalties
  - lawsuits across the whole family
  - the same parent appearing in other towns' cases, which connects communities fighting the same company

**1. Better analysis (the info is the product) ★ SELECTED: ALL**
- **Corporate family tree:** see ★★ above.
  - Link facility → operator → parent.
  - Flag shell companies and bankruptcies used to dump cleanup costs (big in coal).
- **Silence detector:**
  - facilities that stopped filing required reports
  - regulators that haven't inspected in years
  - violations that were never fined
  - permits that expired but keep running ("zombie permits")
- **Self-reports vs. reality:** compare what a company reports with satellite readings (NO₂ from TROPOMI, methane from Carbon Mapper), nearby sensors and residents' reports.
- **Satellite change detection:** new ponds, slurry impoundments, clearing, spills and flaring, with before/after.
- **Follow the water:** trace upstream of your water intake or creek (USGS NHDPlus) to see what drains into it.
- **Follow the air:** which facilities sit upwind of you on typical days.
- **Fines vs. profits:** penalties next to company revenue (SEC). Mine reclamation bonds vs. the real cleanup cost (OSMRE).
- **Money timing:** donations and lobbying lined up against permit and enforcement decisions, shown as timing only, never as proof.
- **Compare me:** this town vs. similar towns, the state and the country.
- **Health overlay:** shows that things happen in the same place, never that one caused the other. Methods reviewed by an epidemiologist.
- **Uncertainty:** shown on every number. A public methods page; academics invited to check it.

**2. Gather more (new and old)** (not selected yet; kept)
- **Time slider (like Sky Watch Deep Time):** watch a neighborhood from 1867 to today.
  - **Map layers:** old fire-insurance maps (Sanborn), old aerial photos, satellite images since 1972.
  - **Redlining:** 1930s HOLC redlining maps (Mapping Inequality, University of Richmond).
  - **"What used to be here" (AI):** traces old factory and gas-plant footprints off the Sanborn sheets.
- **Scan days:** residents bring boxes of old papers, letters and photos to the library, and they get scanned into the town's archive with consent.
- **Oral histories:** record elders' memories (Harlan, Flint) as voice notes, transcribed, with consent and credit.
- **Community testing:** cheap lead and water test kits, community air sensors and Public Lab DIY tools. Each result is logged with GPS, time and a photo.
- **Shared FOIA library:** every records request and response is saved publicly (MuckRock). Nobody has to ask twice, and a town can split up requests.
- **Pooled court records:** court-filing (PACER) fees shared; everything contributed to RECAP.
- **OCR everything:** scanned minutes, FOIA PDFs and old reports become fully searchable.
- **Mirrors:** copy everything to the Internet Archive, plus downloadable county packs so the data can't vanish.

**3. Easy for anyone** (not selected yet; kept)
- **Simple and Pro modes;** plain-language reading level; a glossary (ppb, MCL, NPDES explained like a neighbor would).
- **Languages:** Spanish and others; voice mode.
- **Guided paths:**
  - "My water looks weird"
  - "A company wants to build near me"
  - "People here are getting sick"
  - "I want a lawyer"
- **Low bandwidth and offline:** works in rural Appalachia.
- **Text-message version:** text your address, get a summary back, for people without smartphones.
- **Print:** a one-page printout for a council meeting or a church bulletin.
- **Library kiosk mode.**

**4. Turn info into action (where the impact is) ★ SELECTED: ALL**
- **Public-comment alerts (the biggest lever):** a permit near you opens for comment, so you get alerted and a comment is drafted. That's the legal window where residents actually change outcomes.
- **Lawyer matching:** legal aid, law-school environmental clinics and pro bono firms, matched by issue and state, with the case file handed over in one click. Explains citizen-suit rules (e.g. the Clean Water Act's 60-day notice) and points to lawyers rather than DIY.
- **Journalist pack:** the story, timeline and sources, ready for local papers and newsrooms like ProPublica or Report for America.
- **Officials:** who represents you, how they voted and their contact info. A one-tap script for council or state hearings.
- **Petitions:** formal requests asking state agencies or EPA to inspect or enforce.
- **Shareable proof cards:** one fact, one source, ready for social media and hard to dismiss.
- **Wins tracker:** cases that led to fixes, fines or cleanups, so people see it works.
- **Weekly town report:** an automatic newsletter of what changed this week.

**5. Trust, safety, fairness ★ SELECTED**
- **Right of reply:** companies and agencies can respond on their own records. It makes the site more credible, not less.
- **Corrections:** a public corrections log and "report an error" everywhere.
- **Credit for the good:** compliance streaks and finished cleanups, so it's about accuracy, not being anti-business.
- **Reporter safety:** anonymous neighbor reports; photo locations blurred to the block.
- **Moderation:** against spam, and against fake accounts run by companies.
- **Whistleblowers:** pointed to the proper protected channels (EPA OIG, OSHA, SEC). The site hosts only lawfully public records.
- **Defamation guard:** "linked to" wording, confidence on every claim, legal review before launch.
- **Tamper-proof evidence:** every saved record is hashed and timestamped (e.g. with OpenTimestamps) so lawyers can show it wasn't altered.

**6. Wow features (Lu's style)** (not selected yet; kept)
- **AR point-and-ask (Sky Watch tech):** point your phone at a smokestack, mine or plant and see its record.
- **"What's under my house":** a report on past land use, nearby old sites and pipes.
- **Worldwide via Ground Truth:** the same engine for any country with public data. The supply-chain links show what a factory makes and who buys it.
- **Ask it anything:** answers cited sentence by sentence, with a "show me the record" link on each line.

**7. Keeping it alive ★ SELECTED**
- **Open source.** A fiscal sponsor or nonprofit for grants (e.g. Knight Foundation, Mozilla).
- **Near-zero cost:** static site plus scheduled collectors.
- **Researcher API.**
- **Maybe a paid pro tier:** law firms fund the free version; residents are always free.
- **Pilots:** start in two towns (Flint and Harlan County) with local partners: libraries, churches, clinics and a law-school clinic. Learn there, then expand.

### Build order suggestion
1. Address → facilities + violations (ECHO + SDWIS + TRI): this alone is useful.
2. Open EJ Score.
3. Timeline + FOIA generator.
4. Neighbor reports.
5. Money + entity graph (Pro).
6. Satellite layers.
7. Ask-anything with citations.

---

