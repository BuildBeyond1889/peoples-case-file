# People's Case File: handoff for Claude (read this first)

This package holds **only** the People's Case File: Lu's accountability website. The patents, forgotten-science and software-goldmine ideas are in a different handoff ("Lu - Big Ideas Handoff for Claude"). Don't mix them.

## Who you're working with
- **Lu** builds solo with no budget. He publishes under the GitHub handle **BuildBeyond1889**.
  - **Never put his real name on anything public.**
  - His email is private; never share it.
- **What he likes:**
  - plain-English explanations and honest limits
  - practical versions he can actually run
  - mockups before big builds
- **Style:** he's direct and swears casually. Match his energy, not his language. He cares about speed and results, not usage cost.
- **Previous project:** Sky Watch (an AR sky web app), live at https://buildbeyond1889.github.io/skywatch/. It's a static PWA on GitHub Pages, and this project should deploy the same way.

## What it is (one line)
Law-firm-grade case research, free, for anyone trying to figure out what's going on where they live, and who's behind it.

**Users:**
- a Flint resident
- a Harlan County, KY resident (coal)
- an associate lawyer at an environmental firm

It needs two depths: **Simple** for residents and **Pro** for lawyers and journalists.

## Lu's decisions so far (Nov 13 2026)
- **Format:**
  - **The website is the main product.** The phone version is the same site installed as a web app (PWA).
  - **The map is the front door:** a live, self-updating map, "like Google Maps", that loads what's around you or anywhere you pan.
- **Top priority:** the **info being right**, and gathering **as much new AND old material as possible** for the best analysis.
- **Headline feature, the corporate tree ("definitely"):**
  - **(a) case tree:** the companies tied to whatever is being worked on
  - **(b) world tree:** every company on the planet with public records
- **Selected (★ in docs/SPEC.md):**
  - all of "Better analysis"
  - all of "Turn info into action" ("for fucking sure")
  - "Trust, safety, fairness"
  - "Keeping it alive"
- **Not selected yet (kept):** "Gather more", "Easy for anyone", "Wow features".
- **Status:**
  - Mockups approved ("I like the mocks for now").
  - Lu said "not yet, still concept". He then asked for this deployable package so another Claude can pick it up.
  - **Confirm with Lu before building beyond the starter, and before creating a public repo.**

## Guardrails (non-negotiable)
1. **Public, lawfully obtained records only.** No leaked or hacked material, no scraping behind logins.
2. **Companies, and officials in their public roles only.**
   - Never profile private individuals: no home addresses, no private life.
   - Company officers appear only as named in official filings, in their corporate role.
3. **Every claim carries** a source link, the date published, the date pulled, an archived copy and a confidence level.
   - Say "linked to", never "did this".
   - When sources conflict, show both.
4. **AI only summarizes or searches stored records.** Each sentence links to its record. It never adds facts.
5. **Health data is estimates, not diagnoses.** Show that things happen in the same place, never that one caused the other.
6. **For residents:** "Not legal advice", plus a button to talk to legal aid or a lawyer.
7. **Right of reply** for companies and agencies, a public corrections log, and credit for clean records too.
8. **Never present our "Open EJ Score" as EPA's EJScreen.**

## What's in this package
| Path | What |
|---|---|
| `CLAUDE.md` | This brief |
| `docs/SPEC.md` | The full spec: features, data sources, the EJScreen plan, data-engine accuracy rules, the full improvement list with Lu's ★ selections, the corporate tree, build order and verified context |
| `docs/DATA-SOURCES.md` | Source registry: the endpoints to verify, IDs to join on, and which are live vs. historical |
| `mockups/` | The 6 approved screens as plain HTML (open in a browser): 4 phone, 2 laptop. **All names and numbers are SAMPLE data.** The original design canvas is a Claude Design artifact titled "People's Case File" in Lu's account |
| `site/` | Starter website (static, GitHub Pages-ready): MapLibre map, address search, layer panel and facility cards, reading `site/data/*.geojson` |
| `collector/` | Starter Python collector: pulls sources, writes dated snapshots plus a SHA-256 to `archive/`, and builds `site/data/` |
| `.github/workflows/collect.yml` | Runs the collector on a schedule and commits the results |

## Important: the starter is untested
- It was written in a session with **no outbound network**.
- No API endpoint in `collector/` or `docs/DATA-SOURCES.md` was called.
- Verify each one first: parameter names, response shape and CORS. Fix what's wrong before trusting any output.
- The map shows `site/data/sample.geojson` (clearly labelled SAMPLE) until the collector has run.

## Deploy (when Lu says go)
1. Create the repo `BuildBeyond1889/peoples-case-file`, with Lu's OK, since it's public.
2. Push this folder. In Settings → Pages, set the source to **GitHub Actions**; `pages.yml` then deploys `site/` on every push that touches it.
3. Enable Actions. `collect.yml` runs daily and commits `site/data/` and `archive/`.
   - Pushes made with the default bot token don't trigger other workflows, so add a `workflow_run` trigger to `pages.yml` or deploy from the same job.
4. Release habit (same as Sky Watch): bump the cache name in `site/sw.js` and the `?v=N` on script tags every release.

## Build order
1. Address or pan → facilities + violations + water systems (EPA ECHO, SDWIS, TRI), with sources. This alone is useful.
2. Corporate tree v1: facility → operator → parent (EPA FRS + GLEIF + SEC Exhibit 21), with ownership over time.
3. Open EJ Score: an open formula with adjustable weights.
4. Timeline + records-request (FOIA) generator, with deadline tracking.
5. Public-comment alerts for permits nearby: the biggest impact lever.
6. Silence detector: missing reports, no inspections, unfined violations, zombie permits.
7. World tree search: GLEIF + OpenCorporates + OpenSanctions.
8. Evidence-pack export with hashed, timestamped records.
9. Neighbor reports, satellite layers, and ask-anything with citations.

## Pilot towns
Flint, MI (Genesee County) and Harlan County, KY. Work with local partners: libraries, churches, a law-school environmental clinic.
