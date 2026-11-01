// Talkback playback: POST /api/talkback/<sn> and WS device.talkback_play. Drives the real HTTP handler,
// WS handler and talkback module against a fake SDK camera whose talkback handle records what it was
// fed; the transcode is faked except in the ffmpeg tests, which skip where ffmpeg is not installed.
import http from "node:http";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createWsServer } from "../src/ws-server.mjs";
import { adtsFrameCount, createTalkback, transcodeArgs, transcodeToAdts } from "../src/talkback.mjs";

/** One ADTS frame header + payload: AAC-LC, `rateIndex` (8 = 16 kHz), `channels`. */
function adtsFrame(payload = 20, { rateIndex = 8, channels = 1 } = {}) {
  const len = 7 + payload;
  const h = Buffer.from([
    0xff,
    0xf1,
    (1 << 6) | (rateIndex << 2) | (channels >> 2),
    ((channels & 3) << 6) | ((len >> 11) & 3),
    (len >> 3) & 0xff,
    ((len & 7) << 5) | 0x1f,
    0xfc,
  ]);
  return Buffer.concat([h, Buffer.alloc(payload, 0x11)]);
}
const adts = (frames) => Buffer.concat(Array.from({ length: frames }, () => adtsFrame()));

/** A stand-in for the SDK's TalkbackHandle: collects what is piped in and fires `finished` after `final`. */
function fakeHandle({ hold = false } = {}) {
  const h = new EventEmitter();
  h.received = [];
  h.stops = 0;
  h.writable = () =>
    new Writable({
      write(chunk, _enc, cb) {
        h.received.push(chunk);
        cb();
      },
      final(cb) {
        cb();
        if (!hold) setImmediate(() => h.emit("finished"));
      },
    });
  h.stop = async () => {
    h.stops += 1;
    if (h.stops === 1) h.emit("stop");
  };
  return h;
}

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function setup({ env = {}, devices, transcode, ready = true } = {}) {
  const handles = [];
  const transcodes = [];
  const opens = [];
  const cam = {
    talkback: async (opts) => {
      opens.push(opts);
      const h = fakeHandle(setup.handleOpts);
      handles.push(h);
      return h;
    },
  };
  const devs = devices ?? { CAM1: { camera: () => cam }, SENSOR1: { camera: () => undefined } };
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", ...env });
  const state = createState();
  state.flags.ready = ready;
  const ctx = {
    ...config,
    state,
    eventLog: () => {},
    authStatus: () => ({ state: ready ? "ok" : "pending" }),
    eufy: {
      getDevice: async (sn) => {
        if (!devs[sn]) throw new Error(`device ${sn} not found`);
        return devs[sn];
      },
    },
    transcodeTalkback:
      transcode ??
      (async (input, opts) => {
        transcodes.push({ input, opts });
        return adts(10); // 640 ms
      }),
  };
  Object.assign(ctx, createTalkback(ctx));
  return { ctx, handles, transcodes, opens, cam };
}

