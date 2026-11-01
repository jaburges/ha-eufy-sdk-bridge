// Doorbells the SDK does not recognise as doorbells — chiefly video smart locks (the FamiLock S3,
// T85V0), whose front panel carries a doorbell button.
//
// The SDK binds its `doorbell` capability from the model name (`/doorbell/i`), so a video lock is not
// one. Its ring still reaches the host: push event type 3103 (PRESS_DOORBELL) is declared by that
// capability alone, and the SDK decodes an event only one capability declares for any device — so the
// lock's press arrives as `doorbellPress` either way. What is missing is the capability itself, which
// is how a host knows to build its doorbell entities (Home Assistant's Doorbell event, Ringing sensor
// and "Doorbell ringing" trigger all key off it). So the summary the host reads adds `doorbell` to a
// video lock, and to any serial named in BRIDGE_DOORBELL_DEVICES.

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
