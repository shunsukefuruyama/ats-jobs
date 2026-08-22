/**
 * Unit tests for the pure functions. Nothing here touches the network.
 *
 * These do not exist to notice when a platform changes its response format — that is what the
 * live smoke test is for. They exist to keep input interpretation and normalisation from
 * regressing, because from a caller's point of view a broken slug derivation is indistinguishable
 * from the whole thing being broken.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { GREENHOUSE, ASHBY, LEVER, SMARTRECRUITERS, PERSONIO, stripHtml } from "../src/providers.js";
import { filterJobs } from "../src/fetcher.js";

test("Greenhouse: derives a slug from a domain, a board URL and an embed URL", () => {
  assert.equal(GREENHOUSE.slugFrom("stripe.com"), "stripe");
  assert.equal(GREENHOUSE.slugFrom("https://www.stripe.com/jobs"), "stripe");
  assert.equal(GREENHOUSE.slugFrom("https://job-boards.greenhouse.io/airbnb"), "airbnb");
  assert.equal(GREENHOUSE.slugFrom("https://boards.greenhouse.io/acme/jobs"), "acme");
  assert.equal(
    GREENHOUSE.slugFrom("https://boards.greenhouse.io/embed/job_board?for=acmecorp"),
    "acmecorp",
  );
});

test("Ashby and Lever: resolve both a company domain and a hosted board URL", () => {
  assert.equal(ASHBY.slugFrom("https://jobs.ashbyhq.com/ramp"), "ramp");
  assert.equal(ASHBY.slugFrom("openai.com"), "openai");
  assert.equal(LEVER.slugFrom("https://jobs.lever.co/leverdemo"), "leverdemo");
  assert.equal(LEVER.slugFrom("netflix.com"), "netflix");
});

test("slug derivation is not thrown off by www or a subdomain", () => {
  assert.equal(GREENHOUSE.slugFrom("www.example.com"), "example");
  assert.equal(GREENHOUSE.slugFrom("careers.example.co.jp"), "careers");
});

test("Greenhouse: normalises a response into the shared job shape", () => {
  const rows = GREENHOUSE.parse(
    {
      jobs: [
        {
          id: 123,
          title: "Staff Engineer",
          absolute_url: "https://example.com/jobs/123",
          location: { name: "Remote - US" },
          updated_at: "2026-08-01T00:00:00Z",
          first_published: "2026-07-01T00:00:00Z",
          departments: [{ name: "Engineering" }],
        },
      ],
    },
    "acme",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "123");
  assert.equal(rows[0].title, "Staff Engineer");
  assert.equal(rows[0].department, "Engineering");
  assert.equal(rows[0].remote, true, "a location mentioning remote marks the job remote");
  assert.equal(rows[0].boardSlug, "acme");
});

test("every provider returns null for a response of the wrong shape", () => {
  assert.equal(GREENHOUSE.parse({ message: "Not found" }, "x"), null);
  assert.equal(ASHBY.parse([], "x"), null, "Ashby does not answer with a bare array");
  assert.equal(LEVER.parse({ ok: false }, "x"), null, "Lever answers with an array");
  assert.equal(SMARTRECRUITERS.parse({ jobs: [] }, "x"), null, "SmartRecruiters answers under content");
  assert.equal(PERSONIO.parse("{}", "x"), null, "Personio answers in XML");
});

test("Lever: an empty array means no openings, not a wrong platform", () => {
  const rows = LEVER.parse([], "plaid");
  assert.deepEqual(rows, [], "the shape is right, so this must not be null or detection breaks");
});

test("Personio: reads jobs out of XML", () => {
  const xml = `<?xml version="1.0"?><workzag-jobs>
    <position><id>42</id><name><![CDATA[Backend Developer]]></name>
    <office>Munich</office><department>Engineering</department>
    <employmentType>permanent</employmentType>
    <jobDescriptions><![CDATA[<p>Build things</p>]]></jobDescriptions></position>
  </workzag-jobs>`;
  const rows = PERSONIO.parse(xml, "acme");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Backend Developer");
  assert.equal(rows[0].location, "Munich");
  assert.equal(rows[0].description, "Build things");
  assert.match(rows[0].url, /acme\.jobs\.personio\.de/);
});

test("stripHtml: turns posting markup into readable text", () => {
  assert.equal(stripHtml("<p>Hello</p><p>World</p>"), "Hello\n\nWorld");
  assert.equal(stripHtml("<ul><li>A</li><li>B</li></ul>"), "- A\n- B");
  assert.equal(stripHtml("R&amp;D &lt;team&gt;"), "R&D <team>");
  assert.equal(stripHtml(null), "");
});

test("filterJobs: filters by keyword, location and remote", () => {
  const jobs = [
    { title: "Backend Engineer", department: "Eng", team: "", location: "London", remote: false },
    { title: "Designer", department: "Design", team: "", location: "Remote - EU", remote: true },
    { title: "Data Engineer", department: "Eng", team: "", location: "Berlin", remote: null },
  ];
  assert.equal(filterJobs(jobs, { keyword: "engineer" }).length, 2);
  assert.equal(filterJobs(jobs, { location: "berlin" }).length, 1);
  assert.equal(filterJobs(jobs, { remoteOnly: true }).length, 1);
  assert.equal(filterJobs(jobs, {}).length, 3, "no criteria means no filtering");
  assert.equal(
    filterJobs(jobs, { keyword: "engineer", location: "london" }).length,
    1,
    "criteria combine with AND",
  );
});

test("filterJobs: copes with jobs that carry no description", () => {
  const jobs = [{ title: "X", department: "", team: "", location: "", remote: null }];
  assert.doesNotThrow(() => filterJobs(jobs, { keyword: "x" }));
});

test("Rippling: normalises its response and is not confused with other bare arrays", async () => {
  const { RIPPLING } = await import("../src/providers.js");
  const rows = RIPPLING.parse(
    [
      {
        uuid: "abc-123",
        name: "Account Executive",
        department: { id: "Sales", label: "Sales" },
        url: "https://ats.rippling.com/acme/jobs/abc-123",
        workLocation: { label: "Remote, US" },
      },
    ],
    "acme",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "abc-123");
  assert.equal(rows[0].department, "Sales");
  assert.equal(rows[0].remote, true);

  // Lever also returns bare arrays, so a differently shaped one must be rejected
  assert.equal(RIPPLING.parse([{ id: "x", text: "Lever job" }], "acme"), null);
  assert.deepEqual(RIPPLING.parse([], "acme"), [], "an empty array means no openings");
});

test("Rippling: derives a slug from an ats.rippling.com URL", async () => {
  const { RIPPLING } = await import("../src/providers.js");
  assert.equal(RIPPLING.slugFrom("https://ats.rippling.com/acme/jobs/abc"), "acme");
  assert.equal(RIPPLING.slugFrom("acme.com"), "acme");
});

test("Lever: does not mistake a Rippling response for its own", () => {
  const ripplingShape = [{ uuid: "u1", name: "Job", url: "https://ats.rippling.com/a/jobs/u1" }];
  assert.equal(
    LEVER.parse(ripplingShape, "acme"),
    null,
    "getting this wrong yields many empty-titled jobs — silent corruption, the worst failure",
  );
});

test("SmartRecruiters: returns the next offset when a board exceeds one page", () => {
  assert.equal(
    SMARTRECRUITERS.nextOffset({ totalFound: 131 }, 100),
    100,
    "100 of 131 fetched means continue from offset 100",
  );
  assert.equal(SMARTRECRUITERS.nextOffset({ totalFound: 131 }, 131), null, "stop once the board is exhausted");
  assert.equal(SMARTRECRUITERS.nextOffset({ totalFound: 40 }, 40), null);
  assert.equal(SMARTRECRUITERS.nextOffset({}, 0), null, "do not page when no total is reported");
});

test("slugVariants: only covers the ways slugs have actually been seen to differ", async () => {
  const { slugVariants } = await import("../src/providers.js");
  assert.deepEqual(slugVariants("datadoghq"), ["datadoghq", "datadog"], "drops a trailing hq");
  assert.deepEqual(slugVariants("getguru"), ["getguru", "guru"], "drops a leading get");
  assert.deepEqual(slugVariants("stripe"), ["stripe"], "a slug that already works needs no variants");
  assert.ok(!slugVariants("my-corp").includes("my-"), "no stray hyphen may be left behind");
});

test("discover: reads a slug out of an embedded widget attribute", async () => {
  const { extractSignatures } = await import("../src/discover.js");
  const html = '<div class="w-embed"><div data-job-board-id="guru-careers"></div></div>';
  assert.deepEqual(extractSignatures(html), [{ provider: "rippling", slug: "guru-careers" }]);
});

test("discover: rejects hostname fragments that are not slugs", async () => {
  const { extractSignatures } = await import("../src/discover.js");
  assert.deepEqual(
    extractSignatures('<a href="https://jobs.ashbyhq.com/www">x</a>'),
    [],
    "a word like www is not a slug",
  );
  assert.deepEqual(
    extractSignatures('<a href="https://job-boards.greenhouse.io/acmecorp/jobs/1">x</a>'),
    [{ provider: "greenhouse", slug: "acmecorp" }],
  );
});

test("Workday: extracts host and site name from a URL, ignoring a locale segment", async () => {
  const { WORKDAY } = await import("../src/providers.js");
  assert.equal(
    WORKDAY.slugFrom("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"),
    "nvidia.wd5.myworkdayjobs.com::NVIDIAExternalCareerSite",
  );
  assert.equal(
    WORKDAY.slugFrom("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA/X_JR1"),
    "nvidia.wd5.myworkdayjobs.com::NVIDIAExternalCareerSite",
    "a locale segment must not be taken for the site name",
  );
  assert.equal(WORKDAY.slugFrom("stripe.com"), "", "a non-Workday host yields an empty slug");
});

test("Workday: builds the POST body and pages 20 at a time", async () => {
  const { WORKDAY } = await import("../src/providers.js");
  const slug = "acme.wd1.myworkdayjobs.com::Careers";
  assert.equal(WORKDAY.method, "POST");
  assert.deepEqual(WORKDAY.body(slug, {}, 40), { appliedFacets: {}, limit: 20, offset: 40, searchText: "" });
  assert.match(WORKDAY.endpoint(slug, {}, 40), /\/wday\/cxs\/acme\/Careers\/jobs\?offset=40$/);
  assert.equal(WORKDAY.nextOffset({ total: 100 }, 20), 20, "return the next offset while jobs remain");
  assert.equal(WORKDAY.nextOffset({ total: 100 }, 100), null, "stop once the board is exhausted");
});

test("Workday: normalises its response and is not confused with other platforms", async () => {
  const { WORKDAY } = await import("../src/providers.js");
  const rows = WORKDAY.parse(
    {
      total: 1,
      jobPostings: [{
        title: "Staff Engineer",
        externalPath: "/job/US-CA-Santa-Clara/Staff-Engineer_JR123",
        locationsText: "US, CA, Remote",
        postedOn: "Posted Yesterday",
        bulletFields: ["JR123"],
      }],
    },
    "acme.wd1.myworkdayjobs.com::Careers",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "JR123");
  assert.equal(rows[0].url, "https://acme.wd1.myworkdayjobs.com/Careers/job/US-CA-Santa-Clara/Staff-Engineer_JR123");
  assert.equal(rows[0].remote, true);
  assert.equal(rows[0].postedLabel, "Posted Yesterday");
  assert.equal(rows[0].publishedAt, null, "the listing carries no real date, so publishedAt stays null");
  assert.equal(WORKDAY.parse({ jobs: [] }, "x"), null, "another platform's shape is not mistaken for this one");
});

test("Workday: fills description, real date and employment type from the detail endpoint", async () => {
  const { WORKDAY } = await import("../src/providers.js");
  const job = { url: "https://acme.wd1.myworkdayjobs.com/Careers/job/X_JR1", description: "", publishedAt: null };
  assert.match(WORKDAY.detailEndpoint("acme.wd1.myworkdayjobs.com::Careers", job), /\/wday\/cxs\/acme\/Careers\/job\/X_JR1$/);
  const merged = WORKDAY.mergeDetail(job, {
    jobPostingInfo: { jobDescription: "<p>Build things</p>", startDate: "2026-08-21", timeType: "Full time" },
  });
  assert.equal(merged.description, "Build things");
  assert.equal(merged.publishedAt, "2026-08-21");
  assert.equal(merged.employmentType, "Full time");
});

test("discover: builds host::siteName from a Workday link on a careers page", async () => {
  const { extractSignatures } = await import("../src/discover.js");
  assert.deepEqual(
    extractSignatures('<a href="https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite">Careers</a>'),
    [{ provider: "workday", slug: "nvidia.wd5.myworkdayjobs.com::NVIDIAExternalCareerSite" }],
  );
});

test("Workable, Recruitee, BambooHR, Breezy and Teamtailor normalise correctly", async () => {
  const { WORKABLE, RECRUITEE, BAMBOOHR, BREEZY, TEAMTAILOR } = await import("../src/providers.js");

  const wk = WORKABLE.parse({ jobs: [{
    title: "Analytics Engineer", shortcode: "B76C11", employment_type: "Full-time",
    telecommuting: false, department: "BI", url: "https://apply.workable.com/j/B76C11",
    city: "London", country: "United Kingdom", published_on: "2026-07-10",
  }] }, "zego");
  assert.equal(wk[0].id, "B76C11");
  assert.equal(wk[0].remote, false, "telecommuting:false means not remote, not unknown");
  assert.match(wk[0].location, /London/);

  const rc = RECRUITEE.parse({ offers: [{
    id: 7, title: "PM", careers_url: "https://jobs.x.com/o/pm", location: "Utrecht, NL",
    department: "Product", employment_type_code: "fulltime_permanent", remote: false,
    salary: { min: "4500", max: "6000", currency: "EUR", period: "month" },
  }] }, "channable");
  assert.equal(rc[0].salary, "4500–6000 EUR/month", "salary is folded into one readable line");
  assert.equal(rc[0].employmentType, "fulltime permanent");

  const bb = BAMBOOHR.parse({ result: [{
    id: "15", jobOpeningName: "IT Security Engineer", departmentLabel: "IT",
    employmentStatusLabel: "Full-Time", location: { city: "Mayfair", state: "London" }, isRemote: null,
  }] }, "pandadoc");
  assert.equal(bb[0].url, "https://pandadoc.bamboohr.com/careers/15");
  assert.equal(bb[0].remote, null, "what the platform does not report is null, not false");

  const bz = BREEZY.parse([{
    id: "abc", friendly_id: "abc-x", name: "Employee", url: "https://x.breezy.hr/p/abc",
    type: { name: "Other" }, location: { name: "Chaos, FL", is_remote: false },
    department: "D", salary: "$0.05 – $0.06 / hour", published_date: "2024-02-15T14:37:22Z",
  }], "breezy");
  assert.equal(bz[0].salary, "$0.05 – $0.06 / hour");
  assert.equal(BREEZY.parse([{ id: "x", text: "Lever job" }], "y"), null, "not confused with another platform's bare array");

  const tt = TEAMTAILOR.parse({ items: [{
    id: "eb97", title: "Staff Engineer", url: "https://career.instabee.com/jobs/1",
    date_published: "2026-05-20T10:07:53+02:00", content_html: "<p>Hi</p>",
    _jobposting: { employmentType: "FULL_TIME", jobLocation: { address: { addressLocality: "Stockholm", addressCountry: "SE" } } },
  }] }, "instabee");
  assert.equal(tt[0].employmentType, "FULL_TIME");
  assert.match(tt[0].location, /Stockholm/);
  assert.equal(tt[0].description, "Hi");
});

test("Teamtailor: works for tenants running on their own domain", async () => {
  const { TEAMTAILOR } = await import("../src/providers.js");
  assert.equal(TEAMTAILOR.endpoint("career.instabee.com"), "https://career.instabee.com/jobs.json");
  assert.equal(TEAMTAILOR.endpoint("instabee"), "https://instabee.teamtailor.com/jobs.json");
});

test("Recruitee: keeps the trailing slash on the endpoint (dropping it 404s)", async () => {
  const { RECRUITEE } = await import("../src/providers.js");
  assert.match(RECRUITEE.endpoint("channable"), /\/api\/offers\/$/);
});
