# ats-jobs

Read job postings from the **official public job-board APIs** of 12 applicant tracking systems.

No browser. No HTML parsing. No API keys. No proxies.

```bash
npx ats-jobs stripe.com
```

```
Account Executive, AI Startups  |  San Francisco  |  Startups - Account Executives (NA)
  https://stripe.com/jobs/search?gh_jid=8130725
...
```

## Why this exists

Almost every job scraper renders a company's careers page in a headless browser and parses the
HTML. That breaks whenever the site is redesigned, it gets blocked, and it is slow.

It is also unnecessary. Every company on one of these platforms has a **public, unauthenticated
JSON (or XML) endpoint** — the very same one its own careers page calls to draw the job list. This
library calls that endpoint directly.

The result is that it does not break when a careers site changes, it needs no proxies, and a
company's entire board is one HTTP request away.

## Supported platforms

| Platform | Endpoint | Description text | Salary |
|---|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{slug}/jobs` | optional | — |
| Workday | `{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/…/jobs` | optional | — |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{slug}` | yes | — |
| Lever | `api.lever.co/v0/postings/{slug}` | yes | — |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{slug}/postings` | — | — |
| Rippling | `api.rippling.com/platform/api/ats/v1/board/{slug}/jobs` | — | — |
| Workable | `apply.workable.com/api/v1/widget/accounts/{slug}` | yes | — |
| Recruitee | `{slug}.recruitee.com/api/offers/` | yes | **yes** |
| BambooHR | `{slug}.bamboohr.com/careers/list` | — | — |
| Breezy HR | `{slug}.breezy.hr/json` | — | **yes** |
| Teamtailor | `{slug}.teamtailor.com/jobs.json` | yes | — |
| Personio | `{slug}.jobs.personio.de/xml` | yes | — |

## Install

```bash
npm install ats-jobs
```

Node 20 or newer. No dependencies.

## Library

```js
import { fetchCompany, filterJobs } from "ats-jobs";

const result = await fetchCompany("stripe.com");
// → { provider: "greenhouse", slug: "stripe", jobs: [ ... ] }

const remote = filterJobs(result.jobs, { keyword: "engineer", remoteOnly: true });
```

### `fetchCompany(input, options?)`

`input` accepts three shapes:

```js
await fetchCompany("stripe.com");                          // a domain — the ATS is detected
await fetchCompany("https://jobs.ashbyhq.com/ramp");        // a careers-page URL
await fetchCompany("greenhouse:airbnb");                    // an explicit board
```

Given a bare domain, all twelve providers are probed **in parallel** and whichever answers wins.
If none do, the library reads the company's careers page — respecting `robots.txt` — and looks for
an embedded job board, which catches companies whose board slug does not match their domain.

| Option | Default | Meaning |
|---|---|---|
| `includeDescription` | `false` | Include the job description as plain text |
| `maxJobs` | `0` | Stop paginating once this many jobs are collected |
| `timeoutMs` | `20000` | Per-request timeout |
| `log` | no-op | Called with progress messages |

It never throws for a company it cannot resolve. You get `{ error, attempts }` instead, where
`attempts` lists every board that was tried and what it returned — so a failure tells you why.

Every job is normalised to the same shape regardless of platform:

```js
{
  id, title, url, location, department, team,
  employmentType, remote, publishedAt, updatedAt,
  salary, description, boardSlug
}
```

### `filterJobs(jobs, { keyword, location, remoteOnly })`

Plain filtering over the normalised shape. Keyword matches title, department, team and description;
several words can be given, separated by spaces or commas.

## Command line

```bash
npx ats-jobs stripe.com openai.com
npx ats-jobs --json --keyword engineer --remote stripe.com
npx ats-jobs --limit 20 https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite
```

| Flag | Meaning |
|---|---|
| `--json` | Machine-readable output |
| `--keyword <words>` | Only jobs matching any of these words |
| `--location <words>` | Only jobs in a matching location |
| `--remote` | Only remote jobs |
| `--limit <n>` | Cap jobs per company |
| `--descriptions` | Include full descriptions |

## Notes on Workday

A Workday board lives at `{tenant}.wd{n}.myworkdayjobs.com`, and neither the tenant nor the pod
number can be derived from a company domain — so pass the careers URL rather than the domain. Its
listing endpoint returns a relative date (`Posted Yesterday`, exposed as `postedLabel`); pass
`includeDescription: true` to fetch each job's detail page, which carries a real `publishedAt`, the
employment type and the description.

Workday returns 20 jobs per request, so large boards are many requests. The library reads the total
up front and fetches the remaining pages in parallel — a 2,000-job board takes roughly 16 seconds.

## What this library will not do

- It does not touch anything behind a login.
- It does not bypass bot protection or circumvent rate limits; it backs off on `429`.
- It does not collect personal data. Job postings are company business information.
- It does not parse HTML for job data. The only HTML it reads is a company's own careers page, and
  only to find which job board is embedded in it, and only when `robots.txt` allows.

## Not affiliated

This is an independent library. It is not affiliated with, endorsed by, or sponsored by Greenhouse,
Workday, Ashby, Lever, SmartRecruiters, Rippling, Workable, Recruitee, BambooHR, Breezy HR,
Teamtailor, Personio, or any company whose job board it reads. All product names and trademarks
belong to their respective owners and are used only to describe which public job boards this
library can read.

## Hosted version

If you would rather not run it yourself, the same code runs as a hosted, monitored service on
Apify, with scheduling, storage and CSV/JSON export:
**[ATS Jobs Scraper](https://apify.com/plainapi/company-jobs-ats-api)**.

## Tests

```bash
npm test
```

25 tests covering slug derivation, response normalisation for every platform, cross-platform
misidentification (several platforms return bare arrays, so shape checks matter), HTML-to-text
conversion, filtering and careers-page discovery. They do not touch the network.

## Licence

MIT
