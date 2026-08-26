import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchCompany } from "../src/fetcher.js";

/**
 * A board that used to exist and now does not must say so.
 *
 * On 2026-08-24 the BambooHR sample employer's account expired. `/careers/list` began
 * 302ing to `/settings/account/expired.php`, `fetch` followed the redirect, the HTML that
 * came back was not JSON, `parse()` returned null, and the library reported
 * "No supported ATS job board found".
 *
 * That answer sends the caller to check their own input, which is fine, and never tells them
 * the board is gone, which is the one thing they needed to know. These tests hold that line
 * without touching the network.
 */

/** Replace global fetch for the duration of one test, then put it back. */
function withFetch(fake, run) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  return run().finally(() => {
    globalThis.fetch = real;
  });
}

/** What an expired BambooHR account actually serves, after the redirect is followed. */
function expiredAccountResponse(requestedUrl) {
  const slug = new URL(requestedUrl).hostname.split(".")[0];
  return {
    ok: true,
    status: 200,
    url: `https://${slug}.bamboohr.com/settings/account/expired.php`,
    headers: new Map(),
    text: async () => "<html><body>This account has expired.</body></html>",
  };
}

test("a board that redirects away is reported as gone, not as 'no ATS found'", async () => {
  const result = await withFetch(
    async (url) => expiredAccountResponse(url),
    () => fetchCompany("bamboohr:someclosedcompany", { includeDescription: false }),
  );

  assert.equal(result.jobs.length, 0);
  assert.match(result.error, /no longer exists/i);
  assert.match(result.error, /expired\.php/);
  assert.ok(result.goneTo, "the caller needs the destination to see what happened");
  assert.doesNotMatch(
    result.error,
    /No supported ATS job board found/,
    "that message sends the caller to debug their own input",
  );
});

test("the destination of the redirect is carried through, not summarised away", async () => {
  const result = await withFetch(
    async (url) => expiredAccountResponse(url),
    () => fetchCompany("bamboohr:someclosedcompany", { includeDescription: false }),
  );
  assert.equal(
    result.goneTo,
    "https://someclosedcompany.bamboohr.com/settings/account/expired.php",
  );
});

test("a board that answers normally with no openings is NOT reported as gone", async () => {
  // An empty board is a different fact from a dead one. Confusing the two in the other
  // direction would be just as wrong.
  const result = await withFetch(
    async (url) => ({
      ok: true,
      status: 200,
      url, // no redirect
      headers: new Map(),
      text: async () => JSON.stringify({ meta: { totalCount: 0 }, result: [] }),
    }),
    () => fetchCompany("bamboohr:quietcompany", { includeDescription: false }),
  );

  assert.equal(result.jobs.length, 0);
  assert.ok(!result.goneTo, "nothing was gone; the board answered");
  if (result.error) {
    assert.doesNotMatch(result.error, /no longer exists/i);
  }
});
