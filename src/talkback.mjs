// Talkback: play an audio clip (an MP3 by URL, or uploaded bytes) through a camera's speaker.
//
// The SDK's `camera().talkback()` takes AAC-LC 16 kHz mono in ADTS frames and paces them onto the wire
// at playback rate itself (64 ms per frame), applying backpressure through `writable()`. So the clip is
// transcoded up front with the bundled ffmpeg — as fast as it will go, no `-re` — and then piped in:
// a file that won't decode is answered before the camera is woken, and the frame count gives the
// clip's exact duration. The member only exists on a device reporting the speaker param (1241), and the
// device plays one audio stream at a time, hence one playback per camera here too.
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const SAMPLE_RATE = 16_000;
const FRAME_MS = (1024 / SAMPLE_RATE) * 1000; // one AAC-LC frame = 1024 samples = 64 ms
const ADTS_SAMPLE_RATE_INDEX_16K = 8;
const TRANSCODE_TIMEOUT_MS = 30_000;
// How long past the clip's own duration playback may take before it is abandoned (a slow P2P open is
// already behind us by then, so this only covers pacing jitter and the stop frame).
const PLAYBACK_SLACK_MS = 15_000;
const CHUNK_BYTES = 4096;
const MAX_VOLUME_PERCENT = 400;

/** An error carrying the HTTP status the route should answer with. */
export const talkbackError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Count the ADTS frames in `buf`, checking each is AAC-LC 16 kHz mono — the only audio the device
 * plays. Throws a 422 on anything else, so a bad transcode never reaches the camera.
 */
export function adtsFrameCount(buf) {
  let frames = 0;
  let off = 0;
  while (off < buf.length) {
    if (off + 7 > buf.length) throw talkbackError(422, "audio ends with a truncated ADTS header");
    if (buf[off] !== 0xff || (buf[off + 1] & 0xf6) !== 0xf0) throw talkbackError(422, "audio is not ADTS AAC");
    const profile = buf[off + 2] >> 6; // audio object type - 1
    const rateIndex = (buf[off + 2] >> 2) & 0x0f;
    const channels = ((buf[off + 2] & 0x01) << 2) | (buf[off + 3] >> 6);
    if (profile !== 1 || rateIndex !== ADTS_SAMPLE_RATE_INDEX_16K || channels !== 1)
      throw talkbackError(422, "audio must be AAC-LC 16 kHz mono");
    const len = ((buf[off + 3] & 0x03) << 11) | (buf[off + 4] << 3) | (buf[off + 5] >> 5);
    if (len < 7 || off + len > buf.length) throw talkbackError(422, "audio has a malformed ADTS frame");
    off += len;
    frames += 1;
  }
  return frames;
}

