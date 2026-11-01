// Doorbells the SDK does not recognise as doorbells — chiefly video smart locks (the FamiLock S3,
// T85V0), whose front panel carries a doorbell button.
//
// The SDK binds its `doorbell` capability from the model name (`/doorbell/i`), so a video lock is not
// one. Its ring still reaches the host: push event type 3103 (PRESS_DOORBELL) is declared by that
// capability alone, and the SDK decodes an event only one capability declares for any device — so the
// lock's press arrives as `doorbellPress` either way. What is missing is the capability itself, which
// is how a host knows to build its doorbell entities (Home Assistant's Doorbell event, Ringing sensor
// and "Doorbell ringing" trigger all key off it). So the summary the host reads adds `doorbell` to a
// video lock, and to any serial named in BRIDGE_DOORBELL_DEVICES. `createRings` below then turns every
// path a press can arrive on into one `doorbellPress`.

/** The SDK's DoorbellPushEvent.PRESS_DOORBELL, which it already decodes as `doorbellPress`. */
export const PRESS_DOORBELL = 3103;

// A lock with any camera-side capability is a video lock; a plain or garage lock has none of these.
const CAMERA_SIDE = ["camera", "video", "motion", "person_detection"];

/** True for a lock that also carries a camera — the class of device whose keypad has a doorbell. */
export function isVideoLock({ codec, capabilities = [] }) {
  const caps = new Set(capabilities);
  return (caps.has("lock") || codec === "lock") && CAMERA_SIDE.some((c) => caps.has(c));
}

/** The capability list a host should see for `manifest` (the SDK's `describe()`). */
export function hostCapabilities(manifest, doorbellDevices = new Set()) {
  const caps = manifest.capabilities ?? [];
  if (caps.includes("doorbell")) return caps;
  return isVideoLock(manifest) || doorbellDevices.has(manifest.sn) ? [...caps, "doorbell"] : caps;
}

/**
 * The `doorbellPress` a raw push stands for when its event type is one BRIDGE_RING_EVENT_TYPES names,
 * else undefined. 3103 is skipped: the SDK has already emitted that one.
 */
export function ringFromPush(ev, ringEventTypes) {
  const type = Number(ev?.eventType);
  if (type === PRESS_DOORBELL || !ringEventTypes?.has(type)) return undefined;
  return { deviceSn: ev.deviceSn, stationSn: ev.stationSn, eventType: type, thumbnailUrl: ev.thumbnailUrl };
}

const MEDIA_COMMANDS = new Set(["CMD_VIDEO_FRAME", "CMD_AUDIO_FRAME"]);
const MEDIA_COMMAND_IDS = new Set([1300, 1301]);

/** True for a live video/audio frame — the bulk of P2P traffic, and never a notification. */
export const isMediaFrame = (f) => MEDIA_COMMANDS.has(f?.commandName) || MEDIA_COMMAND_IDS.has(f?.commandId);

/** One P2P frame as a log fragment: command, JSON `cmd` when it has one, channel, station, size. */
export function describeFrame(f) {
  const cmd = f?.json?.cmd != null ? ` cmd=${f.json.cmd}` : "";
  return `${f?.commandName ?? "?"}(${f?.commandId ?? "?"})${cmd} ch=${f?.channel ?? "?"} station=${f?.stationSn ?? "?"} ${f?.data?.length ?? 0}B`;
}

/** The BRIDGE_RING_P2P_COMMANDS token (`<commandId>` or `<commandId>:<json cmd>`) a frame matches. */
export function p2pRingMatch(f, tokens) {
  if (!tokens?.size || !f || isMediaFrame(f)) return undefined;
  const id = String(f.commandId);
  const cmd = f.json?.cmd;
  if (cmd != null && tokens.has(`${id}:${cmd}`)) return `${id}:${cmd}`;
  return tokens.has(id) ? id : undefined;
}

const isRinging = (v) => v === true || v === 1 || v === "1" || v === "true";

// Settings that decide whether a press produces a push at all (eufy-security-client's T85V0 property
// table): ring notifications (1710), snooze (1271), the event retrigger interval (1250), and the chime
// volume (1708). Logged at boot, because a press that never pushes looks the same as a bridge bug.
const DOORBELL_SETTINGS = [
  [1710, "notification"],
  [1271, "snooze"],
  [1250, "retrigger interval"],
  [1708, "ringtone volume"],
];

