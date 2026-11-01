// Doorbell press on devices the SDK does not recognise as doorbells (a video lock such as the FamiLock S3,
// T85V0). Covers the SDK half against the real library (a 3103 push decodes to `doorbellPress` whatever
// the device), the summary half (a video lock is reported with the `doorbell` capability a host builds its
// doorbell entities from), and the boot wiring (the press reaches every WS client, with an event-log line).
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEvent, detectCapabilities } from "@mega-yfue/eufy-sdk";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createDeviceView } from "../src/device-view.mjs";
import { createBoot } from "../src/boot.mjs";
import { PRESS_DOORBELL, hostCapabilities, isVideoLock, ringFromPush } from "../src/doorbell.mjs";

const LOCK_SN = "T85V0K102515088E";
const VIDEO_LOCK = { sn: LOCK_SN, codec: "lock", capabilities: ["lock", "camera", "motion", "person_detection"] };

test("SDK: a video lock's record does not bind the doorbell capability (the gap this fills)", () => {
  const caps = detectCapabilities({ model: "T85V0", name: "Front Door", params: {} }, "lock");
  assert.ok(caps.includes("lock"));
  assert.ok(!caps.includes("doorbell"));
});

test("SDK: a PRESS_DOORBELL push decodes to doorbellPress even for a device without the doorbell capability", () => {
  const out = decodeEvent(
    { source: "push", eventType: PRESS_DOORBELL, deviceSn: LOCK_SN, payload: {} },
    new Set(VIDEO_LOCK.capabilities),
  );
  assert.deepEqual(
    out.map((o) => [o.event, o.payload.deviceSn]),
    [["doorbellPress", LOCK_SN]],
  );
});

test("isVideoLock: a lock with a camera side, not a plain or garage lock, nor a camera", () => {
  assert.equal(isVideoLock(VIDEO_LOCK), true);
  assert.equal(isVideoLock({ codec: "camera", capabilities: ["lock", "video"] }), true);
  assert.equal(isVideoLock({ codec: "lock", capabilities: ["lock", "battery"] }), false); // T85D0-style
  assert.equal(isVideoLock({ codec: "camera", capabilities: ["camera", "motion"] }), false);
});

test("hostCapabilities: adds doorbell once, to video locks and to named serials only", () => {
  assert.deepEqual(hostCapabilities(VIDEO_LOCK), [...VIDEO_LOCK.capabilities, "doorbell"]);
  const doorbell = { sn: "D1", capabilities: ["camera", "doorbell"] };
  assert.equal(hostCapabilities(doorbell), doorbell.capabilities); // already one: untouched
  const cam = { sn: "CAM1", capabilities: ["camera", "motion"] };
  assert.deepEqual(hostCapabilities(cam), ["camera", "motion"]);
  assert.deepEqual(hostCapabilities(cam, new Set(["CAM1"])), ["camera", "motion", "doorbell"]);
});

test("devices.list summary: the video lock is reported with the doorbell capability", async () => {
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", BRIDGE_DOORBELL_DEVICES: " CAM9 , " });
  const describe = (m) => () => ({ details: [], ...m });
  const devices = {
    [LOCK_SN]: { describe: describe({ ...VIDEO_LOCK, model: "T85V0", modelName: "FamiLock S3" }) },
    LOCK2: { describe: describe({ sn: "LOCK2", codec: "lock", capabilities: ["lock"], model: "T85D0" }) },
    CAM9: { describe: describe({ sn: "CAM9", codec: "camera", capabilities: ["camera"], model: "T8425" }) },
  };
  for (const d of Object.values(devices)) d.getProperties = () => ({});
  const ctx = { ...config, state: createState(), eufy: { getDevice: async (sn) => devices[sn] } };
  const view = createDeviceView(ctx);
  assert.ok((await view.describeDevice(LOCK_SN)).capabilities.includes("doorbell"));
  assert.ok(!(await view.describeDevice("LOCK2")).capabilities.includes("doorbell"));
  assert.ok((await view.describeDevice("CAM9")).capabilities.includes("doorbell")); // BRIDGE_DOORBELL_DEVICES
});

test("ringFromPush: only the configured extra types, never 3103 (the SDK already emitted it)", () => {
  const types = new Set([3103, 2305]);
  assert.equal(ringFromPush({ eventType: 3103, deviceSn: LOCK_SN }, types), undefined);
  assert.equal(ringFromPush({ eventType: 999, deviceSn: LOCK_SN }, types), undefined);
  assert.deepEqual(ringFromPush({ eventType: "2305", deviceSn: LOCK_SN, stationSn: "S1" }, types), {
    deviceSn: LOCK_SN,
    stationSn: "S1",
    eventType: 2305,
    thumbnailUrl: undefined,
  });
  assert.equal(ringFromPush({ eventType: 2305 }, new Set()), undefined);
});

/** Run the real boot against a fake SDK client; returns what was broadcast and logged. */
async function boot(t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-"));
  const config = loadConfig({
    EUFY_EMAIL: "x@y.z",
    EUFY_PASSWORD: "pw",
    GO2RTC_ENABLE: "0",
    GO2RTC_CONFIG: path.join(dir, "go2rtc.yaml"),
    STREAM_IDLE_MS: "0",
    RTSP_IDLE_OFF_MS: "0",
    ...env,
  });
  const eufy = new EventEmitter();
  const state = createState();
  state.clients.add({});
  const sent = [];
  const logs = [];
  const detections = [];
  const ctx = {
    ...config,
    eufy,
    state,
    eventLog: (line) => logs.push(line),
    broadcast: (msg) => sent.push(msg),
    enrichPersonName: (_e, p) => p,
    noteDetection: (sn) => detections.push(sn),
    deviceList: async () => [],
    warmFaceRoster: async () => {},
    warmLastEventImages: async () => {},
    watchdogTick: async () => {},
  };
  Object.assign(ctx, createBoot(ctx));
  await ctx.completeBoot();
  t.after(() => clearInterval(state.timers.watchdog));
  return { eufy, sent, logs, detections };
}

test("boot: a doorbellPress from the lock is broadcast and logged as a detection", async (t) => {
  const { eufy, sent, logs, detections } = await boot(t);
  eufy.emit("push", { eventType: PRESS_DOORBELL, eventName: "PRESS_DOORBELL", deviceSn: LOCK_SN });
  eufy.emit("doorbellPress", { deviceSn: LOCK_SN, eventType: PRESS_DOORBELL });
  const presses = sent.filter((m) => m.event === "doorbellPress");
  assert.deepEqual(presses, [{ event: "doorbellPress", deviceSn: LOCK_SN, eventType: PRESS_DOORBELL }]);
  assert.deepEqual(detections, [LOCK_SN]);
  assert.ok(logs.includes(`push raw: event_type=3103 (PRESS_DOORBELL) sn=${LOCK_SN}`));
  assert.ok(logs.some((l) => l.startsWith(`push in: doorbellPress sn=${LOCK_SN} [detection`)));
});

test("boot: BRIDGE_RING_EVENT_TYPES turns another raw push type into a doorbellPress", async (t) => {
  const { eufy, sent } = await boot(t, { BRIDGE_RING_EVENT_TYPES: "2305" });
  eufy.emit("push", { eventType: 2305, eventName: "EVENT_2305", deviceSn: LOCK_SN });
  eufy.emit("push", { eventType: 3101, eventName: "MOTION_DETECTION", deviceSn: LOCK_SN });
  assert.deepEqual(
    sent.filter((m) => m.event === "doorbellPress").map((m) => [m.deviceSn, m.eventType]),
    [[LOCK_SN, 2305]],
  );
});