/** The ffmpeg arguments that turn any decodable audio on stdin into device-ready ADTS on stdout. */
export function transcodeArgs({ maxSeconds, volume = 100 }) {
  const args = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-t", String(maxSeconds)];
  if (volume !== 100) args.push("-af", `volume=${volume / 100}`);
  args.push("-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "32k");
  args.push("-f", "adts", "pipe:1");
  return args;
}

/** Transcode `input` with ffmpeg into AAC-LC 16 kHz mono ADTS. Rejects with a 422 when it won't decode. */
export function transcodeToAdts(input, opts, { ffmpeg = "ffmpeg", timeoutMs = TRANSCODE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpeg, transcodeArgs(opts), { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject(talkbackError(500, `ffmpeg could not start: ${e?.message ?? e}`));
    }
    const out = [];
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => (err = (err + c).slice(-500)));
    child.stdin.on("error", () => {}); // ffmpeg may close stdin early (bad input, -t reached): exit code says why
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(talkbackError(500, `ffmpeg could not start: ${e?.message ?? e}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(talkbackError(422, `ffmpeg took longer than ${timeoutMs} ms to transcode`));
      if (code !== 0) return reject(talkbackError(422, `could not decode the audio: ${err.trim() || `exit ${code}`}`));
      resolve(Buffer.concat(out));
    });
    child.stdin.end(input);
  });
}

/** Read an async-iterable body (a request, a fetch body) into a Buffer, refusing more than `maxBytes`. */
export async function readCapped(body, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) throw talkbackError(413, `audio is larger than the ${maxBytes}-byte limit`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Fetch a clip over http(s) only, bounded in time and size. */
export async function fetchAudio(rawUrl, { maxBytes, timeoutMs, fetchImpl = fetch }) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw talkbackError(400, "url is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw talkbackError(400, "url must be http:// or https://");
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal, redirect: "follow" });
  } catch (e) {
    throw talkbackError(502, `fetching the audio failed: ${e?.cause?.message ?? e?.message ?? e}`);
  }
  if (!res.ok) throw talkbackError(502, `fetching the audio failed: HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length"));
  if (declared > maxBytes) throw talkbackError(413, `audio is larger than the ${maxBytes}-byte limit`);
  try {
    return await readCapped(res.body ?? [], maxBytes);
  } catch (e) {
    if (e?.status) throw e;
    throw talkbackError(502, `fetching the audio failed: ${e?.message ?? e}`);
  }
}

const truthy = (v) => v === true || /^(1|true|yes|on)$/i.test(String(v ?? ""));

/**
 * Pull the talkback arguments off an HTTP request: a JSON body `{ url, volume?, max_seconds?, wait? }`,
 * a multipart form with a file part (plus the same fields), or a raw audio body. Query parameters
 * supply the same fields for the raw case and are overridden by anything in the body.
 */
export async function parseTalkbackRequest(req, url, { maxBytes }) {
  const q = url.searchParams;
  const fields = {
    url: q.get("url") ?? undefined,
    volume: q.get("volume") ?? undefined,
    maxSeconds: q.get("max_seconds") ?? q.get("maxSeconds") ?? undefined,
    wait: q.get("wait") ?? undefined,
  };
  const contentType = String(req.headers["content-type"] ?? "");
  const type = contentType.split(";")[0].trim().toLowerCase();
  const body = await readCapped(req, maxBytes);
  const pick = (get) => {
    for (const [key, names] of [
      ["url", ["url"]],
      ["volume", ["volume"]],
      ["maxSeconds", ["max_seconds", "maxSeconds"]],
      ["wait", ["wait"]],
    ])
      for (const name of names) {
        const v = get(name);
        if (v != null && v !== "") fields[key] = v;
      }
  };
  if (type === "application/json") {
    let parsed;
    try {
      parsed = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      throw talkbackError(400, "body is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object") throw talkbackError(400, "JSON body must be an object");
    pick((name) => parsed[name]);
    return fields;
  }
  if (type === "multipart/form-data") {
    let form;
    try {
      form = await new Response(body, { headers: { "content-type": contentType } }).formData();
    } catch {
      throw talkbackError(400, "malformed multipart body");
    }
    pick((name) => {
      const v = form.get(name);
      return typeof v === "string" ? v : undefined;
    });
    const file = form.get("file") ?? form.get("audio") ?? [...form.values()].find((v) => typeof v !== "string");
    if (file && typeof file !== "string") fields.audio = Buffer.from(await file.arrayBuffer());
    return fields;
  }
  if (body.length) fields.audio = body;
  return fields;
}

export function createTalkback(ctx) {
  const { cfg, eufy } = ctx;
  const log = (...a) => ctx.eventLog?.(...a);
  const transcode = ctx.transcodeTalkback ?? transcodeToAdts;
  const fetchClip = ctx.fetchTalkbackAudio ?? fetchAudio;
  const active = new Map(); // sn -> { handle?, stopped, durationMs }

  /** Validate and default the caller's options; throws a 400 on anything malformed. */
  function normalize({ url, audio, volume, maxSeconds, wait }) {
    const hasUrl = url != null && url !== "";
    if (hasUrl && audio?.length) throw talkbackError(400, "send either a url or audio, not both");
    if (!hasUrl && !audio?.length) throw talkbackError(400, "talkback needs a url or an audio body");
    if (audio && audio.length > cfg.talkbackMaxBytes)
      throw talkbackError(413, `audio is larger than the ${cfg.talkbackMaxBytes}-byte limit`);
    let seconds = cfg.talkbackMaxSeconds;
    if (maxSeconds != null && maxSeconds !== "") {
      const n = Number(maxSeconds);
      if (!Number.isFinite(n) || n <= 0) throw talkbackError(400, "max_seconds must be a positive number");
      seconds = Math.min(n, cfg.talkbackMaxSeconds);
    }
    let vol = 100;
    if (volume != null && volume !== "") {
      vol = Number(volume);
      if (!Number.isFinite(vol) || vol < 0 || vol > MAX_VOLUME_PERCENT)
        throw talkbackError(400, `volume must be a percentage from 0 to ${MAX_VOLUME_PERCENT}`);
    }
    return { url: hasUrl ? url : undefined, audio, volume: vol, maxSeconds: seconds, wait: truthy(wait) };
  }

  /** Pace `adts` into an open handle; resolves once the clip has reached the wire (or was stopped). */
  function runPlayback(sn, slot, handle, adts) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        Promise.resolve()
          .then(() => handle.stop())
          .catch((e) => console.error(`[bridge] talkback ${sn}: stop failed: ${e?.message ?? e}`))
          .finally(() => {
            if (slot.stopped) return resolve({ finished: false, stopped: true });
            if (err) return reject(err);
            resolve({ finished: true });
          });
      };
      const timer = setTimeout(
        () => finish(new Error(`playback did not finish within ${slot.durationMs + PLAYBACK_SLACK_MS} ms`)),
        slot.durationMs + PLAYBACK_SLACK_MS,
      );
      handle.on("finished", () => finish());
      handle.on("stop", () => finish(new Error("the talkback path closed before the clip finished")));
      handle.on("error", (e) => finish(e));
      // A battery camera's media session stops at its power budget; the clip is already capped, so let
      // it run to the end rather than cutting it off mid-sentence.
      handle.on("budget", (notice) => notice?.extend?.());
      const chunks = [];
      for (let i = 0; i < adts.length; i += CHUNK_BYTES) chunks.push(adts.subarray(i, i + CHUNK_BYTES));
      pipeline(Readable.from(chunks), handle.writable()).catch((e) => finish(e));
    });
  }

  /**
   * Play a clip on `sn`. Resolves once the talkback is open and audio is flowing (`started`), or — with
   * `wait` — once the whole clip has reached the device (`finished`). Rejects with an error carrying
   * `status` (400/404/409/413/422/502) for the route to answer with.
   */
  async function talkbackPlay(sn, options = {}) {
    if (!sn) throw talkbackError(400, "talkback needs a device serial");
    const opts = normalize(options);
    if (active.has(sn)) throw talkbackError(409, `a talkback is already playing on ${sn}`);
    const slot = { stopped: false, durationMs: 0 };
    active.set(sn, slot);
    const release = () => active.get(sn) === slot && active.delete(sn);
    try {
      let cam;
      try {
        cam = (await eufy.getDevice(sn)).camera?.();
      } catch (e) {
        throw talkbackError(404, `unknown device ${sn}: ${e?.message ?? e}`);
      }
      if (typeof cam?.talkback !== "function")
        throw talkbackError(422, `${sn} has no talkback (it needs a camera speaker, param 1241)`);
      const input =
        opts.audio ??
        (await fetchClip(opts.url, { maxBytes: cfg.talkbackMaxBytes, timeoutMs: cfg.talkbackFetchTimeoutMs }));
      const adts = await transcode(input, { maxSeconds: opts.maxSeconds, volume: opts.volume });
      const frames = adtsFrameCount(adts);
      if (!frames) throw talkbackError(422, "the audio decoded to nothing");
      slot.durationMs = Math.round(frames * FRAME_MS);
      if (slot.stopped) return { started: false, stopped: true, durationMs: slot.durationMs };
      let handle;
      try {
        handle = await cam.talkback();
      } catch (e) {
        const msg = String(e?.message ?? e);
        throw talkbackError(/already talking/i.test(msg) ? 409 : 502, `opening talkback failed: ${msg}`);
      }
      slot.handle = handle;
      if (slot.stopped) {
        await handle.stop().catch(() => {});
        return { started: false, stopped: true, durationMs: slot.durationMs };
      }
      log(`talkback ${sn} → playing ${slot.durationMs} ms (${frames} frames, volume ${opts.volume}%)`);
      const done = runPlayback(sn, slot, handle, adts)
        .then((r) => {
          log(`talkback ${sn} → ${r.stopped ? "stopped" : "finished"}`);
          return r;
        })
        .catch((e) => {
          console.error(`[bridge] talkback ${sn} failed: ${e?.message ?? e}`);
          throw e;
        })
        .finally(release);
      const base = { sn, durationMs: slot.durationMs, maxSeconds: opts.maxSeconds, volume: opts.volume };
      if (!opts.wait) {
        done.catch(() => {}); // already logged; nobody is waiting on it
        return { ...base, started: true };
      }
      try {
        return { ...base, ...(await done) };
      } catch (e) {
        throw talkbackError(502, `playback failed: ${e?.message ?? e}`);
      }
    } catch (e) {
      if (!slot.handle) release();
      throw e;
    }
  }

  /** Stop the clip playing on `sn`, if any. Resolves `true` when there was one. */
  async function talkbackStop(sn) {
    const slot = active.get(sn);
    if (!slot) return false;
    slot.stopped = true;
    await slot.handle?.stop().catch(() => {});
    return true;
  }

  const stopAllTalkbacks = () => Promise.all([...active.keys()].map(talkbackStop));
  const talkbackActive = () => [...active.keys()];

  return { talkbackPlay, talkbackStop, stopAllTalkbacks, talkbackActive };
}
