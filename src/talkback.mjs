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
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const SAMPLE_RATE = 16_000;
const FRAME_MS = (1024 / SAMPLE_RATE) * 1000; // one AAC-LC frame = 1024 samples = 64 ms
const ADTS_SAMPLE_RATE_INDEX_16K = 8;
const TRANSCODE_TIMEOUT_MS = 30_000;
// How long past the clip's own duration playback may take before it is abandoned (a slow P2P open is
// already behind us by then, so this only covers pacing jitter and the stop frame).
const PLAYBACK_SLACK_MS = 15_000;
const MAX_DELAY_MS = 60_000;
// The device's answer to a talkback start: the SDK's 1700 CONTROL_PAYLOAD, or 1005 CMD_START_TALKBACK.
const TALKBACK_ANSWER_COMMANDS = new Set([1700, 1005]);
// eufy-security-client's refusals of a talkback start: ERROR_DEV_BUSY ("Wait a second, device is busy")
// and ERROR_NOT_FIND_DEV ("Someone is responding now").
const BUSY_CODES = new Set([-114, -106]);
const MAX_VOLUME_PERCENT = 400;

/** An error carrying the HTTP status the route should answer with. */
export const talkbackError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Split `buf` into its ADTS frames, checking each is AAC-LC 16 kHz mono — the only audio the SDK's
 * talkback accepts. Throws a 422 on anything else, so a bad transcode never reaches the camera.
 */
export function adtsFrames(buf) {
  const frames = [];
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
    frames.push(buf.subarray(off, off + len));
    off += len;
  }
  return frames;
}

/** How many frames {@link adtsFrames} finds in `buf`. */
export const adtsFrameCount = (buf) => adtsFrames(buf).length;

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