/** The raw cloud params of a device record (`[{ param_type, param_value }]` or `{ id: value }`). */
function rawParams(raw) {
  const params = raw?.params;
  if (Array.isArray(params)) return new Map(params.map((p) => [Number(p?.param_type), p?.param_value]));
  if (params && typeof params === "object") return new Map(Object.entries(params).map(([k, v]) => [Number(k), v]));
  return new Map();
}

/** A one-line summary of the ring-related settings in a device's cloud record, or undefined. */
export function doorbellSettingsLine(raw) {
  const params = rawParams(raw);
  const bits = DOORBELL_SETTINGS.filter(([id]) => params.has(id)).map(
    ([id, label]) => `${label}(${id})=${JSON.stringify(params.get(id))}`,
  );
  return bits.length ? bits.join(", ") : undefined;
}

/**
 * Every path a doorbell press can reach the bridge on, routed into ONE `doorbellPress` per press:
 *  - `push`: the SDK's `doorbellPress` (push 3103), or a raw push type named in BRIDGE_RING_EVENT_TYPES;
 *  - `p2p`: a frame matching BRIDGE_RING_P2P_COMMANDS from a doorbell's station and channel;
 *  - `property`: a `propertyChanged` of a BRIDGE_RING_PROPERTIES name to a truthy value.
 * Neither eufy-security-client nor the SDK knows a P2P frame or a property that means "rung" — both
 * raise a ring from the push alone — so the last two are opt-in, for a device a capture shows doing it.
 * Rings of one device within BRIDGE_RING_DEDUPE_MS of the last one forwarded are one press, so a press
 * seen on two paths, or a push eufy delivers twice, fires once. Each ring logs the path it came from.
 */
export function createRings(ctx) {
  const { cfg } = ctx;
  const last = new Map(); // sn -> { at, source } of the last ring forwarded
  let byChannel = new Map(); // `${stationSn}:${channel}` (or `${stationSn}:*`) -> doorbell serial
  let serials = new Set();

  /** Which devices are doorbells, and where their P2P frames come from: `[{ sn, stationSn, channel }]`. */
  function setDoorbells(records) {
    serials = new Set(records.map((r) => r.sn));
    byChannel = new Map();
    const perStation = new Map();
    for (const { sn, stationSn = sn, channel } of records) {
      if (channel != null) byChannel.set(`${stationSn}:${channel}`, sn);
      perStation.set(stationSn, [...(perStation.get(stationSn) ?? []), sn]);
    }
    for (const [station, sns] of perStation) if (sns.length === 1) byChannel.set(`${station}:*`, sns[0]);
  }

  /** Forward one ring of `sn` from `source` unless it repeats one forwarded within the dedupe window. */
  function ring(sn, source, detail, payload = {}) {
    if (!sn) return false;
    const now = Date.now();
    const prev = last.get(sn);
    const label = `ring ${sn} via ${source}${detail ? ` (${detail})` : ""}`;
    if (cfg.ringDedupeMs && prev && now - prev.at < cfg.ringDedupeMs) {
      ctx.eventLog(`${label} → duplicate of the ${prev.source} ring ${now - prev.at} ms ago, suppressed`);
      return false;
    }
    last.set(sn, { at: now, source });
    ctx.eventLog(`${label} → doorbellPress`);
    ctx.forwardEvent("doorbellPress", { ...payload, deviceSn: sn, ringSource: source });
    return true;
  }

  function onP2PFrame(f) {
    if (cfg.p2pLog && f && !isMediaFrame(f)) ctx.eventLog(`p2p in: ${describeFrame(f)}`);
    const token = p2pRingMatch(f, cfg.ringP2pCommands);
    if (!token) return;
    const sn = byChannel.get(`${f.stationSn}:${f.channel}`) ?? byChannel.get(`${f.stationSn}:*`);
    if (!sn) return ctx.eventLog(`p2p ring candidate ${describeFrame(f)} is from no known doorbell — ignored`);
    ring(sn, "p2p", `${describeFrame(f)} matched ${token}`, { stationSn: f.stationSn, commandId: f.commandId });
  }

  function onPropertyChanged(p) {
    const sn = p?.deviceSn;
    if (!sn || !serials.has(sn)) return;
    // A doorbell's property changes are rare, and a press that changes one is what this line finds.
    ctx.eventLog(`property in: ${p.property}=${JSON.stringify(p.value)} sn=${sn}`);
    if (cfg.ringProperties.has(p.property) && isRinging(p.value))
      ring(sn, "property", `${p.property}=${JSON.stringify(p.value)}`, { property: p.property });
  }

  return { ring, setDoorbells, onP2PFrame, onPropertyChanged };
}
