// The one-time post-login boot: wire the SDK event handlers, publish the go2rtc config, start go2rtc, arm
// the periodic sweeps, and flip `ready`. Guarded so it runs exactly once — a later re-auth calls it again
// but returns immediately, so listeners and timers are never double-wired. Non-critical warm-ups are
// kicked off after `ready` so they don't hold up serving.
import { spawn } from "node:child_process";
import { writeGo2rtcConfig } from "../go2rtc-config.mjs";
import { PRESS_DOORBELL, createRings, doorbellSettingsLine, ringFromPush } from "./doorbell.mjs";

/**
 * One-shot boot diagnostic: print each camera's station + P2P channel so a same-model collision is
 * visible in the log. Two cameras on ONE HomeBase that share a raw `device_channel` (or both omit it) is
 * the signature of the bug where only one of a same-model pair streams and updates detections — the SDK
 * addresses live video + inbound frames by (station, channel), so a shared channel collapses both onto
 * the first. `resolvedChannel` is the SDK's own disambiguated `EufyDevice.channel` (present once the
 * channel-disambiguation build is installed); when it differs from `raw` per camera, the fix is active.
 * Best-effort; never throws.
 */
async function logCameraChannelMap(eufy, cams) {
  const camSns = new Set(cams.map((c) => c.sn));
  const rows = (await eufy.getDevices())
    .filter((d) => camSns.has(d.sn))
    .map((d) => {
      const raw = d.raw?.device_channel;
      return {
        sn: d.sn,
        model: d.raw?.device_model ?? "?",
        station: d.stationSn ?? d.sn,
        raw: typeof raw === "number" ? raw : "∅",
        channel: typeof d.channel === "number" ? d.channel : "—",
        p2p: d.p2pDid ? "yes" : "no",
      };
    });
  if (!rows.length) return;
  console.log("[bridge] camera channel map (station  raw=device_channel → resolvedChannel  sn  model):");
  for (const r of [...rows].sort(
    (a, b) => a.station.localeCompare(b.station) || String(a.raw).localeCompare(String(b.raw)),
  ))
    console.log(`  ${r.station}  raw=${r.raw} → ch=${r.channel}  ${r.sn}  ${r.model}  p2p=${r.p2p}`);
  // Flag same-station cameras sharing a raw device_channel (both-missing counts) — the collision signature.
  const byStationChannel = new Map();
  for (const r of rows) {
    const key = `${r.station}|${r.raw}`;
    let list = byStationChannel.get(key);
    if (!list) byStationChannel.set(key, (list = []));
    list.push(r.sn);
  }
  for (const [key, sns] of byStationChannel) {
    if (sns.length < 2) continue;
    const [station, raw] = key.split("|");
    console.log(
      `  ⚠ CHANNEL COLLISION on ${station} raw device_channel=${raw}: ${sns.join(", ")} — only one streams/detects until the SDK channel-disambiguation fix is deployed`,
    );
  }
}

