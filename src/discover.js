/**
 * Work out which ATS a company uses by reading its careers page.
 *
 * Deriving a board slug from a domain (`acme.com` → `acme`) is easy but often wrong: real
 * companies use slugs like `acmecorp`, `acme-inc` or `acmehq`. So **only once every guess has
 * failed**, this module reads the company's own careers page and pulls the slug out of whichever
 * job board is embedded in it.
 *
 * This is what makes "just give it a domain" actually work.
 *
 * Boundaries this module keeps:
 *   - `robots.txt` is read first, and a disallowed path is not fetched
 *   - only the public home page and careers pages are read; nothing behind a login
 *   - a handful of requests per company, never a flood
 */

const UA = "ats-jobs-actor/1.0 (+https://apify.com; public job-board API client)";

/** Where careers pages usually live. Tried in order; the first hit wins. */
const CAREER_PATHS = ["/careers", "/jobs", "/careers/", "/about/careers", "/company/careers", "/"];

/**
 * Rules for pulling an ATS slug out of a page. Adding a rule here widens coverage.
 */
const SIGNATURES = [
  { provider: "greenhouse", re: /(?:job-)?boards(?:-api)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]{2,})/i },
  { provider: "greenhouse", re: /greenhouse\.io\/embed\/job_board\?for=([a-z0-9_-]{2,})/i },
  { provider: "ashby", re: /jobs\.ashbyhq\.com\/([a-z0-9_-]{2,})/i },
  { provider: "ashby", re: /api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9_-]{2,})/i },
  { provider: "lever", re: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]{2,})/i },
  { provider: "smartrecruiters", re: /(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]{2,})/i },
  { provider: "rippling", re: /ats\.rippling\.com\/([a-z0-9_-]{2,})/i },
  { provider: "personio", re: /([a-z0-9-]{2,})\.jobs\.personio\.(?:de|com)/i },
  // Workday needs both a host and a site name, so the match is assembled into one slug.
  // Finding a myworkdayjobs.com link on the careers page is the only practical way in.
  {
    provider: "workday",
    re: /([a-z0-9-]+\.wd\d+\.myworkdayjobs\.com)\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?([A-Za-z0-9_-]{2,})/,
    build: (m) => `${m[1]}::${m[2]}`,
  },

  { provider: "workable", re: /apply\.workable\.com\/([a-z0-9_-]{2,})/i },
  { provider: "recruitee", re: /([a-z0-9-]{2,})\.recruitee\.com/i },
  { provider: "bamboohr", re: /([a-z0-9-]{2,})\.bamboohr\.com/i },
  { provider: "breezy", re: /([a-z0-9-]{2,})\.breezy\.hr/i },
  { provider: "teamtailor", re: /([a-z0-9-]{2,})\.teamtailor\.com/i },

  // Embedded widgets. When a careers page is built by JavaScript, no ATS link appears in the
  // HTML — only the widget's attributes do. getguru.com, for instance, carries nothing but
  // data-job-board-id="guru-careers", which no amount of guessing from the domain would find.
  { provider: "rippling", re: /data-job-board-id=["']([a-z0-9_-]{2,})["']/i },
  { provider: "greenhouse", re: /data-(?:board-)?token=["']([a-z0-9_-]{2,})["']/i },
  { provider: "ashby", re: /data-ashby-jobs?-board=["']([a-z0-9_-]{2,})["']/i },
];

/** Read robots.txt and decide whether this path may be fetched. */
async function robotsAllows(origin, path, timeoutMs) {
  const res = await get(`${origin}/robots.txt`, timeoutMs);
  if (!res.ok || typeof res.body !== "string") return true; // no robots.txt means no restriction

  // Only the `User-agent: *` section applies to us; directives aimed at other bots are ignored.
  const lines = res.body.split(/\r?\n/);
  let inStar = false;
  const disallowed = [];
  for (const raw of lines) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const [keyRaw, ...rest] = line.split(":");
    const key = keyRaw.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      inStar = value === "*";
    } else if (inStar && key === "disallow" && value) {
      disallowed.push(value);
    } else if (inStar && key === "allow" && value === "/") {
      return true;
    }
  }
  return !disallowed.some((d) => d === "/" || path.startsWith(d));
}

async function get(url, timeoutMs = 12_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: "text/html,*/*", "user-agent": UA },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, body: await res.text() };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Return the (provider, slug) pairs found in the page, in order, without duplicates. */
export function extractSignatures(html) {
  const found = [];
  const seen = new Set();
  for (const sig of SIGNATURES) {
    const m = html.match(sig.re);
    if (!m) continue;
    const slug = sig.build ? sig.build(m) : m[1];
    // Drop obvious non-slugs. A false positive is not as bad as wrong data, but it wastes a request.
    if (/^(www|jobs|careers|embed|api|static|assets)$/i.test(slug)) continue;
    if (/(^|::)(wday|cxs)$/i.test(slug)) continue; // caught a Workday internal path, not a site
    const key = `${sig.provider}:${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ provider: sig.provider, slug });
  }
  return found;
}

/**
 * Find the ATS and slug for a company domain.
 * Returns an empty array when nothing is found; never throws.
 */
export async function discoverFromWebsite(host, { timeoutMs = 12_000, log = () => {} } = {}) {
  if (!host) return [];
  const origin = `https://${host}`;

  for (const path of CAREER_PATHS) {
    if (!(await robotsAllows(origin, path, timeoutMs))) {
      log(`Skipping ${host}${path} — disallowed by robots.txt`);
      continue;
    }
    const res = await get(`${origin}${path}`, timeoutMs);
    if (!res.ok) continue;

    const found = extractSignatures(res.body);
    if (found.length) {
      log(`Detected from ${host}${path}: ${found.map((f) => `${f.provider}:${f.slug}`).join(", ")}`);
      return found;
    }
  }
  return [];
}
