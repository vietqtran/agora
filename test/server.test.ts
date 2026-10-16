import { test } from "node:test";
import assert from "node:assert/strict";
import { isLoopback, parseStartBody, resolveToken, serve, MAX_BODY_BYTES } from "../src/server.ts";

/** `fetch().json()` is typed `unknown`; these tests assert on the shape deliberately. */
async function asJson(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}
import { RunManager } from "../src/runner.ts";
import { DEFAULTS, type AgoraConfig } from "../src/config.ts";
import { loadRoles } from "../src/roles.ts";
import type { AvailableProvider } from "../src/casting.ts";
import type { Presence } from "../src/detect.ts";

const roles = await loadRoles(process.cwd());

/** Three in-process mock runtimes, so the API is exercised with no CLI and no tokens. */
const MOCKS: AvailableProvider[] = [1, 2, 3].map((i) => ({
  key: `mock-${i}`,
  label: `Mock #${i}`,
  vendor: `mock-${i}`,
  caps: { execute: true, web: true, reportsCost: false },
}));

function testConfig(): AgoraConfig {
  return {
    ...DEFAULTS,
    outDir: `${process.env.TMPDIR ?? "/tmp"}/agora-server-test-${process.pid}`,
    custom: MOCKS.map((m) => ({ provider: "mock", id: m.key, label: m.label, vendor: m.vendor })),
  };
}

async function withServer<T>(fn: (base: string, token?: string) => Promise<T>, token?: string): Promise<T> {
  const running = await serve(
    {
      config: testConfig(),
      roles,
      discover: async () => [] as Presence[],
      toAvailable: () => MOCKS,
      runs: new RunManager(),
    },
    // Port 0 = let the OS pick, so parallel test files cannot collide on a port.
    { host: "127.0.0.1", port: 0, ...(token && { token }) },
  );
  try {
    return await fn(running.url, running.token);
  } finally {
    await running.close();
  }
}

// --- token policy -------------------------------------------------------------------

test("a loopback bind needs no token; a public bind gets one generated", () => {
  assert.equal(resolveToken({ host: "127.0.0.1", port: 1 }).token, undefined);
  const pub = resolveToken({ host: "0.0.0.0", port: 1 });
  assert.ok(pub.token && pub.token.length >= 20, "a public bind must not be left open");
  assert.equal(pub.generated, true);
});

test("an explicit token is honoured on any bind", () => {
  assert.deepEqual(resolveToken({ host: "127.0.0.1", port: 1, token: "abc" }), { token: "abc", generated: false });
});

test("loopback detection covers the forms a user actually types", () => {
  for (const h of ["127.0.0.1", "localhost", "::1", "[::1]"]) assert.ok(isLoopback(h), h);
  for (const h of ["0.0.0.0", "10.0.0.5", "109.123.252.60"]) assert.equal(isLoopback(h), false, h);
});

