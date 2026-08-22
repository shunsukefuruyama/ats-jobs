#!/usr/bin/env node
/**
 * ats-jobs — command line interface.
 *
 *   npx ats-jobs stripe.com openai.com
 *   npx ats-jobs --json --keyword engineer stripe.com
 *   npx ats-jobs https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite
 */

import { fetchCompany, filterJobs } from "../src/index.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const companies = args.filter((a, i) => !a.startsWith("--") && !String(args[i - 1] ?? "").startsWith("--"));

if (companies.length === 0 || flag("help")) {
  console.log(`ats-jobs — read jobs from the official public job-board API of 12 ATS platforms

  Usage:
    ats-jobs <company|url> [...]        one or more company domains or careers URLs
    ats-jobs --json stripe.com          machine-readable output
    ats-jobs --keyword engineer x.com   only jobs matching a keyword
    ats-jobs --location london x.com    only jobs in a location
    ats-jobs --remote x.com             only remote jobs
    ats-jobs --limit 20 x.com           cap the number of jobs per company

  Examples:
    ats-jobs stripe.com
    ats-jobs greenhouse:airbnb workable:zego
    ats-jobs https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite

  Supported: greenhouse, workday, ashby, lever, smartrecruiters, rippling,
             workable, recruitee, bamboohr, breezy, teamtailor, personio`);
  process.exit(companies.length === 0 ? 1 : 0);
}

const limit = Number(value("limit") ?? 0);
const asJson = flag("json");
const out = [];

for (const company of companies) {
  const result = await fetchCompany(company, {
    includeDescription: flag("descriptions"),
    maxJobs: limit,
    log: asJson ? () => {} : (m) => console.error(m),
  });

  if (result.error) {
    console.error(`${company}: ${result.error}`);
    continue;
  }

  let jobs = filterJobs(result.jobs, {
    keyword: value("keyword"),
    location: value("location"),
    remoteOnly: flag("remote"),
  });
  if (limit > 0) jobs = jobs.slice(0, limit);

  for (const j of jobs) {
    out.push({ company, ats: result.provider, ...j });
    if (!asJson) {
      console.log(
        [j.title, j.location, j.department, j.salary].filter(Boolean).join("  |  ") + `\n  ${j.url}`,
      );
    }
  }
}

if (asJson) console.log(JSON.stringify(out, null, 2));
