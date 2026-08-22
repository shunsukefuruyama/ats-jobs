/**
 * Readers for each supported ATS's public job-board API.
 *
 * Every endpoint here is one a company already exposes, without authentication, so that its own
 * careers page can draw a job list. None of this is HTML scraping. That is the whole design: a
 * markup change cannot break it, and there is no bot protection to be at odds with.
 *
 * Each provider has the same shape:
 *   id          identifier
 *   label       display name
 *   slugFrom    derive this platform's board slug from a URL, domain or slug
 *   endpoint    build the request URL from a slug
 *   parse       turn a response into the shared job shape, or null if this is not that platform
 */

const text = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Strip HTML down to readable text. Most platforms return descriptions as markup. */
function stripHtml(html) {
  return text(html)
    .replace(/<br\s*\/?>/gi, "\n")
    // Blank line between paragraphs and headings; single break between list items, or the text
    // ends up as an unreadable wall.
    .replace(/<\/(p|div|h[1-6])>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Pull host and path out of an input. Never throws, even when the input is not a URL. */
function parseTarget(input) {
  const raw = text(input).trim();
  if (!raw) return { host: "", path: "", raw };
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return { host: url.hostname.toLowerCase(), path: url.pathname, raw };
  } catch {
    return { host: "", path: "", raw };
  }
}

/** Reduce a domain to a bare name (example.com → example). The last resort for a slug. */
function bareName(host) {
  return host
    .replace(/^www\./, "")
    .split(".")[0]
    .replace(/[^a-z0-9-]/g, "");
}

/**
 * Slug alternatives derivable from a domain, most likely first.
 * datadoghq.com → ["datadoghq", "datadog"] — the real board is `datadog`.
 *
 * Generating variants freely would mean pointless requests to other people's APIs, so this covers
 * only the ways slugs have actually been observed to differ: a trailing `hq`/`inc`, a leading
 * `get`, and hyphens.
 */
export function slugVariants(base) {
  const out = [base];
  const add = (v) => {
    const cleaned = String(v ?? "").replace(/^-+|-+$/g, ""); // drop hyphens left by the trim
    if (cleaned.length >= 2 && !out.includes(cleaned)) out.push(cleaned);
  };
  add(base.replace(/-/g, ""));
  add(base.replace(/(hq|inc|corp|labs|group|team)$/i, ""));
  add(base.replace(/^(get|the|join|try)/i, ""));
  return out;
}

// ---------------------------------------------------------------------------

export const GREENHOUSE = {
  id: "greenhouse",
  label: "Greenhouse",
  // 404s for boards that do not exist, so an empty answer really does mean "no openings"


  emptyMeansExists: true,
  slugFrom(input) {
    const { host, path, raw } = parseTarget(input);
    // job-boards.greenhouse.io/acme, boards.greenhouse.io/acme
    if (host.endsWith("greenhouse.io")) {
      const seg = path.split("/").filter(Boolean);
      // also catch /embed/job_board?for=acme
      const m = raw.match(/[?&]for=([a-z0-9_-]+)/i);
      if (m) return m[1];
      if (seg.length) return seg[seg.length - 1] === "jobs" ? seg[seg.length - 2] : seg[0];
    }
    return host ? bareName(host) : raw;
  },
  endpoint(slug, { includeDescription }) {
    const q = includeDescription ? "?content=true" : "";
    return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs${q}`;
  },
  parse(body, slug) {
    const jobs = body?.jobs;
    if (!Array.isArray(jobs)) return null; // null means: this is not that platform
    return jobs.map((j) => ({
      id: text(j.id),
      title: text(j.title),
      url: text(j.absolute_url),
      location: text(j.location?.name),
      department: (j.departments || []).map((d) => text(d.name)).filter(Boolean).join(", "),
      team: (j.offices || []).map((o) => text(o.name)).filter(Boolean).join(", "),
      employmentType: "",
      remote: /remote/i.test(text(j.location?.name)) || null,
      publishedAt: text(j.first_published || j.updated_at) || null,
      updatedAt: text(j.updated_at) || null,
      description: j.content ? stripHtml(j.content) : "",
      boardSlug: slug,
    }));
  },
};

export const LEVER = {
  id: "lever",
  label: "Lever",
  // Returns 200 and [] even for companies that were never theirs, so an empty answer proves nothing
  emptyMeansExists: false,

  slugFrom(input) {
    const { host, path } = parseTarget(input);
    if (host.endsWith("lever.co")) {
      const seg = path.split("/").filter(Boolean);
      if (seg.length) return seg[0];
    }
    return host ? bareName(host) : text(input);
  },
  endpoint(slug) {
    return `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
  },
  parse(body, slug) {
    if (!Array.isArray(body)) return null;
    // Rippling also answers with a bare array, so the shape alone proves nothing. Check for a
    // Lever-specific key: mistaking one for the other yields a pile of jobs with empty titles,
    // which is the worst way for this to fail — silently and plausibly.
    if (body.length && !("text" in body[0] && "hostedUrl" in body[0])) return null;
    return body.map((j) => ({
      id: text(j.id),
      title: text(j.text),
      url: text(j.hostedUrl || j.applyUrl),
      location: text(j.categories?.location),
      department: text(j.categories?.department),
      team: text(j.categories?.team),
      employmentType: text(j.categories?.commitment),
      remote: /remote/i.test(text(j.workplaceType) + text(j.categories?.location)) || null,
      publishedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      updatedAt: null,
      description: stripHtml(j.descriptionPlain || j.description || ""),
      boardSlug: slug,
    }));
  },
};

export const ASHBY = {
  id: "ashby",
  label: "Ashby",
  emptyMeansExists: true, // 404s for boards that do not exist

  slugFrom(input) {
    const { host, path } = parseTarget(input);
    if (host.endsWith("ashbyhq.com")) {
      const seg = path.split("/").filter(Boolean);
      if (seg.length) return seg[0];
    }
    return host ? bareName(host) : text(input);
  },
  endpoint(slug, { includeDescription }) {
    const q = includeDescription ? "?includeCompensation=true" : "";
    return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}${q}`;
  },
  parse(body, slug) {
    const jobs = body?.jobs;
    if (!Array.isArray(jobs)) return null;
    return jobs.map((j) => ({
      id: text(j.id),
      title: text(j.title).trim(),
      url: text(j.jobUrl || j.applyUrl),
      location: text(j.location),
      department: text(j.department),
      team: text(j.team),
      employmentType: text(j.employmentType),
      remote: typeof j.isRemote === "boolean" ? j.isRemote : null,
      publishedAt: text(j.publishedAt) || null,
      updatedAt: text(j.updatedAt) || null,
      description: stripHtml(j.descriptionPlain || j.descriptionHtml || ""),
      boardSlug: slug,
    }));
  },
};

export const SMARTRECRUITERS = {
  id: "smartrecruiters",
  label: "SmartRecruiters",
  emptyMeansExists: false, // returns 200 with content:[] even for unknown companies

  slugFrom(input) {
    const { host, path } = parseTarget(input);
    if (host.includes("smartrecruiters.com")) {
      const seg = path.split("/").filter(Boolean);
      if (seg.length) return seg[0];
    }
    // SmartRecruiters identifiers are usually CamelCase, so pass the bare name through as-is
    return host ? bareName(host) : text(input);
  },
  endpoint(slug, _opts, offset = 0) {
    return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100&offset=${offset}`;
  },
  /**
   * 100 results per page is the cap. Returns the next offset while there is more to fetch.
   *
   * Stopping silently at 100 would hand back a large employer's board with rows missing, which is
   * the worst failure mode a data product has: wrong, and quiet about it.
   */
  nextOffset(body, fetched) {
    const total = body?.totalFound ?? 0;
    return fetched < total ? fetched : null;
  },
  parse(body, slug) {
    const jobs = body?.content;
    if (!Array.isArray(jobs)) return null;
    return jobs.map((j) => {
      const city = text(j.location?.city);
      const country = text(j.location?.country);
      return {
        id: text(j.id),
        title: text(j.name),
        url: text(j.ref || j.applyUrl) || `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
        location: [city, country].filter(Boolean).join(", "),
        department: text(j.department?.label),
        team: text(j.function?.label),
        employmentType: text(j.typeOfEmployment?.label),
        remote: j.location?.remote ?? null,
        publishedAt: text(j.releasedDate) || null,
        updatedAt: null,
        description: "",
        boardSlug: slug,
      };
    });
  },
};

export const PERSONIO = {
  id: "personio",
  label: "Personio",
  emptyMeansExists: false,

  slugFrom(input) {
    const { host } = parseTarget(input);
    if (host.includes("jobs.personio.")) return host.split(".")[0];
    return host ? bareName(host) : text(input);
  },
  endpoint(slug) {
    return `https://${encodeURIComponent(slug)}.jobs.personio.de/xml`;
  },
  /** Personio alone answers in XML. Read just what is needed, rather than adding a parser. */
  parse(body, slug) {
    const xml = typeof body === "string" ? body : "";
    if (!xml.includes("<position>")) return null;
    const pick = (block, tag) => {
      const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
      if (!m) return "";
      return stripHtml(m[1].replace(/<!\[CDATA\[|\]\]>/g, ""));
    };
    const out = [];
    for (const m of xml.matchAll(/<position>([\s\S]*?)<\/position>/gi)) {
      const b = m[1];
      const id = pick(b, "id");
      out.push({
        id,
        title: pick(b, "name"),
        url: `https://${slug}.jobs.personio.de/job/${id}`,
        location: pick(b, "office"),
        department: pick(b, "department"),
        team: pick(b, "subcompany"),
        employmentType: pick(b, "employmentType"),
        remote: null,
        publishedAt: pick(b, "createdAt") || null,
        updatedAt: null,
        description: pick(b, "jobDescriptions"),
        boardSlug: slug,
      });
    }
    return out;
  },
};

export const RIPPLING = {
  id: "rippling",
  label: "Rippling",
  emptyMeansExists: true, // 404s for boards that do not exist

  slugFrom(input) {
    const { host, path } = parseTarget(input);
    // ats.rippling.com/<slug>/jobs/<uuid>
    if (host.includes("rippling.com")) {
      const seg = path.split("/").filter(Boolean);
      if (seg.length) return seg[0];
    }
    return host ? bareName(host) : text(input);
  },
  endpoint(slug) {
    return `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(slug)}/jobs`;
  },
  parse(body, slug) {
    if (!Array.isArray(body)) return null;
    // Rippling returns a bare array even with nothing open, and so does Lever. Check for a
    // Rippling-specific key rather than trusting the shape.
    if (body.length && !("uuid" in body[0] && "name" in body[0])) return null;
    return body.map((j) => ({
      id: text(j.uuid),
      title: text(j.name),
      url: text(j.url),
      location: text(j.workLocation?.label),
      department: text(j.department?.label),
      team: "",
      employmentType: text(j.employmentType?.label),
      remote: /remote/i.test(text(j.workLocation?.label)) || null,
      publishedAt: null,
      updatedAt: null,
      description: "",
      boardSlug: slug,
    }));
  },
};


/**
 * Workday, which is built differently enough from the others to be handled differently.
 *
 *   - the listing is a **POST** (everything else is a GET)
 *   - **20 results per page, fixed** — raising the limit returns nothing at all
 *   - the listing is thin: no department, no employment type, and a relative date
 *     ("Posted Yesterday") rather than a real one
 *   - a board is identified by two things, a tenant host and a job-site name
 *
 * The slug therefore carries both, as `host::siteName` —
 * `nvidia.wd5.myworkdayjobs.com::NVIDIAExternalCareerSite`.
 *
 * Workday boards are also by far the largest: NVIDIA publishes around 2,000 open jobs and
 * Salesforce around 1,530, where most boards on other platforms hold tens.
 */
export const WORKDAY = {
  id: "workday",
  label: "Workday",
  method: "POST",
  pageSize: 20,
  emptyMeansExists: false, // a wrong site name can still answer 200 and empty, so trust nothing

  slugFrom(input) {
    const { host, path } = parseTarget(input);
    if (!/\.myworkdayjobs\.com$/i.test(host)) return "";
    // A locale segment can sit in the path (/en-US/SiteName/job/...), so the site name is the
    // first segment that is not a locale.
    const seg = path.split("/").filter(Boolean).filter((x) => !/^[a-z]{2}(-[A-Z]{2})?$/.test(x));
    const site = seg[0];
    return site ? `${host}::${site}` : "";
  },

  endpoint(slug, _opts, offset = 0) {
    const [host, site] = String(slug).split("::");
    // The tenant is the leading label of the host (nvidia.wd5.myworkdayjobs.com → nvidia)
    const tenant = host.split(".")[0];
    return `https://${host}/wday/cxs/${tenant}/${site}/jobs?offset=${offset}`;
  },

  body(_slug, _opts, offset = 0) {
    return { appliedFacets: {}, limit: 20, offset, searchText: "" };
  },

  nextOffset(_body, fetched) {
    // `total` is the size of the whole board; walk it 20 at a time until it is exhausted.
    const total = _body?.total ?? 0;
    return fetched < total ? fetched : null;
  },

  parse(body, slug) {
    const jobs = body?.jobPostings;
    if (!Array.isArray(jobs)) return null;
    const [host, site] = String(slug).split("::");
    return jobs.map((j) => ({
      id: text((j.bulletFields || [])[0]) || text(j.externalPath).split("_").pop(),
      title: text(j.title),
      url: `https://${host}/${site}${text(j.externalPath)}`,
      location: text(j.locationsText),
      department: "",
      team: "",
      employmentType: "",
      // The listing only carries a relative label like "Posted Yesterday". It is kept as
      // `postedLabel` rather than being passed off as a date; `publishedAt` stays null until the
      // detail endpoint supplies a real one.
      remote: /remote/i.test(text(j.locationsText)) || null,
      publishedAt: null,
      updatedAt: null,
      postedLabel: text(j.postedOn),
      description: "",
      boardSlug: slug,
    }));
  },

  /** Detail endpoint — the only place the description, real date and employment type live. */
  detailEndpoint(slug, job) {
    const [host, site] = String(slug).split("::");
    const tenant = host.split(".")[0];
    const path = text(job.url).split(`/${site}`)[1] || "";
    return `https://${host}/wday/cxs/${tenant}/${site}${path}`;
  },

  mergeDetail(job, body) {
    const info = body?.jobPostingInfo;
    if (!info) return job;
    return {
      ...job,
      description: stripHtml(info.jobDescription || ""),
      publishedAt: text(info.startDate) || null,
      employmentType: text(info.timeType),
      url: text(info.externalUrl) || job.url,
    };
  },
};


/**
 * The five platforms below all return an entire board in a single unauthenticated GET.
 *
 * Workable and Recruitee were written off once as "does not return data reliably". That was wrong:
 * the endpoints were. Workable answers on its widget API, and Recruitee's path needs its trailing
 * slash or it 404s. Worth remembering that "I could not make it work" is not the same finding as
 * "it cannot be done".
 */

export const WORKABLE = {
  id: "workable",
  label: "Workable",
  emptyMeansExists: false, // answers 200 and empty for accounts that do not exist
  slugFrom(input) {
    const { host, path } = parseTarget(input);
    if (host.includes("workable.com")) {
      const seg = path.split("/").filter(Boolean);
      if (seg.length) return seg[0];
      const sub = host.split(".")[0];
      if (sub && sub !== "apply" && sub !== "www") return sub;
    }
    return host ? bareName(host) : text(input);
  },
  endpoint(slug) {
    return `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`;
  },
  parse(body, slug) {
    const jobs = body?.jobs;
    if (!Array.isArray(jobs)) return null;
    return jobs.map((j) => ({
      id: text(j.shortcode) || text(j.id),
      title: text(j.title),
      url: text(j.url || j.shortlink),
      location: [text(j.city), text(j.state), text(j.country)].filter(Boolean).join(", "),
      department: text(j.department),
      team: text(j.function),
      employmentType: text(j.employment_type),
      remote: j.telecommuting === true ? true : j.telecommuting === false ? false : null,
      publishedAt: text(j.published_on) || null,
      updatedAt: null,
      salary: "",
      description: stripHtml(j.description || ""),
      boardSlug: slug,
    }));
  },
};

export const RECRUITEE = {
  id: "recruitee",
  label: "Recruitee",
  emptyMeansExists: true, // 404s for tenants that do not exist
  slugFrom(input) {
    const { host } = parseTarget(input);
    if (host.endsWith("recruitee.com")) return host.split(".")[0];
    return host ? bareName(host) : text(input);
  },
  endpoint(slug) {
    // The trailing slash is required; without it the API 404s.
    return `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`;
  },
  parse(body, slug) {
    const jobs = body?.offers;
    if (!Array.isArray(jobs)) return null;
    return jobs.map((j) => {
      const s = j.salary;
      const salary =
        s && (s.min || s.max)
          ? [s.min, s.max].filter(Boolean).join("–") + ` ${text(s.currency)}/${text(s.period)}`.trimEnd()
          : "";
      return {
        id: text(j.id) || text(j.guid),
        title: text(j.title),
        url: text(j.careers_url || j.careers_apply_url),
        location: text(j.location) || [text(j.city), text(j.country)].filter(Boolean).join(", "),
        department: text(j.department),
        team: "",
        employmentType: text(j.employment_type_code).replace(/_/g, " "),
        remote: typeof j.remote === "boolean" ? j.remote : null,
        publishedAt: text(j.published_at) || null,
        updatedAt: null,
        salary,
        description: stripHtml(j.description || ""),
        boardSlug: slug,
      };
    });
  },
};

export const BAMBOOHR = {
  id: "bamboohr",
  label: "BambooHR",
  emptyMeansExists: false, // unknown subdomains 302 to the marketing site
  slugFrom(input) {
    const { host } = parseTarget(input);
    if (host.endsWith("bamboohr.com")) return host.split(".")[0];
    return host ? bareName(host) : text(input);
  },
  endpoint(slug) {
    return `https://${encodeURIComponent(slug)}.bamboohr.com/careers/list`;
  },
  parse(body, slug) {
    const jobs = body?.result;
    if (!Array.isArray(jobs)) return null;
    return jobs.map((j) => {
      const loc = j.location ?? {};
      return {
        id: text(j.id),
        title: text(j.jobOpeningName),
        url: `https://${slug}.bamboohr.com/careers/${text(j.id)}`,
        location: [text(loc.city), text(loc.state)].filter(Boolean).join(", "),
        department: text(j.departmentLabel),
        team: "",
        employmentType: text(j.employmentStatusLabel),
        remote: typeof j.isRemote === "boolean" ? j.isRemote : null,
        publishedAt: null,
        updatedAt: null,
        salary: "",
        description: "",
        boardSlug: slug,
      };
    });
  },
};

export const BREEZY = {
  id: "breezy",
  label: "Breezy HR",
  emptyMeansExists: true,
  slugFrom(input) {
    const { host } = parseTarget(input);
    if (host.endsWith("breezy.hr")) return host.split(".")[0];
    return host ? bareName(host) : text(input);
  },
  endpoint(slug) {
    return `https://${encodeURIComponent(slug)}.breezy.hr/json`;
  },
  parse(body, slug) {
    if (!Array.isArray(body)) return null;
    // Lever and Rippling also return bare arrays; tell them apart by a Breezy-specific key.
    if (body.length && !("friendly_id" in body[0])) return null;
    return body.map((j) => ({
      id: text(j.id),
      title: text(j.name),
      url: text(j.url),
      location: text(j.location?.name),
      department: text(j.department),
      team: "",
      employmentType: text(j.type?.name),
      remote: j.location?.is_remote === true ? true : j.location?.is_remote === false ? false : null,
      publishedAt: text(j.published_date) || null,
      updatedAt: null,
      salary: text(j.salary),
      description: "",
      boardSlug: slug,
    }));
  },
};

export const TEAMTAILOR = {
  id: "teamtailor",
  label: "Teamtailor",
  emptyMeansExists: true,
  slugFrom(input) {
    const { host } = parseTarget(input);
    // Many tenants run on their own domain, so a full host is accepted as the slug.
    if (host.endsWith("teamtailor.com")) return host.split(".")[0];
    return host ? bareName(host) : text(input);
  },
  endpoint(slug) {
    // If a host was passed (career.example.com), use it directly.
    const host = slug.includes(".") ? slug : `${slug}.teamtailor.com`;
    return `https://${host}/jobs.json`;
  },
  parse(body, slug) {
    const jobs = body?.items;
    if (!Array.isArray(jobs)) return null;
    return jobs.map((j) => {
      const jp = j._jobposting ?? {};
      const loc = jp.jobLocation?.address ?? {};
      return {
        id: text(j.id),
        title: text(j.title),
        url: text(j.url),
        location: [text(loc.addressLocality), text(loc.addressRegion), text(loc.addressCountry)]
          .filter(Boolean)
          .join(", "),
        department: text(jp.industry),
        team: "",
        employmentType: text(jp.employmentType),
        remote: null,
        publishedAt: text(j.date_published || jp.datePosted) || null,
        updatedAt: null,
        salary: "",
        description: stripHtml(j.content_html || ""),
        boardSlug: slug,
      };
    });
  },
};

export const PROVIDERS = [
  GREENHOUSE, ASHBY, LEVER, SMARTRECRUITERS, RIPPLING, WORKDAY,
  WORKABLE, RECRUITEE, BAMBOOHR, BREEZY, TEAMTAILOR, PERSONIO,
];

export const PROVIDERS_BY_ID = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

export { parseTarget, bareName, stripHtml };
