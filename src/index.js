/**
 * ats-jobs — read job postings from the official public job-board APIs of 12 ATS platforms.
 *
 * Every supported platform exposes an unauthenticated JSON (or XML) endpoint that a company's own
 * careers page calls to draw its job list. This library calls the same endpoint. It never parses
 * HTML for job data, so it does not break when a careers site is redesigned, and it is not
 * fighting bot protection.
 */

export { fetchCompany, filterJobs } from "./fetcher.js";
export { discoverFromWebsite, extractSignatures } from "./discover.js";
export { PROVIDERS, PROVIDERS_BY_ID, slugVariants } from "./providers.js";
