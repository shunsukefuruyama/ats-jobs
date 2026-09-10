/**
 * ATS detection and fetching.
 *
 * The point of this module is that a caller never has to know which ATS a company uses. Give it a
 * domain and it works that out.
 *
 * Detection probes **every provider at once**. Probing them in series means waiting out the
 * timeouts of each ATS that is not the right one, which can take over a minute per company. Run
 * time is what a caller pays for, so slowness is a real cost, not a cosmetic one.
 */

import { PROVIDERS, PROVIDERS_BY_ID, parseTarget, slugVariants } from "./providers.js";
import { discoverFromWebsite } from "./discover.js";

const UA = "ats-jobs-actor/1.0 (+https://apify.com; public job-board API client)";

/** Was the ATS named explicitly, as in "greenhouse:stripe"? */
function explicitProvider(input) {
  const m = String(input).match(/^([a-z]+)\s*:\s*(?!\/\/)(.+)$/i);
  if (!m) return null;
  const p = PROVIDERS_BY_ID[m[1].toLowerCase()];
  return p ? { provider: p, slug: m[2].trim() } : null;
}

/** If the hostname identifies the ATS outright, use that rather than guessing. */
function providerFromHost(host) {
  if (!host) return null;
  if (host.endsWith("greenhouse.io")) return PROVIDERS_BY_ID.greenhouse;
  if (host.endsWith("ashbyhq.com")) return PROVIDERS_BY_ID.ashby;
  if (host.endsWith("lever.co")) return PROVIDERS_BY_ID.lever;
  if (host.includes("smartrecruiters.com")) return PROVIDERS_BY_ID.smartrecruiters;
  if (host.includes("rippling.com")) return PROVIDERS_BY_ID.rippling;
  if (host.includes("jobs.personio.")) return PROVIDERS_BY_ID.personio;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One HTTP request. Parses JSON when it can, and returns the raw string otherwise (Personio
 * answers in XML).
 *
 * `429`, `5xx`, and timeouts mean the other side may be having a moment, so back off and retry a few times.
 * `404` is a definite answer — this is not that ATS — so it is never retried.
 */
async function getBody(url, { timeoutMs = 20_000, retries = 2, method = "GET", body } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          accept: "application/json, text/xml, */*",
          "user-agent": UA,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          const wait = Number(res.headers.get("retry-after")) * 1000 || 800 * 2 ** attempt;
          await sleep(Math.min(wait, 5_000));
          continue;
        }
        return { ok: false, status: res.status };
      }
      if (!res.ok) return { ok: false, status: res.status };

      const raw = await res.text();
      // **リダイレクト先を握り潰さない。**
      // 2026-08-24、BambooHR の失効アカウント（`pandadoc`）が
      //   /careers/list -> 302 -> /settings/account/expired.php
      // と飛び、その HTML を掴んで JSON 解析に失敗し、
      // 「この ATS ではない」と報告していた。**板が消えたことと、この ATS でないことは別である。**
      const landedElsewhere = typeof res.url === "string" && res.url !== url;
      try {
        return { ok: true, status: res.status, body: JSON.parse(raw), finalUrl: res.url, landedElsewhere };
      } catch {
        return { ok: true, status: res.status, body: raw, finalUrl: res.url, landedElsewhere };
      }
    } catch (err) {
      if (attempt < retries) {
        await sleep(800 * 2 ** attempt);
        continue;
      }
      return { ok: false, status: 0, error: err?.name === "AbortError" ? "timeout" : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Greenhouse's listing endpoint omits department names. Its departments endpoint carries them, so
 * build a job-id → department map from there and fill the gaps.
 *
 * If that second call fails the jobs are still returned: an enrichment is a nice-to-have and is
 * never a reason to fail the whole company.
 */
async function enrichGreenhouseDepartments(slug, jobs, opts) {
  const res = await getBody(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/departments`,
    opts,
  );
  if (!res.ok || !Array.isArray(res.body?.departments)) return jobs;

  const byId = new Map();
  for (const dep of res.body.departments) {
    for (const j of dep.jobs ?? []) {
      if (!byId.has(String(j.id))) byId.set(String(j.id), String(dep.name ?? ""));
    }
  }
  if (byId.size === 0) return jobs;
  return jobs.map((j) => (j.department ? j : { ...j, department: byId.get(j.id) ?? "" }));
}

/** Pagination guard. Passing this means either the API or this code is misbehaving. */
const MAX_PAGES = 200;

/**
 * Try one provider. Returns the jobs on a hit and `null` on a miss.
 * Providers with a `nextOffset` are paged through until the board is exhausted.
 */
async function tryProvider(provider, slug, { includeDescription, timeoutMs, maxJobs = 0 }) {
  if (!slug) return null;

  const opts = { includeDescription };
  const req = (offset) => ({
    timeoutMs,
    method: provider.method ?? "GET",
    body: provider.body ? provider.body(slug, opts, offset) : undefined,
  });

  const first = await getBody(provider.endpoint(slug, opts, 0), req(0));
  if (!first.ok) return { provider, slug, status: first.status || first.error, jobs: null };

  const jobs = provider.parse(first.body, slug);

  // **板が消えたことと、この ATS でないことを混同しない。**
  // 失効した BambooHR アカウントは /careers/list から
  // /settings/account/expired.php へ 302 する。fetch は既定でこれを追い、
  // 返ってきた HTML は JSON ではないので parse が null を返す。
  // その null をそのまま「この ATS ではない」と読むと、
  // 「板はもう存在しない」という、呼び出し側が最も知りたい事実が消える。
  if (jobs === null && first.landedElsewhere) {
    return {
      provider,
      slug,
      status: first.status,
      jobs: null,
      goneTo: first.finalUrl,
    };
  }

  if (jobs === null || !provider.nextOffset) {
    return { provider, slug, status: first.status, jobs };
  }

  // When the total is known, work out every remaining offset up front and fetch them in parallel.
  // Workday returns a fixed 20 jobs per request, so a 2,000-job board is 100 round trips in
  // series. Run time is what the caller pays for, so this is a cost question, not a style one.
  const total = first.body?.total;
  const pageSize = provider.pageSize ?? jobs.length;
  const want = maxJobs > 0 ? Math.min(maxJobs, total ?? Infinity) : total;

  if (Number.isFinite(want) && pageSize > 0 && want > jobs.length) {
    const offsets = [];
    for (let o = jobs.length; o < want && offsets.length < MAX_PAGES; o += pageSize) offsets.push(o);

    const all = [...jobs];
    const CONCURRENCY = 6; // enough to be quick, not enough to hammer anyone
    for (let i = 0; i < offsets.length; i += CONCURRENCY) {
      const batch = offsets.slice(i, i + CONCURRENCY);
      const pages = await Promise.all(
        batch.map((o) => getBody(provider.endpoint(slug, opts, o), req(o))),
      );
      for (const res of pages) {
        if (!res.ok) continue; // one bad page should not lose the whole board
        const more = provider.parse(res.body, slug);
        if (more?.length) all.push(...more);
      }
    }
    return { provider, slug, status: first.status, jobs: all };
  }

  // Platforms that do not report a total (Lever and friends) have to be walked in order.
  const all = [...jobs];
  for (let page = 1; page < MAX_PAGES; page += 1) {
    if (maxJobs > 0 && all.length >= maxJobs) break;
    const offset = provider.nextOffset(first.body, all.length);
    if (offset == null) break;
    const next = await getBody(provider.endpoint(slug, opts, offset), req(offset));
    if (!next.ok) break;
    const more = provider.parse(next.body, slug);
    if (!more || more.length === 0) break;
    all.push(...more);
  }
  return { provider, slug, status: first.status, jobs: all };
}

/**
 * Fill in fields the listing does not carry — description, real date, employment type — from each
 * job's own detail endpoint.
 *
 * Only Workday needs this today. It costs one extra request per job, so it runs **only when the
 * caller has asked for descriptions**, and only up to the requested number of jobs.
 */
async function enrichDetails(provider, slug, jobs, { timeoutMs, limit }) {
  if (!provider.detailEndpoint || !provider.mergeDetail) return jobs;
  const targets = jobs.slice(0, limit);
  const CONCURRENCY = 5; // keep the detail fetches polite
  const out = [...jobs];
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const details = await Promise.all(
      batch.map((j) => getBody(provider.detailEndpoint(slug, j), { timeoutMs })),
    );
    details.forEach((res, k) => {
      if (res.ok) out[i + k] = provider.mergeDetail(out[i + k], res.body);
    });
  }
  return out;
}

/**
 * Fetch one company's jobs.
 * Never throws — a company that cannot be resolved comes back with an `error` and the list of
 * boards that were tried, so one bad entry does not stop a batch.
 */
export async function fetchCompany(input, opts) {
  const {
    includeDescription = false,
    timeoutMs = 20_000,
    maxJobs = 0,
    log = () => {},
  } = opts ?? {};

  const explicit = explicitProvider(input);
  const target = explicit ? explicit.slug : input;
  const { host } = parseTarget(target);
  const known = explicit?.provider ?? providerFromHost(host);

  // A known ATS is queried on its own; otherwise every provider is probed at once.
  const candidates = known
    ? [{ provider: known, slug: explicit?.provider === known ? explicit.slug : known.slugFrom(target) }]
    : PROVIDERS.map((p) => ({ provider: p, slug: p.slugFrom(target) }));

  const settled = await Promise.all(
    candidates.map((c) => tryProvider(c.provider, c.slug, { includeDescription, timeoutMs, maxJobs })),
  );

  const attempts = settled.filter(Boolean).map((r) => `${r.provider.id}:${r.slug}=${r.status}`);

  // Prefer a provider that returned at least one job. An empty board is ambiguous — it could be
  // the right ATS with nothing open, or a slug that happens to belong to someone else — so it is
  // only accepted when the ATS was already known for certain.
  const hits = settled.filter((r) => r && Array.isArray(r.jobs));
  let chosen = hits.find((r) => r.jobs.length > 0) ?? (known ? hits[0] : undefined);

  // If the first guess missed everywhere, try slug variants. A board name frequently differs from
  // the company domain — datadoghq.com publishes on a board called `datadog`.
  if (!chosen && !known) {
    const extra = [];
    for (const p of PROVIDERS) {
      const base = p.slugFrom(target);
      for (const v of slugVariants(base).slice(1)) extra.push({ provider: p, slug: v });
    }
    if (extra.length) {
      const more = await Promise.all(
        extra.map((c) => tryProvider(c.provider, c.slug, { includeDescription, timeoutMs, maxJobs })),
      );
      for (const r of more.filter(Boolean)) attempts.push(`variant ${r.provider.id}:${r.slug}=${r.status}`);
      chosen = more.find((r) => r && Array.isArray(r.jobs) && r.jobs.length > 0) ?? chosen;
      if (chosen) hits.push(chosen);
    }
  }

  // Only once every guess has failed, read the company's careers page and find the ATS there.
  // Board slugs disagree with domains more often than not (acme.com → acmecorp), and this path is
  // what makes "just give it a domain" hold up in practice.
  if (!chosen && !known && host) {
    const discovered = await discoverFromWebsite(host, { timeoutMs, log });
    for (const d of discovered) {
      const provider = PROVIDERS_BY_ID[d.provider];
      if (!provider) continue;
      const r = await tryProvider(provider, d.slug, { includeDescription, timeoutMs, maxJobs });
      attempts.push(`discover ${d.provider}:${d.slug}=${r?.status}`);
      if (r && Array.isArray(r.jobs) && r.jobs.length > 0) {
        chosen = r;
        break;
      }
    }
  }

  // Still nothing? The board may genuinely exist with no openings. An empty answer is only
  // trustworthy from platforms that 404 for boards that do not exist — Lever and SmartRecruiters
  // happily return 200 and an empty array for companies that were never theirs.
  if (!chosen) {
    const trustworthy = hits.filter((r) => r.provider.emptyMeansExists);
    if (trustworthy.length === 1) chosen = trustworthy[0];
  }

  if (!chosen) {
    // **「板が消えた」と「そもそも見つからない」を区別して返す。**
    // 呼び出し側にとって、この2つは全く違う話である。
    // 前者は「以前は存在した。もう無い」であり、対処は板の差し替え。
    // 後者は「探し方が悪いのかもしれない」であり、対処は入力の見直し。
    // 一緒くたに "No supported ATS job board found" と返すと、
    // 利用者は自分の入力を疑い続けることになる。
    const gone = settled.filter((r) => r && r.goneTo);
    if (gone.length) {
      const g = gone[0];
      return {
        input,
        provider: null,
        slug: null,
        jobs: [],
        error:
          `The ${g.provider.label} board "${g.slug}" no longer exists ` +
          `(it redirects to ${g.goneTo}). The account was probably closed or expired.`,
        goneTo: g.goneTo,
        attempts,
      };
    }
    const timedOut = known && settled.find((r) => r && r.status === "timeout" && r.jobs === null);
    if (timedOut) {
      return {
        input,
        provider: null,
        slug: null,
        jobs: [],
        error:
          `Timed out contacting ${known.label} for "${timedOut.slug}" after ${timeoutMs}ms — ` +
          "the upstream API may be slow or temporarily unreachable. Try again or pass a longer timeoutMs.",
        attempts,
      };
    }
    return {
      input,
      provider: null,
      slug: null,
      jobs: [],
      error: "No supported ATS job board found",
      attempts,
    };
  }

  let jobs = chosen.jobs;
  if (chosen.provider.id === "greenhouse" && jobs.length && !jobs.some((j) => j.department)) {
    jobs = await enrichGreenhouseDepartments(chosen.slug, jobs, { timeoutMs });
  }
  if (includeDescription && chosen.provider.detailEndpoint && jobs.length) {
    const limit = maxJobs > 0 ? Math.min(maxJobs, jobs.length) : jobs.length;
    log(`${chosen.provider.label}: fetching details for ${limit} jobs`);
    jobs = await enrichDetails(chosen.provider, chosen.slug, jobs, { timeoutMs, limit });
  }

  log(`${input} → ${chosen.provider.label} (${chosen.slug}): ${jobs.length} jobs`);
  return {
    input,
    provider: chosen.provider.id,
    providerLabel: chosen.provider.label,
    slug: chosen.slug,
    jobs,
    attempts,
  };
}

/** Filter fetched jobs by the caller's criteria. */
export function filterJobs(jobs, { keyword, location, remoteOnly } = {}) {
  let out = jobs;
  if (keyword) {
    const needles = String(keyword).toLowerCase().split(/[,\s]+/).filter(Boolean);
    out = out.filter((j) => {
      const hay = `${j.title} ${j.department} ${j.team} ${j.description ?? ""}`.toLowerCase();
      return needles.some((n) => hay.includes(n));
    });
  }
  if (location) {
    const needles = String(location).toLowerCase().split(/[,\s]+/).filter(Boolean);
    out = out.filter((j) => needles.some((n) => (j.location ?? "").toLowerCase().includes(n)));
  }
  if (remoteOnly) {
    out = out.filter((j) => j.remote === true || /remote|anywhere/i.test(j.location ?? ""));
  }
  return out;
}
