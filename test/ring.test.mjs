// Doorbell rings from every path (push, P2P frame, property) routed into one doorbellPress per press,
// with the source of each logged. Drives the ring router directly, then through the real boot wiring.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createBoot } from "../src/boot.mjs";
import { createRings, describeFrame, doorbellSettingsLine, isMediaFrame, p2pRingMatch } from "../src/doorbell.mjs";

const LOCK = "T85V0K102515088E";

function router(env = {}) {
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", ...env });
  const logs = [];
  const forwarded = [];
  const ctx = { ...config, eventLog: (l) => logs.push(l), forwardEvent: (e, p) => forwarded.push([e, p]) };
  const rings = createRings(ctx);
  rings.setDoorbells([{ sn: LOCK, stationSn: LOCK, channel: 0 }]);
  return { rings, logs, forwarded };
}

const frame = (over = {}) => ({
  stationSn: LOCK,
  channel: 0,
  commandId: 1701,
  commandName: "CMD_DOORBELL_NOTIFY_PAYLOAD",
  data: Buffer.from("{}"),
  ...over,
});

test("dedupe: one press seen on two paths, or pushed twice, fires once; a later press fires again", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { rings, logs, forwarded } = router({ BRIDGE_RING_P2P_COMMANDS: "1701" });
  assert.equal(rings.ring(LOCK, "push", "event_type=3103", { eventType: 3103 }), true);
  t.mock.timers.tick(800);
  rings.onP2PFrame(frame()); // the same press over P2P
  t.mock.timers.tick(1_000);
  assert.equal(rings.ring(LOCK, "push", "event_type=3103"), false); // eufy re-delivering the push
  t.mock.timers.tick(5_000);
  assert.equal(rings.ring(LOCK, "push", "event_type=3103"), true); // outside the window: a new press
  assert.deepEqual(
    forwarded.map(([e, p]) => [e, p.deviceSn, p.ringSource]),
    [
      ["doorbellPress", LOCK, "push"],
      ["doorbellPress", LOCK, "push"],
    ],
  );
  assert.equal(logs[0], `ring ${LOCK} via push (event_type=3103) → doorbellPress`);
  assert.match(logs[1], /via p2p .* → duplicate of the push ring 800 ms ago, suppressed/);
  assert.match(logs[2], /duplicate of the push ring 1800 ms ago/);
});

test("dedupe: BRIDGE_RING_DEDUPE_MS=0 forwards every ring", () => {
  const { rings, forwarded } = router({ BRIDGE_RING_DEDUPE_MS: "0" });
  rings.ring(LOCK, "push");
  rings.ring(LOCK, "push");
  assert.equal(forwarded.length, 2);
});

test("p2p: a frame matching BRIDGE_RING_P2P_COMMANDS from the doorbell's station rings, others do not", () => {
  const { rings, forwarded, logs } = router({
    BRIDGE_RING_P2P_COMMANDS: "1351:6301, 1701",
    BRIDGE_RING_DEDUPE_MS: "0",
  });
  rings.onP2PFrame(frame());
  rings.onP2PFrame(frame({ commandId: 1351, commandName: "CMD_NOTIFY_PAYLOAD", json: { cmd: 6301 } }));
  rings.onP2PFrame(frame({ commandId: 1351, commandName: "CMD_NOTIFY_PAYLOAD", json: { cmd: 9999 } })); // other cmd
  rings.onP2PFrame(frame({ commandId: 1300, commandName: "CMD_VIDEO_FRAME" })); // media never rings
  rings.onP2PFrame(frame({ stationSn: "OTHER" })); // not a doorbell's station
  assert.deepEqual(
    forwarded.map(([, p]) => [p.ringSource, p.commandId]),
    [
      ["p2p", 1701],
      ["p2p", 1351],
    ],
  );
  assert.ok(logs.some((l) => /from no known doorbell — ignored/.test(l)));
});

test("p2p: BRIDGE_P2P_LOG logs non-media frames only", () => {
  const { rings, logs } = router({ BRIDGE_P2P_LOG: "1" });
  rings.onP2PFrame(frame({ json: { cmd: 5 } }));
  rings.onP2PFrame(frame({ commandId: 1301, commandName: "CMD_AUDIO_FRAME" }));
  assert.deepEqual(logs, [`p2p in: CMD_DOORBELL_NOTIFY_PAYLOAD(1701) cmd=5 ch=0 station=${LOCK} 2B`]);
});