async function serve(t, ctx) {
  const server = http.createServer(createHttpHandler(ctx));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

/** A tiny file server standing in for Home Assistant's /local/ path. */
async function mediaServer(t, routes) {
  const server = http.createServer((req, res) => {
    const body = routes[req.url];
    if (body == null) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "audio/mpeg", "content-length": body.length });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

const postJson = (base, path, body) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const until = async (cond) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

test("adtsFrameCount: counts AAC-LC 16 kHz mono frames and rejects anything else", () => {
  assert.equal(adtsFrameCount(adts(3)), 3);
  assert.equal(adtsFrameCount(Buffer.alloc(0)), 0);
  assert.throws(() => adtsFrameCount(adtsFrame(20, { rateIndex: 4 })), /16 kHz mono/); // 44.1 kHz
  assert.throws(() => adtsFrameCount(adtsFrame(20, { channels: 2 })), /16 kHz mono/);
  assert.throws(() => adtsFrameCount(Buffer.from("ID3 not adts at all")), /not ADTS/);
  assert.throws(() => adtsFrameCount(adtsFrame(20).subarray(0, 15)), /malformed/);
});

test("transcodeArgs: mono 16 kHz AAC-LC ADTS, capped, gain only when asked, no -re", () => {
  const args = transcodeArgs({ maxSeconds: 12, volume: 100 }).join(" ");
  assert.match(args, /-i pipe:0/);
  assert.match(args, /-t 12/);
  assert.match(args, /-ac 1 -ar 16000 -c:a aac -profile:a aac_low/);
  assert.match(args, /-f adts pipe:1$/);
  assert.doesNotMatch(args, /-re|volume=/); // the SDK paces frames itself
  assert.match(transcodeArgs({ maxSeconds: 5, volume: 50 }).join(" "), /-af volume=0\.5/);
});

test(
  "transcodeToAdts: real ffmpeg turns an MP3 into device-ready ADTS, cut at maxSeconds",
  { skip: !hasFfmpeg },
  async () => {
    const mp3 = execFileSync("ffmpeg", [
      ...["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=44100"],
      ...["-ac", "2", "-c:a", "libmp3lame", "-f", "mp3", "pipe:1"],
    ]);
    const full = await transcodeToAdts(mp3, { maxSeconds: 30, volume: 100 });
    const fullMs = adtsFrameCount(full) * 64;
    assert.ok(fullMs > 2800 && fullMs < 3300, `3 s clip decoded to ${fullMs} ms`);
    const cut = await transcodeToAdts(mp3, { maxSeconds: 1, volume: 80 });
    const cutMs = adtsFrameCount(cut) * 64;
    assert.ok(cutMs > 900 && cutMs < 1300, `1 s cap gave ${cutMs} ms`);
  },
);

test("transcodeToAdts: undecodable input is a 422", { skip: !hasFfmpeg }, async () => {
  await assert.rejects(
    transcodeToAdts(Buffer.from("definitely not audio"), { maxSeconds: 5 }),
    (e) => e.status === 422,
  );
});

test("POST JSON url: fetches the clip, streams it to the speaker, answers 202 with the duration", async (t) => {
  const { ctx, handles, transcodes } = setup();
  const media = await mediaServer(t, { "/local/scream.mp3": Buffer.from("MP3DATA") });
  const base = await serve(t, ctx);
  const r = await postJson(base, "/api/talkback/CAM1", {
    url: `${media}/local/scream.mp3`,
    volume: 150,
    max_seconds: 10,
  });
  assert.equal(r.status, 202);
  const body = await r.json();
  assert.deepEqual(body, { ok: true, sn: "CAM1", durationMs: 640, maxSeconds: 10, volume: 150, started: true });
  assert.equal(transcodes[0].input.toString(), "MP3DATA");
  assert.deepEqual(transcodes[0].opts, { maxSeconds: 10, volume: 150 });
  await until(() => handles[0]?.stops > 0);
  assert.deepEqual(Buffer.concat(handles[0].received), adts(10)); // every frame reached the handle
  assert.equal(handles[0].stops >= 1, true); // closed cleanly after `finished`
  assert.deepEqual(ctx.talkbackActive(), []);
});

test("POST: max_seconds is capped at TALKBACK_MAX_SECONDS and defaults to it", async (t) => {
  const { ctx, transcodes } = setup({ env: { TALKBACK_MAX_SECONDS: "20" } });
  const base = await serve(t, ctx);
  const raw = (q) => fetch(`${base}/api/talkback/CAM1${q}`, { method: "POST", body: Buffer.from("A") });
  assert.equal((await raw("?max_seconds=999&wait=1")).status, 200);
  assert.equal((await raw("?wait=1")).status, 200);
  assert.deepEqual(
    transcodes.map((x) => x.opts.maxSeconds),
    [20, 20],
  );
});

test("POST raw body and multipart upload both play; wait=true answers 200 once finished", async (t) => {
  const { ctx, transcodes, handles } = setup();
  const base = await serve(t, ctx);
  const raw = await fetch(`${base}/api/talkback/CAM1?wait=true&volume=80`, {
    method: "POST",
    headers: { "content-type": "audio/mpeg" },
    body: Buffer.from("RAWMP3"),
  });
  assert.equal(raw.status, 200);
  assert.equal((await raw.json()).finished, true);
  assert.equal(transcodes[0].input.toString(), "RAWMP3");
  assert.equal(transcodes[0].opts.volume, 80);

  const form = new FormData();
  form.append("file", new Blob([Buffer.from("FORMMP3")], { type: "audio/mpeg" }), "scream.mp3");
  form.append("wait", "1");
  form.append("max_seconds", "5");
  const multi = await fetch(`${base}/api/talkback/CAM1`, { method: "POST", body: form });
  assert.equal(multi.status, 200);
  assert.equal(transcodes[1].input.toString(), "FORMMP3");
  assert.equal(transcodes[1].opts.maxSeconds, 5);
  assert.equal(handles.length, 2);
});

test("POST: 4xx for bad input, unknown devices and devices without a speaker", async (t) => {
  const { ctx, handles } = setup({ env: { TALKBACK_MAX_BYTES: "200" } });
  const base = await serve(t, ctx);
  const cases = [
    [await postJson(base, "/api/talkback/NOPE", { url: "http://x/a.mp3" }), 404, /unknown device/],
    [await postJson(base, "/api/talkback/SENSOR1", { url: "http://x/a.mp3" }), 422, /no talkback/],
    [await postJson(base, "/api/talkback/CAM1", { url: "file:///etc/passwd" }), 400, /http/],
    [await postJson(base, "/api/talkback/CAM1", { url: "not a url" }), 400, /valid URL/],
    [await postJson(base, "/api/talkback/CAM1", {}), 400, /url or an audio/],
    [await postJson(base, "/api/talkback/CAM1", { url: "http://x/a", volume: 900 }), 400, /volume/],
    [await postJson(base, "/api/talkback/CAM1", { url: "http://x/a", max_seconds: -1 }), 400, /max_seconds/],
    [await fetch(`${base}/api/talkback/CAM1`, { method: "POST", body: Buffer.alloc(201) }), 413, /limit/],
    [
      await fetch(`${base}/api/talkback/CAM1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      400,
      /JSON/,
    ],
    [await fetch(`${base}/api/talkback/CAM1`), 405, /POST/],
  ];
  for (const [res, status, msg] of cases) {
    assert.equal(res.status, status, `${res.url} → ${res.status}`);
    assert.match((await res.json()).error, msg);
  }
  assert.equal(handles.length, 0); // nothing above ever opened the speaker
});

test("POST: a fetch that fails or is too large is a 502 / 413 and never opens the speaker", async (t) => {
  const { ctx, handles } = setup({ env: { TALKBACK_MAX_BYTES: "200" } });
  const media = await mediaServer(t, { "/big.mp3": Buffer.alloc(1024) });
  const base = await serve(t, ctx);
  assert.equal((await postJson(base, "/api/talkback/CAM1", { url: `${media}/missing.mp3` })).status, 502);
  assert.equal((await postJson(base, "/api/talkback/CAM1", { url: `${media}/big.mp3` })).status, 413);
  assert.equal(handles.length, 0);
});

test("POST: 409 while a clip is already playing on that device; DELETE stops it", async (t) => {
  setup.handleOpts = { hold: true }; // never reports finished on its own
  t.after(() => (setup.handleOpts = undefined));
  const { ctx, handles } = setup();
  const base = await serve(t, ctx);
  assert.equal((await fetch(`${base}/api/talkback/CAM1`, { method: "POST", body: "A" })).status, 202);
  const busy = await fetch(`${base}/api/talkback/CAM1`, { method: "POST", body: "B" });
  assert.equal(busy.status, 409);
  assert.match((await busy.json()).error, /already playing/);
  assert.deepEqual(ctx.talkbackActive(), ["CAM1"]);
  const stop = await fetch(`${base}/api/talkback/CAM1`, { method: "DELETE" });
  assert.deepEqual(await stop.json(), { ok: true, stopped: true });
  await until(() => ctx.talkbackActive().length === 0);
  assert.equal(handles[0].stops >= 1, true);
  assert.equal((await fetch(`${base}/api/talkback/CAM1`, { method: "POST", body: "C" })).status, 202);
  await ctx.stopAllTalkbacks();
});

test("POST: an SDK refusal to open is a 502 (409 when the SDK says it is already talking)", async (t) => {
  const { ctx, cam } = setup();
  const base = await serve(t, ctx);
  cam.talkback = async () => {
    throw new Error("talkback: could not open the audio path on channel 0");
  };
  assert.equal((await fetch(`${base}/api/talkback/CAM1`, { method: "POST", body: "A" })).status, 502);
  cam.talkback = async () => {
    throw new Error("talkback: CAM1 is already talking — the device plays one audio stream at a time");
  };
  assert.equal((await fetch(`${base}/api/talkback/CAM1`, { method: "POST", body: "A" })).status, 409);
  assert.deepEqual(ctx.talkbackActive(), []); // a failed open frees the slot
});

test("POST: a playback error mid-clip surfaces to a waiting caller and still closes the path", async (t) => {
  const { ctx, cam } = setup();
  const base = await serve(t, ctx);
  const h = fakeHandle({ hold: true });
  cam.talkback = async () => {
    setImmediate(() => h.emit("error", new Error("device never acknowledged audio frame 3")));
    return h;
  };
  const r = await fetch(`${base}/api/talkback/CAM1?wait=1`, { method: "POST", body: "A" });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /acknowledged/);
  assert.equal(h.stops >= 1, true);
  assert.deepEqual(ctx.talkbackActive(), []);
});

test("POST: 503 before the bridge is authenticated", async (t) => {
  const { ctx } = setup({ ready: false });
  const base = await serve(t, ctx);
  assert.equal((await postJson(base, "/api/talkback/CAM1", { url: "http://x/a.mp3" })).status, 503);
});

test("WS device.talkback_play / device.talkback_stop", async (t) => {
  setup.handleOpts = { hold: true };
  t.after(() => (setup.handleOpts = undefined));
  const { ctx, transcodes, handles } = setup();
  const server = http.createServer();
  Object.assign(ctx, createWsServer(ctx, server));
  t.after(() => new Promise((r) => server.close(r)));
  const sent = [];
  const ws = { readyState: 1, OPEN: 1, send: (s) => sent.push(JSON.parse(s)) };
  const audio = Buffer.from("WSMP3").toString("base64");
  await ctx.handleMessage(ws, JSON.stringify({ id: 1, cmd: "device.talkback_play", sn: "CAM1", audio, maxSeconds: 4 }));
  assert.deepEqual(sent[0], {
    id: 1,
    ok: true,
    sn: "CAM1",
    durationMs: 640,
    maxSeconds: 4,
    volume: 100,
    started: true,
  });
  assert.equal(transcodes[0].input.toString(), "WSMP3");
  await ctx.handleMessage(ws, JSON.stringify({ id: 2, cmd: "device.talkback_play", sn: "CAM1", audio }));
  assert.equal(sent[1].ok, false);
  assert.equal(sent[1].status, 409);
  await ctx.handleMessage(ws, JSON.stringify({ id: 3, cmd: "device.talkback_stop", sn: "CAM1" }));
  assert.deepEqual(sent[2], { id: 3, ok: true, stopped: true });
  await until(() => handles[0].stops > 0);
  await ctx.handleMessage(ws, JSON.stringify({ id: 4, cmd: "device.talkback_play", sn: "SENSOR1", url: "http://x/a" }));
  assert.equal(sent[3].status, 422);
});
