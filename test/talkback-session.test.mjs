// Talkback session handling: a live stream warmed and confirmed before the talkback opens, the device's
// answer to the talkback start awaited (and the open retried when it is busy or silent), `delay_ms`, and
// a log line for every stage. Fakes the SDK camera's live() + talkback() and the client's raw `p2p` feed.
import http from "node:http";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createTalkback } from "../src/talkback.mjs";

const SN = "T85V0K102515088E";

function adtsFrame(payload = 20) {
  const len = 7 + payload;
  const h = Buffer.from([0xff, 0xf1, 0x60, 0x40 | ((len >> 11) & 3), (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc]);
  return Buffer.concat([h, Buffer.alloc(payload, 0x11)]);
}
const adts = (n) => Buffer.concat(Array.from({ length: n }, () => adtsFrame()));

const code = (n) => {
  const b = Buffer.alloc(132);
  b.writeInt32LE(n, 0);
  return b;
};

/**
 * A fake device. `answers` is the int32 code the device answers each talkback start with (in order),
 * or `null` for no answer at all; `liveFrame: false` makes the live stream never deliver.
 */
function setup({ env = {}, answers = [0], liveFrame = true, audioCodec = "aac-eld", live = true } = {}) {
  const events = [];
  const handles = [];
  const consumers = [];
  const eufy = new EventEmitter();
  const cam = {
    talkback: async () => {
      events.push("talkback");
      const h = new EventEmitter();
      h.pending = 0;
      h.stops = 0;
      h.writable = () =>
        new Writable({
          write: (_c, _e, cb) => cb(),
          final: (cb) => {
            cb();
            setImmediate(() => h.emit("finished"));
          },
        });
      h.stop = async () => {
        h.stops += 1;
        if (h.stops === 1) h.emit("stop");
      };
      handles.push(h);
      const answer = answers[handles.length - 1];
      if (answer !== null && answer !== undefined)
        setImmediate(() =>
          eufy.emit("p2p", {
            stationSn: SN,
            channel: 0,
            commandId: 1700,
            commandName: "CMD_CONTROL_PAYLOAD",
            data: code(answer),
          }),
        );
      return h;
    },
  };
  if (live)
    cam.live = async () => {
      events.push("live");
      const c = new EventEmitter();
      c.stopped = false;
      c.stop = () => {
        c.stopped = true;
        events.push("live.stop");
      };
      consumers.push(c);
      if (liveFrame)
        setImmediate(() => {
          c.emit("audio", { codec: audioCodec, data: Buffer.alloc(4) });
          c.emit("video", { keyframe: true, codec: "h264", width: 1920, height: 1080 });
        });
      return c;
    };
  eufy.getDevice = async () => ({ stationSn: SN, camera: () => cam });
  const config = loadConfig({
    EUFY_EMAIL: "x@y.z",
    EUFY_PASSWORD: "pw",
    BRIDGE_TALKBACK_CONFIRM_MS: "200",
    BRIDGE_TALKBACK_RETRY_DELAY_MS: "0",
    BRIDGE_TALKBACK_WARM_TIMEOUT_MS: "200",
    ...env,
  });
  const logs = [];
  const state = createState();
  state.flags.ready = true;
  const ctx = {
    ...config,
    state,
    eufy,
    eventLog: (l) => logs.push(l),
    authStatus: () => ({ state: "ok" }),
    transcodeTalkback: async () => adts(10),
  };
  Object.assign(ctx, createTalkback(ctx));
  return { ctx, eufy, events, handles, consumers, logs };
}

const until = async (cond) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

test("the live stream is confirmed before the talkback opens, the device's answer before audio flows", async () => {
  const { ctx, events, consumers, handles, logs } = setup();
  const r = await ctx.talkbackPlay(SN, { audio: Buffer.from("A"), wait: true });
  assert.equal(r.finished, true);
  assert.equal(r.attempts, 1);
  assert.equal(r.confirmation, "answered 1700");
  assert.equal(r.deviceAudioCodec, "aac-eld");
  assert.equal(r.framesSent, 10);
  assert.deepEqual(events, ["live", "talkback", "live.stop"]); // live first, released after playback
  assert.equal(consumers[0].stopped, true);
  assert.equal(handles[0].stops >= 1, true);
  const stages = [
    /live stream requested/,
    /device's own live audio codec: aac-eld/,
    /live stream confirmed in \d+ ms \(video h264 1920x1080\)/,
    /session requested \(attempt 1\/2\)/,
    /device answered CMD_CONTROL_PAYLOAD\(1700\) 132B code=0 head=00000000/,
    /session confirmed \(answered 1700\)/,
    /codec: sending AAC-LC 16000 Hz mono ADTS, 10 frames \(640 ms\).*device's own live audio: aac-eld \(differs/,
    /frames sent: 10\/10/,
    /stopped \(finished\)/,
  ];
  let at = 0;
  for (const re of stages) {
    const i = logs.findIndex((l, idx) => idx >= at && re.test(l));
    assert.ok(i >= 0, `missing or out of order: ${re} in\n${logs.join("\n")}`);
    at = i + 1;
  }
  assert.deepEqual(ctx.talkbackActive(), []);
});

test("a busy answer retries the open; the second, accepted open plays", async () => {
  const { ctx, handles, logs } = setup({ answers: [-114, 0] });
  const r = await ctx.talkbackPlay(SN, { audio: Buffer.from("A"), wait: true });
  assert.equal(r.attempts, 2);
  assert.equal(handles.length, 2);
  assert.equal(handles[0].stops, 1); // the refused session was closed before the retry
  assert.ok(logs.some((l) => /session not confirmed: device busy \(code -114\)/.test(l)));
});

test("no answer on any attempt is a 502, and the live stream and slot are released", async () => {
  const { ctx, handles, consumers } = setup({ answers: [null, null] });
  await assert.rejects(
    ctx.talkbackPlay(SN, { audio: Buffer.from("A") }),
    (e) => e.status === 502 && /not confirmed .* after 2 attempt\(s\): no answer within 200 ms/.test(e.message),
  );
  assert.equal(handles.length, 2);
  assert.ok(handles.every((h) => h.stops === 1));
  assert.equal(consumers[0].stopped, true);
  assert.deepEqual(ctx.talkbackActive(), []);
});

test("BRIDGE_TALKBACK_CONFIRM_MS=0 takes the start on trust, as the SDK does", async () => {
  const { ctx } = setup({ answers: [null], env: { BRIDGE_TALKBACK_CONFIRM_MS: "0" } });
  const r = await ctx.talkbackPlay(SN, { audio: Buffer.from("A"), wait: true });
  assert.equal(r.confirmation, "not awaited");
});

test("a live stream that never delivers a frame is a 502 before the talkback is opened", async () => {
  const { ctx, events, consumers } = setup({ liveFrame: false });
  await assert.rejects(
    ctx.talkbackPlay(SN, { audio: Buffer.from("A") }),
    (e) => e.status === 502 && /live stream not confirmed: no video frame within 200 ms/.test(e.message),
  );
  assert.deepEqual(events, ["live", "live.stop"]);
  assert.equal(consumers[0].stopped, true);
  assert.deepEqual(ctx.talkbackActive(), []);
});

test("BRIDGE_TALKBACK_LIVESTREAM=0 skips the live stream", async () => {
  const { ctx, events, logs } = setup({ env: { BRIDGE_TALKBACK_LIVESTREAM: "0" } });
  const r = await ctx.talkbackPlay(SN, { audio: Buffer.from("A"), wait: true });
  assert.equal(r.deviceAudioCodec, null);
  assert.deepEqual(events, ["talkback"]);
  assert.ok(logs.some((l) => /live stream skipped \(BRIDGE_TALKBACK_LIVESTREAM=0\)/.test(l)));
});

test("delay_ms waits before anything is opened; the env sets the default; a stop during it opens nothing", async () => {
  const { ctx, events } = setup();
  const t0 = Date.now();
  const r = await ctx.talkbackPlay(SN, { audio: Buffer.from("A"), delayMs: 120, wait: true });
  assert.equal(r.delayMs, 120);
  assert.ok(Date.now() - t0 >= 110);
  assert.equal(events[0], "live");

  const env = setup({ env: { BRIDGE_TALKBACK_DELAY_MS: "5000" } });
  const pending = env.ctx.talkbackPlay(SN, { audio: Buffer.from("A") });
  await until(() => env.logs.some((l) => /waiting 5000 ms/.test(l)));
  await assert.rejects(env.ctx.talkbackPlay(SN, { audio: Buffer.from("B") }), (e) => e.status === 409);
  assert.equal(await env.ctx.talkbackStop(SN), true);
  assert.deepEqual(await pending, { started: false, stopped: true, durationMs: 640 });
  assert.deepEqual(env.events, []);
  assert.deepEqual(env.ctx.talkbackActive(), []);
});

test("POST delay_ms: accepted in JSON and the query, 400 when out of range", async (t) => {
  const { ctx } = setup();
  const server = http.createServer(createHttpHandler(ctx));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api/talkback/${SN}`;
  const ok = await fetch(`${base}?delay_ms=10&wait=1`, { method: "POST", body: "A" });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).delayMs, 10);
  const json = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "http://x/a.mp3", delay_ms: -5 }),
  });
  assert.equal(json.status, 400);
  assert.match((await json.json()).error, /delay_ms/);
});

test("a stop while the live stream is warming ends cleanly, not as an error", async () => {
  const { ctx, consumers } = setup({ liveFrame: false, env: { BRIDGE_TALKBACK_WARM_TIMEOUT_MS: "5000" } });
  const pending = ctx.talkbackPlay(SN, { audio: Buffer.from("A") });
  await until(() => consumers.length === 1);
  await ctx.talkbackStop(SN);
  assert.deepEqual(await pending, { started: false, stopped: true, durationMs: 640 });
  assert.equal(consumers[0].stopped, true);
  assert.deepEqual(ctx.talkbackActive(), []);
});