/** Sleep `ms`, returning early when `stop` (an EventEmitter) emits "stop". */
async function sleepUnlessStopped(ms, stop) {
  const ac = new AbortController();
  const onStop = () => ac.abort();
  stop.once("stop", onStop);
  try {
    await sleep(ms, undefined, { signal: ac.signal });
  } catch {
    /* stopped early */
  } finally {
    stop.off("stop", onStop);
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
    delayMs: q.get("delay_ms") ?? q.get("delayMs") ?? undefined,
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
      ["delayMs", ["delay_ms", "delayMs"]],
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
  function normalize({ url, audio, volume, maxSeconds, wait, delayMs }) {
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
    let delay = cfg.talkbackDelayMs;
    if (delayMs != null && delayMs !== "") {
      delay = Number(delayMs);
      if (!Number.isSafeInteger(delay) || delay < 0 || delay > MAX_DELAY_MS)
        throw talkbackError(400, `delay_ms must be a whole number of ms from 0 to ${MAX_DELAY_MS}`);
    }
    return {
      url: hasUrl ? url : undefined,
      audio,
      volume: vol,
      maxSeconds: seconds,
      wait: truthy(wait),
      delayMs: delay,
    };
  }

  /** Pace `frames` into an open handle; resolves once the clip has reached the wire (or was stopped). */
  function runPlayback(sn, slot, handle, frames) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let yielded = 0;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const sent = Math.max(0, yielded - (handle.pending ?? 0));
        log(`talkback ${sn} → frames sent: ${sent}/${frames.length}`);
        Promise.resolve()
          .then(() => handle.stop())
          .catch((e) => console.error(`[bridge] talkback ${sn}: stop failed: ${e?.message ?? e}`))
          .finally(() => {
            if (slot.stopped) return resolve({ finished: false, stopped: true, framesSent: sent });
            if (err) return reject(err);
            resolve({ finished: true, framesSent: sent });
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
      const source = function* () {
        for (const frame of frames) {
          yielded += 1;
          yield frame;
        }
      };
      pipeline(Readable.from(source()), handle.writable()).catch((e) => finish(e));
    });
  }

  /**
   * Hold a live stream open on `cam` and wait for its first video frame. eufy-security-client refuses to
   * start talkback without a running livestream, and the SDK's own talkback attaches to the shared live
   * source without waiting for it to deliver — so on a device still waking, the clip can be paced into a
   * session that is not serving yet. Joining that same source first and seeing a frame closes that gap.
   * Also records the codec the device streams its own audio in, for the codec log line.
   */
  async function warmLive(sn, cam, stop) {
    const t0 = Date.now();
    log(`talkback ${sn} → live stream requested (waiting up to ${cfg.talkbackWarmTimeoutMs} ms for a frame)`);
    let consumer;
    try {
      consumer = await cam.live();
    } catch (e) {
      throw talkbackError(502, `opening the live stream failed: ${e?.message ?? e}`);
    }
    const live = {
      audioCodec: undefined,
      release: () => {
        try {
          consumer.stop();
        } catch {
          /* already stopped */
        }
      },
    };
    consumer.on("audio", (frame) => {
      if (live.audioCodec || !frame?.codec) return;
      live.audioCodec = frame.codec;
      log(`talkback ${sn} → device's own live audio codec: ${frame.codec}`);
    });
    consumer.on("budget", (notice) => notice?.extend?.());
    let video;
    try {
      video = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no video frame within ${cfg.talkbackWarmTimeoutMs} ms`)),
          cfg.talkbackWarmTimeoutMs,
        );
        const done = (fn) => (v) => {
          clearTimeout(timer);
          stop.off("stop", onStop);
          fn(v);
        };
        const onStop = done(() => reject(new Error("stopped by request")));
        stop.once("stop", onStop);
        consumer.once("video", done(resolve));
        consumer.once("error", done(reject));
        consumer.once(
          "stop",
          done(() => reject(new Error("the live stream stopped before its first frame"))),
        );
      });
    } catch (e) {
      live.release();
      throw talkbackError(502, `live stream not confirmed: ${e?.message ?? e}`);
    }
    consumer.on("error", (e) => log(`talkback ${sn} → live stream error: ${e?.message ?? e}`));
    const geometry = video?.width ? ` ${video.width}x${video.height}` : "";
    log(`talkback ${sn} → live stream confirmed in ${Date.now() - t0} ms (video ${video?.codec ?? "?"}${geometry})`);
    return live;
  }

  /**
   * Watch `stationSn`'s P2P frames for the device's answer to a talkback start: the 1700 control
   * payload the SDK sends, or eufy-security-client's 1005 CMD_START_TALKBACK. Resolves
   * `{ confirmed, reason }` — a busy/someone-responding code or no answer within the window is not a
   * confirmation. Without an observable P2P stream the start is taken on trust, as the SDK does.
   */
  function watchAnswer(sn, stationSn) {
    if (!cfg.talkbackConfirmMs) return { result: Promise.resolve({ confirmed: true, reason: "not awaited" }) };
    if (typeof eufy.on !== "function" || typeof eufy.off !== "function")
      return { result: Promise.resolve({ confirmed: true, reason: "answer not observable" }) };
    let onFrame;
    let timer;
    const result = new Promise((resolve) => {
      onFrame = (f) => {
        if (f?.stationSn !== stationSn || !TALKBACK_ANSWER_COMMANDS.has(f.commandId)) return;
        const data = f.data ?? Buffer.alloc(0);
        const code = data.length >= 4 ? data.readInt32LE(0) : undefined;
        log(
          `talkback ${sn} → device answered ${f.commandName ?? "?"}(${f.commandId}) ${data.length}B` +
            ` code=${code ?? "?"} head=${data.subarray(0, 16).toString("hex")}`,
        );
        if (BUSY_CODES.has(code)) resolve({ confirmed: false, reason: `device busy (code ${code})` });
        else resolve({ confirmed: true, reason: `answered ${f.commandId}` });
      };
      eufy.on("p2p", onFrame);
      timer = setTimeout(
        () => resolve({ confirmed: false, reason: `no answer within ${cfg.talkbackConfirmMs} ms` }),
        cfg.talkbackConfirmMs,
      );
    }).finally(() => {
      clearTimeout(timer);
      eufy.off("p2p", onFrame);
    });
    return { result };
  }

  /** Open the talkback path, retrying while the device does not confirm it. Returns the open handle. */
  async function openConfirmed(sn, cam, stationSn, slot) {
    const attempts = 1 + cfg.talkbackRetries;
    let reason = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (slot.stopped) return undefined;
      log(`talkback ${sn} → session requested (attempt ${attempt}/${attempts})`);
      const answer = watchAnswer(sn, stationSn);
      let handle;
      try {
        handle = await cam.talkback();
      } catch (e) {
        answer.result.catch(() => {});
        const msg = String(e?.message ?? e);
        throw talkbackError(/already talking/i.test(msg) ? 409 : 502, `opening talkback failed: ${msg}`);
      }
      slot.handle = handle;
      const outcome = await answer.result;
      if (outcome.confirmed) {
        log(`talkback ${sn} → session confirmed (${outcome.reason})`);
        slot.attempts = attempt;
        slot.confirmation = outcome.reason;
        return handle;
      }
      reason = outcome.reason;
      log(`talkback ${sn} → session not confirmed: ${reason}`);
      slot.handle = undefined;
      await handle.stop().catch(() => {});
      if (attempt < attempts) await sleep(cfg.talkbackRetryDelayMs);
    }
    throw talkbackError(502, `talkback session not confirmed by ${sn} after ${attempts} attempt(s): ${reason}`);
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
    const slot = { stopped: false, durationMs: 0, stop: new EventEmitter() };
    active.set(sn, slot);
    const release = () => {
      slot.live?.release();
      slot.live = undefined;
      if (active.get(sn) === slot) active.delete(sn);
    };
    const stopped = () => ({ started: false, stopped: true, durationMs: slot.durationMs });
    try {
      let dev;
      let cam;
      try {
        dev = await eufy.getDevice(sn);
        cam = dev.camera?.();
      } catch (e) {
        throw talkbackError(404, `unknown device ${sn}: ${e?.message ?? e}`);
      }
      if (typeof cam?.talkback !== "function")
        throw talkbackError(422, `${sn} has no talkback (it needs a camera speaker, param 1241)`);
      const input =
        opts.audio ??
        (await fetchClip(opts.url, { maxBytes: cfg.talkbackMaxBytes, timeoutMs: cfg.talkbackFetchTimeoutMs }));
      const adts = await transcode(input, { maxSeconds: opts.maxSeconds, volume: opts.volume });
      const frames = adtsFrames(adts);
      if (!frames.length) throw talkbackError(422, "the audio decoded to nothing");
      slot.durationMs = Math.round(frames.length * FRAME_MS);
      if (opts.delayMs) {
        log(`talkback ${sn} → waiting ${opts.delayMs} ms before opening the session`);
        await sleepUnlessStopped(opts.delayMs, slot.stop);
      }
      if (slot.stopped) {
        release();
        return stopped();
      }
      if (!cfg.talkbackLivestream) log(`talkback ${sn} → live stream skipped (BRIDGE_TALKBACK_LIVESTREAM=0)`);
      else if (typeof cam.live !== "function") log(`talkback ${sn} → live stream unavailable on this device`);
      else slot.live = await warmLive(sn, cam, slot.stop);
      const handle = await openConfirmed(sn, cam, dev.stationSn ?? sn, slot);
      if (!handle || slot.stopped) {
        await handle?.stop().catch(() => {});
        release();
        return stopped();
      }
      const deviceCodec = slot.live?.audioCodec ?? (slot.live ? "not seen yet" : "unknown (no live stream)");
      log(
        `talkback ${sn} → codec: sending AAC-LC ${SAMPLE_RATE} Hz mono ADTS, ${frames.length} frames ` +
          `(${slot.durationMs} ms), volume ${opts.volume}%; device's own live audio: ${deviceCodec}` +
          `${slot.live?.audioCodec && slot.live.audioCodec !== "aac-lc" ? " (differs from what talkback sends)" : ""}`,
      );
      log(`talkback ${sn} → playing ${slot.durationMs} ms (${frames.length} frames, volume ${opts.volume}%)`);
      const done = runPlayback(sn, slot, handle, frames)
        .then((r) => {
          log(`talkback ${sn} → stopped (${r.stopped ? "stopped by request" : "finished"})`);
          return r;
        })
        .catch((e) => {
          console.error(`[bridge] talkback ${sn} failed: ${e?.message ?? e}`);
          log(`talkback ${sn} → stopped (error: ${e?.message ?? e})`);
          throw e;
        })
        .finally(release);
      const base = {
        sn,
        durationMs: slot.durationMs,
        maxSeconds: opts.maxSeconds,
        volume: opts.volume,
        delayMs: opts.delayMs,
        attempts: slot.attempts,
        confirmation: slot.confirmation,
        deviceAudioCodec: slot.live?.audioCodec ?? null,
      };
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
      if (slot.stopped && e?.status === 502) return stopped(); // a stop interrupted the warm-up or the open
      throw e;
    }
  }

  /** Stop the clip playing on `sn`, if any. Resolves `true` when there was one. */
  async function talkbackStop(sn) {
    const slot = active.get(sn);
    if (!slot) return false;
    slot.stopped = true;
    slot.stop.emit("stop");
    await slot.handle?.stop().catch(() => {});
    return true;
  }

  const stopAllTalkbacks = () => Promise.all([...active.keys()].map(talkbackStop));
  const talkbackActive = () => [...active.keys()];

  return { talkbackPlay, talkbackStop, stopAllTalkbacks, talkbackActive };
}