test("property: a BRIDGE_RING_PROPERTIES change to truthy rings; every doorbell property change is logged", () => {
  const { rings, forwarded, logs } = router({ BRIDGE_RING_PROPERTIES: "ringing" });
  rings.onPropertyChanged({ deviceSn: LOCK, property: "ringing", value: false });
  rings.onPropertyChanged({ deviceSn: LOCK, property: "battery", value: 80 });
  rings.onPropertyChanged({ deviceSn: "CAM1", property: "ringing", value: true }); // not a doorbell
  rings.onPropertyChanged({ deviceSn: LOCK, property: "ringing", value: 1 });
  assert.deepEqual(
    forwarded.map(([, p]) => [p.ringSource, p.property]),
    [["property", "ringing"]],
  );
  assert.ok(logs.includes(`property in: battery=80 sn=${LOCK}`));
  assert.ok(!logs.some((l) => l.includes("CAM1")));
});

test("frame helpers", () => {
  assert.equal(isMediaFrame({ commandName: "CMD_VIDEO_FRAME" }), true);
  assert.equal(isMediaFrame({ commandId: 1301 }), true);
  assert.equal(isMediaFrame(frame()), false);
  assert.equal(p2pRingMatch(frame(), new Set()), undefined);
  assert.equal(p2pRingMatch(frame({ json: { cmd: 7 } }), new Set(["1701:7"])), "1701:7");
  assert.equal(describeFrame(frame()), `CMD_DOORBELL_NOTIFY_PAYLOAD(1701) ch=0 station=${LOCK} 2B`);
});

test("doorbellSettingsLine: reads the ring-related params from either cloud record shape", () => {
  const list = {
    params: [
      { param_type: 1710, param_value: "7" },
      { param_type: 1250, param_value: "60" },
      { param_type: 1, param_value: "x" },
    ],
  };
  assert.equal(doorbellSettingsLine(list), 'notification(1710)="7", retrigger interval(1250)="60"');
  assert.equal(doorbellSettingsLine({ params: { 1271: 0 } }), "snooze(1271)=0");
  assert.equal(doorbellSettingsLine({}), undefined);
});

test("boot: pushes, P2P frames and properties all reach one router; settings are logged", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ring-"));
  const config = loadConfig({
    EUFY_EMAIL: "x@y.z",
    EUFY_PASSWORD: "pw",
    GO2RTC_ENABLE: "0",
    GO2RTC_CONFIG: path.join(dir, "go2rtc.yaml"),
    STREAM_IDLE_MS: "0",
    RTSP_IDLE_OFF_MS: "0",
    BRIDGE_RING_P2P_COMMANDS: "1701",
  });
  const eufy = new EventEmitter();
  eufy.getDevices = async () => [{ sn: LOCK, stationSn: LOCK, channel: 0, raw: { params: { 1710: 7 } } }];
  const state = createState();
  state.clients.add({});
  const sent = [];
  const ctx = {
    ...config,
    eufy,
    state,
    eventLog: () => {},
    broadcast: (m) => sent.push(m),
    enrichPersonName: (_e, p) => p,
    noteDetection: () => {},
    deviceList: async () => [{ sn: LOCK, capabilities: ["lock", "camera", "doorbell"] }],
    warmFaceRoster: async () => {},
    warmLastEventImages: async () => {},
    watchdogTick: async () => {},
  };
  Object.assign(ctx, createBoot(ctx));
  const out = [];
  t.mock.method(console, "log", (...a) => out.push(a.join(" ")));
  await ctx.completeBoot();
  t.after(() => clearInterval(state.timers.watchdog));
  assert.ok(out.includes(`[bridge] doorbell ${LOCK}: notification(1710)=7`));
  eufy.emit("p2p", frame()); // P2P first this time
  eufy.emit("doorbellPress", { deviceSn: LOCK, eventType: 3103 }); // then the push for the same press
  eufy.emit("propertyChanged", { deviceSn: LOCK, property: "battery", value: 79 });
  const presses = sent.filter((m) => m.event === "doorbellPress");
  assert.deepEqual(
    presses.map((m) => m.ringSource),
    ["p2p"],
  );
  assert.ok(sent.some((m) => m.event === "propertyChanged")); // still forwarded as before
});
