/**
 * The terminal half of signing up for a brain.
 *
 * Two of these are security-relevant rather than merely correct. The listener
 * must refuse a handoff that does not echo the state it generated, because it
 * is an open port on the developer's machine and any page they have open can
 * reach loopback. And it must bind to loopback only, so the handoff is not
 * offered to the network the laptop is sitting on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CALLBACK_PATH, signupUrl, startHandoff } from "../src/brain/signup.js";

/** Drive the callback the way the browser would. */
async function callback(port: number, q: Record<string, string>): Promise<number> {
  const url = `http://127.0.0.1:${port}${CALLBACK_PATH}?${new URLSearchParams(q).toString()}`;
  const res = await fetch(url);
  await res.text();
  return res.status;
}

test("handoff: the browser's answer becomes the link", async () => {
  const h = await startHandoff();
  const waiting = h.wait(5000);

  const status = await callback(h.port, { state: h.state, brain: "brain-123", token: "gbt_1.abc" });
  assert.equal(status, 200);

  const got = await waiting;
  assert.deepEqual(got, { link: { brainId: "brain-123", token: "gbt_1.abc" } });
});

test("handoff: a wrong state is refused and never settles the wait", async () => {
  const h = await startHandoff();
  const waiting = h.wait(300);

  const status = await callback(h.port, { state: "not-the-state", brain: "brain-123", token: "gbt_1.abc" });
  assert.equal(status, 400, "a mismatched state is rejected outright");

  const got = await waiting;
  assert.ok("error" in got, "the push must not proceed on a handoff it did not ask for");
});

test("handoff: the right state without a brain and token is an error, not a link", async () => {
  const h = await startHandoff();
  const waiting = h.wait(5000);

  const status = await callback(h.port, { state: h.state, brain: "", token: "" });
  assert.equal(status, 400);

  const got = await waiting;
  assert.ok("error" in got);
});

test("handoff: anything but the callback path is a 404", async () => {
  const h = await startHandoff();
  const res = await fetch(`http://127.0.0.1:${h.port}/`);
  await res.text();
  assert.equal(res.status, 404);
  h.close();
});

test("handoff: the wait gives up rather than hanging forever", async () => {
  const h = await startHandoff();
  const got = await h.wait(150);
  assert.ok("error" in got);
  assert.match((got as { error: string }).error, /timed out/);
});

test("signup url: carries the repo, the port and the state", () => {
  const url = new URL(signupUrl({ repo: "NanoNets/Graft", port: 51234, state: "s-t-a-t-e" }));
  // Trail's front end, not the shared agents host link.ts calls for the API:
  // the signup a person walks through has to be the Trail-branded build.
  assert.equal(url.origin, "https://app.trailhq.com");
  assert.equal(url.pathname, "/get-started");
  assert.equal(url.searchParams.get("graft_repo"), "NanoNets/Graft");
  assert.equal(url.searchParams.get("graft_port"), "51234");
  assert.equal(url.searchParams.get("graft_state"), "s-t-a-t-e");
  assert.equal(url.searchParams.get("step"), "repo");
});

test("signup url: GRAFT_BRAIN_URL points signup at staging too", () => {
  const before = process.env.GRAFT_BRAIN_URL;
  process.env.GRAFT_BRAIN_URL = "https://staging-agents.nanonets.com/";
  try {
    const url = new URL(signupUrl({ repo: "a/b", port: 1, state: "s" }));
    assert.equal(url.origin, "https://staging-agents.nanonets.com", "a trailing slash must not double up");
  } finally {
    if (before === undefined) delete process.env.GRAFT_BRAIN_URL;
    else process.env.GRAFT_BRAIN_URL = before;
  }
});

// The browser's last stop is Trail, not a local page that is about to stop
// answering. Ending on "go back to your terminal" wasted the one moment the
// brain is actually being built and there is something on screen worth seeing.
//
// And specifically the BUILD screen, not `/brain/<id>`, which is where this went
// first: that route redirects to the brain's graph the instant the row exists,
// which is minutes before it holds a single rule. So every terminal signup was
// landing on an empty visualisation of a brain that was building perfectly well.
test('the accepted handoff sends the browser to the build screen, not an empty graph', async () => {
  process.env.GRAFT_BRAIN_URL = 'http://localhost:5173';
  const handoff = await startHandoff();
  try {
    const res = await fetch(
      `http://127.0.0.1:${handoff.port}${CALLBACK_PATH}?state=${encodeURIComponent(handoff.state)}&brain=abc-123&token=gbt_1.xyz`,
      { redirect: 'manual' },
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), 'http://localhost:5173/get-started?step=build&brain=abc-123');
    const got = await handoff.wait(1000);
    assert.deepEqual(got, { link: { brainId: 'abc-123', token: 'gbt_1.xyz' } });
  } finally {
    handoff.close();
    delete process.env.GRAFT_BRAIN_URL;
  }
});