export function createBoot(ctx) {
  const { cfg, eufy, DEBUG, SCHEMA_VERSION, dbg, DETECTION_EVENTS, FORWARDED_EVENTS } = ctx;
  const { flags, timers } = ctx.state;
  const rings = createRings(ctx);

  /** Spawn the bundled go2rtc against the generated config. Non-fatal if the binary isn't present (dev). */
  function startGo2rtc() {
    if (!cfg.go2rtcEnable) return;
    if (flags.go2rtcProc) return;
    try {
      flags.go2rtcProc = spawn("go2rtc", ["-config", cfg.go2rtcConfig], { stdio: "inherit" });
      flags.go2rtcProc.on("error", (e) =>
        console.error(`[bridge] go2rtc not started (${e.message}) — WS/control still up`),
      );
      flags.go2rtcProc.on("exit", (code) => {
        console.error(`[bridge] go2rtc exited (${code})`);
        flags.go2rtcProc = undefined;
      });
    } catch (e) {
      console.error(`[bridge] go2rtc spawn failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Tell the ring router which devices are doorbells and which station + channel their P2P frames carry,
   * and log each one's ring-related settings — a press the device never pushes is otherwise invisible.
   */
  async function registerDoorbells(summaries) {
    const doorbells = summaries.filter((s) => s.capabilities?.includes("doorbell"));
    const records = new Map((await (eufy.getDevices?.() ?? [])).map((d) => [d.sn, d]));
    rings.setDoorbells(
      doorbells.map(({ sn }) => ({
        sn,
        stationSn: records.get(sn)?.stationSn ?? sn,
        channel: records.get(sn)?.channel,
      })),
    );
    for (const { sn } of doorbells) {
      const line = doorbellSettingsLine(records.get(sn)?.raw);
      console.log(`[bridge] doorbell ${sn}: ${line ?? "no ring settings in its cloud record"}`);
    }
  }

  /** Runs once, after a successful login: wire events, write go2rtc.yaml, start go2rtc, go ready. */
  async function completeBoot() {
    if (flags.ready || flags.booting) return;
    flags.booting = true;
    try {
      if (DEBUG) {
        eufy.on("p2pConnect", (sn) => dbg(`p2pConnect station=${sn}`));
        eufy.on("p2pClose", (sn) => dbg(`p2pClose station=${sn}`));
        eufy.on("commandAck", (info) => dbg(`commandAck ${JSON.stringify(info)}`));
      }
      const forward = (e, payload) => {
        const detection = DETECTION_EVENTS.has(e);
        if (detection) {
          ctx.noteDetection(payload?.deviceSn);
          // Local-storage accounts get no push thumbnail, so pull the fresh event cover from HomeBase
          // storage and (if it changed) nudge HA to re-fetch — otherwise "Last event" stays frozen.
          ctx.onDetectionRefresh?.(payload?.deviceSn);
        }
        // Narrow event trace (on by default): a push/semantic event arrived — say what it is, which
        // device, whether it's a detection (which is what makes HA refresh "Last event"), and how many
        // frontend clients it reaches. 0 clients means HA is not connected, so nothing updates there.
        if (e !== "propertyChanged") {
          const clients = ctx.state.clients.size;
          ctx.eventLog(
            `push in: ${e} sn=${payload?.deviceSn ?? "?"}` +
              `${detection ? " [detection → HA refreshes Last event]" : ""}` +
              ` → broadcast to ${clients} frontend client(s)` +
              `${clients === 0 ? " (NONE CONNECTED — HA will not update)" : ""}`,
          );
        }
        ctx.broadcast({ event: e, ...ctx.enrichPersonName(e, payload) });
      };
      ctx.forwardEvent = forward;
      for (const e of FORWARDED_EVENTS)
        eufy.on(e, (payload) => {
          // A press goes through the ring router (doorbell.mjs), which dedupes it against the other paths.
          if (e === "doorbellPress")
            return rings.ring(payload?.deviceSn, "push", `event_type=${payload?.eventType ?? PRESS_DOORBELL}`, payload);
          if (e === "propertyChanged") rings.onPropertyChanged(payload);
          forward(e, payload);
        });
      eufy.on("p2p", (frame) => rings.onP2PFrame(frame));
      eufy.on("push", (ev) => {
        ctx.noteRecording?.(ev); // the recording a detection named, for /clip
        // Every push, decoded or not: when a device's event never shows up as a semantic one (a ring the
        // SDK has no mapping for), this is the line that names the event type to map.
        ctx.eventLog(
          `push raw: event_type=${ev?.eventType ?? "?"} (${ev?.eventName ?? "?"}) sn=${ev?.deviceSn ?? "?"}`,
        );
        const ring = ringFromPush(ev, cfg.ringEventTypes);
        if (ring) rings.ring(ring.deviceSn, "push", `event_type=${ring.eventType}, BRIDGE_RING_EVENT_TYPES`, ring);
      });
      // Use the same capability-based view the WS/HA side uses: a camera is a device describeDevice gave
      // a `stream`, NOT deviceClass==="camera" (the SDK downgrades a camera behind a HomeBase to "other"),
      // so go2rtc registers exactly the cameras HA shows.
      const summaries = await ctx.deviceList();
      const cams = await writeGo2rtcConfig(cfg, summaries);
      startGo2rtc();
      flags.ready = true;
      timers.watchdog ??= setInterval(() => void ctx.watchdogTick(), 2 * 60_000);
      if (cfg.streamIdleMs) timers.streamIdle ??= setInterval(() => ctx.streamIdleTick(), 30_000);
      if (cfg.rtspIdleOffMs) timers.rtspIdle ??= setInterval(() => void ctx.rtspIdleSweep(), 60_000);
      console.log(`[bridge] ready — ${summaries.length} devices, ${cams.length} camera stream(s)`);
      await logCameraChannelMap(eufy, cams).catch(() => {});
      await registerDoorbells(summaries).catch((e) => console.warn(`[bridge] doorbell map: ${e?.message ?? e}`));
      ctx.broadcast({ event: "ready", schemaVersion: SCHEMA_VERSION });
      // Both read the P2P DB via a shared `dbChunk` stream — run sequentially so their accumulators don't
      // cross-contaminate. Non-blocking so `ready` isn't held up.
      void (async () => {
        await ctx.warmFaceRoster(); // resolve person_id -> name for face-recognition events
        await ctx.warmLastEventImages(); // populate "Last event" from local HomeBase storage on first load
      })();
    } finally {
      flags.booting = false;
    }
  }

  return { completeBoot, startGo2rtc, rings };
}
