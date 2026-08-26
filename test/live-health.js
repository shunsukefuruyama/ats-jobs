#!/usr/bin/env node
/**
 * Live health check against the real ATS APIs. Different purpose from the unit tests.
 *
 * `npm test` asks "is our own code still correct?".
 * This asks "have the upstream platforms changed?" — which is the failure mode that
 * actually breaks callers, and the one no unit test can see.
 *
 *   node test/live-health.js          # human readable
 *   node test/live-health.js --json   # machine readable
 *
 * Exit code: 0 if everything passes, 1 if anything fails.
 */

import { fetchCompany } from "../src/fetcher.js";

/**
 * One real company per provider that reliably has open roles.
 * A failure here means that provider's read path is broken.
 *
 * If a case fails, suspect the company first (they may have paused hiring) and swap it out —
 * pick employers large enough that they never stop posting. Visa was replaced for exactly
 * this reason after it briefly showed zero roles.
 */
const CASES = [
  { provider: "greenhouse", input: "greenhouse:stripe", minJobs: 10 },
  { provider: "ashby", input: "https://jobs.ashbyhq.com/openai", minJobs: 10 },
  { provider: "lever", input: "lever:leverdemo", minJobs: 10 },
  { provider: "rippling", input: "https://ats.rippling.com/rippling/jobs", minJobs: 10 },
  { provider: "smartrecruiters", input: "smartrecruiters:Sodexo", minJobs: 20 },
  { provider: "workday", input: "https://cisco.wd5.myworkdayjobs.com/Cisco_Careers", minJobs: 50 },
  { provider: "workable", input: "workable:zego", minJobs: 5 },
  { provider: "recruitee", input: "recruitee:channable", minJobs: 3 },
  // pandadoc was the sample until 2026-08-24, when its BambooHR account expired
  // (/careers/list now 302s to /settings/account/expired.php). Swapped, and the
  // library now says so out loud instead of reporting "no ATS found".
  { provider: "bamboohr", input: "bamboohr:userpilot", minJobs: 1 },
  { provider: "breezy", input: "breezy:breezy", minJobs: 1 },
  { provider: "teamtailor", input: "teamtailor:career.instabee.com", minJobs: 5 },
  // Passing a bare domain must still resolve to the right platform.
  { provider: "greenhouse", input: "stripe.com", minJobs: 10, label: "auto-detect" },
  // Reading a careers page to identify the ATS. If this breaks, "just give it a domain" stops working.
  { provider: "rippling", input: "getguru.com", minJobs: 1, label: "site discovery" },
];

const asJson = process.argv.includes("--json");
const results = [];

for (const c of CASES) {
  const started = Date.now();
  let row;
  try {
    const r = await fetchCompany(c.input, { includeDescription: false });
    const ok = r.provider === c.provider && r.jobs.length >= c.minJobs;
    row = {
      provider: c.provider,
      label: c.label ?? "",
      input: c.input,
      ok,
      detected: r.provider,
      jobs: r.jobs.length,
      ms: Date.now() - started,
      reason: ok
        ? ""
        // The library's own error is the most useful thing we have; never drop it.
        // "detected as nothing" hid an expired account for an unknown length of time.
        : r.error
          ? r.error
          : r.provider !== c.provider
            ? `detected as ${r.provider ?? "nothing"}`
            : `only ${r.jobs.length} roles returned (expected at least ${c.minJobs})`,
    };
  } catch (err) {
    row = {
      provider: c.provider,
      input: c.input,
      ok: false,
      jobs: 0,
      ms: Date.now() - started,
      reason: String(err),
    };
  }
  results.push(row);
  if (!asJson) {
    const mark = row.ok ? "PASS" : "FAIL";
    const label = row.label ? ` (${row.label})` : "";
    console.log(
      `${mark}  ${(row.provider + label).padEnd(28)} ${String(row.jobs).padStart(5)} roles  ${String(row.ms).padStart(5)}ms  ${row.reason}`,
    );
  }
}

const failed = results.filter((r) => !r.ok);

if (asJson) {
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), failed: failed.length, results }, null, 1));
} else {
  console.log(
    failed.length === 0
      ? `\nAll ${results.length} checks passed. No upstream changes detected.`
      : `\n${failed.length} of ${results.length} checks failed.`,
  );
}

process.exit(failed.length === 0 ? 0 : 1);