test("a protected server rejects a missing or wrong token but still serves the shell", async () => {
  await withServer(async (base) => {
    // The page itself must load, or the user cannot see where to type the token.
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/api/ping`)).status, 200);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    const ok = await fetch(`${base}/api/state`, { headers: { authorization: "Bearer s3cret" } });
    assert.equal(ok.status, 200);
    // EventSource cannot set headers, so the query form has to work too.
    assert.equal((await fetch(`${base}/api/runs?token=s3cret`)).status, 200);
  }, "s3cret");
});

test("ping tells the UI whether a token is required", async () => {
  await withServer(async (base) => {
    assert.equal((await asJson(await fetch(`${base}/api/ping`))).needsToken, false);
  });
  await withServer(async (base) => {
    assert.equal((await asJson(await fetch(`${base}/api/ping`))).needsToken, true);
  }, "t");
});

// --- request validation -------------------------------------------------------------

test("a run request is validated with messages the UI can show", () => {
  const ok = parseStartBody(
    { topic: " chủ đề ", roles: ["architect"], judge: "judge", rounds: 1, seats: { architect: { model: "opus" } } },
    roles,
  );
  assert.equal(ok.topic, "chủ đề");
  assert.deepEqual(ok.roleIds, ["architect"]);
  assert.equal(ok.seatOptions.architect.model, "opus");

  assert.throws(() => parseStartBody({ roles: ["architect"] }, roles), /thiếu chủ đề/);
  assert.throws(() => parseStartBody({ topic: "t", roles: [] }, roles), /ít nhất một vai/);
  assert.throws(() => parseStartBody({ topic: "t", roles: ["nope"] }, roles), /không tồn tại/);
  assert.throws(() => parseStartBody({ topic: "t", roles: ["architect"], judge: "nope" }, roles), /chủ tọa không tồn tại/);
});

test("rounds are capped, because a browser typo must not launch a thirty-turn debate", () => {
  assert.throws(() => parseStartBody({ topic: "t", roles: ["architect"], rounds: 99 }, roles), /từ 0 đến 6/);
  assert.throws(() => parseStartBody({ topic: "t", roles: ["architect"], rounds: -1 }, roles), /từ 0 đến 6/);
  assert.throws(() => parseStartBody({ topic: "t", roles: ["architect"], rounds: 1.5 }, roles), /từ 0 đến 6/);
  assert.equal(parseStartBody({ topic: "t", roles: ["architect"], rounds: 0 }, roles).rounds, 0);
});

test("material aimed at an unknown role is refused, not silently shared with everyone", () => {
  // Silently promoting it to shared material would leak a document the user meant to
  // keep to one seat — the exact guarantee the private-material feature sells.
  assert.throws(
    () => parseStartBody({ topic: "t", roles: ["architect"], material: [{ role: "nope", text: "x" }] }, roles),
    /tư liệu gán cho vai không tồn tại/,
  );
});

test("blank material entries are dropped", () => {
  const p = parseStartBody({ topic: "t", roles: ["architect"], material: [{ text: "   " }, { text: "có nội dung" }] }, roles);
  assert.equal(p.materialEntries.length, 1);
});

// --- run lifecycle ------------------------------------------------------------------

test("a full run goes through the API and streams to completion", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: "chủ đề kiểm thử",
        roles: ["architect", "domain-expert"],
        judge: "judge",
        rounds: 1,
        seats: {
          architect: { provider: "mock-1" },
          "domain-expert": { provider: "mock-2" },
          judge: { provider: "mock-3" },
        },
        material: [{ text: "nền chung" }, { role: "architect", text: "RIÊNG KIẾN TRÚC SƯ" }],
      }),
    });
    assert.equal(res.status, 201);
    const { id, cast } = await asJson(res);
    assert.equal(cast.debaters.length, 2);

    // Subscribing AFTER the POST is the real browser sequence; the buffer must replay.
    const stream = await fetch(`${base}/api/runs/${id}/events`);
    const text = await stream.text();
    assert.match(text, /event: debate/);
    assert.match(text, /event: final/);
    assert.match(text, /"type":"phase"/);
    assert.match(text, /"type":"questions"/);

    const { run } = await asJson(await fetch(`${base}/api/runs/${id}`));
    assert.equal(run.status, "done");
    assert.ok(run.dir, "a finished run must have written its artifacts");

    const dossier = await (await fetch(`${base}/api/runs/${id}/artifact?name=dossier.md`)).text();
    assert.ok(dossier.length > 0);

    const transcript = await (await fetch(`${base}/api/runs/${id}/artifact?name=transcript.md`)).text();
    assert.doesNotMatch(transcript, /RIÊNG KIẾN TRÚC SƯ/, "private material leaked through the API path");
  });
});

test("artifact serving is allowlisted, so no path can escape the run directory", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "t", roles: ["architect", "domain-expert"], rounds: 0, judge: null }),
    });
    const { id } = await asJson(res);
    await (await fetch(`${base}/api/runs/${id}/events`)).text(); // wait for completion

    for (const bad of ["../../../../etc/passwd", "/etc/passwd", "run.json/../../x"]) {
      const r = await fetch(`${base}/api/runs/${id}/artifact?name=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 400, `accepted a bad artifact name: ${bad}`);
    }
    assert.equal((await fetch(`${base}/api/runs/${id}/artifact?name=run.json`)).status, 200);
  });
});

test("an unknown run id is a 404, not a crash", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/runs/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/runs/nope/events`)).status, 404);
    assert.equal((await fetch(`${base}/api/nothing-here`)).status, 404);
  });
});

test("a bad request is a 400 with the reason, not a 500", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roles: ["architect"] }),
    });
    assert.equal(r.status, 400);
    assert.match((await asJson(r)).error, /thiếu chủ đề/);
  });
});

test("the UI shell is served and references the API", async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /\/api\/state/);
    assert.match(html, /EventSource/);
  });
});

test("the body limit is a real number, not unbounded", () => {
  assert.ok(MAX_BODY_BYTES > 0 && MAX_BODY_BYTES <= 32 * 1024 * 1024);
});

test("declared custom runtimes appear in the runtime picker, not just discovered ones", async () => {
  // The regression this guards: /api/state built its provider list from the probe
  // results alone, so on a machine whose only CLIs are declared in config the UI's
  // runtime dropdown came back empty — breaking the picker on exactly the setups this
  // project is meant to support.
  await withServer(async (base) => {
    const st = await asJson(await fetch(`${base}/api/state`));
    const keys = st.providers.filter((p: any) => p.available).map((p: any) => p.key);
    for (const m of MOCKS) assert.ok(keys.includes(m.key), `missing declared runtime ${m.key}`);
    assert.deepEqual([...st.availableKeys].sort(), MOCKS.map((m) => m.key).sort());
  });
});
