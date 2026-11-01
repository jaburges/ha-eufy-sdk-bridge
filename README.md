# ha-eufy-sdk-bridge

[![CI](https://github.com/mega-yfue/ha-eufy-sdk-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/mega-yfue/ha-eufy-sdk-bridge/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen?logo=nodedotjs&logoColor=white)](./package.json)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

The host-facing daemon: one process that logs into eufy **once** and exposes the
[`eufy-sdk`](https://github.com/mega-yfue/eufy-sdk) to a frontend — Home Assistant, a web UI,
anything. Ships as a multi-arch Docker image with [go2rtc](https://github.com/AlexxIT/go2rtc)
bundled, so live camera video is available as RTSP / WebRTC / MSE / HLS with nothing else to install.

```
WS    :3000/ws             control, state, events     ← the frontend talks to this
HTTP  :3000/stream/<sn>    live video (Annex-B)       ← go2rtc pulls this
HTTP  :3000/snapshot/<sn>  a JPEG still
HTTP  :3000/clip/<sn>      the latest detection's recording, as an mp4 (HomeBase 2)
HTTP  :3000/api/talkback/<sn>  POST an audio clip to play through the camera's speaker
HTTP  :3000/healthz        which cameras are streaming
```

Video is deliberately **not** on the WebSocket: the WS hands back a URL, and _connecting to that URL
is what starts the camera — disconnecting is what stops it_. There is no "stream is running" flag to
drift out of sync.

## Run it

Pull the published image and run it (bundles the SDK + go2rtc):

```bash
docker run -d --name eufy-bridge --network host \
  -e EUFY_EMAIL='you@example.com' -e EUFY_PASSWORD='…' -e EUFY_COUNTRY='GB' \
  -v /opt/eufy-bridge-data:/app/data \
  ghcr.io/mega-yfue/ha-eufy-sdk-bridge:latest
```

or with Compose (`cp .env.example .env` first): `docker compose up -d`.

**Full deploy guide (alongside Home Assistant, config reference, first-run 2FA/captcha):**
[docs/docker-compose.md](./docs/docker-compose.md) · **WS protocol:** [docs/ws-protocol.md](./docs/ws-protocol.md) ·
**Troubleshooting:** [docs/troubleshooting.md](./docs/troubleshooting.md)

## Play a sound through a camera's speaker (talkback)

`POST /api/talkback/<serial>` plays an audio clip (MP3, WAV, anything ffmpeg decodes) through the
speaker of a camera, doorbell or video lock. The bridge fetches the file, transcodes it with the bundled
ffmpeg to the AAC-LC 16 kHz mono stream the device expects, and streams it at realtime. Only devices
whose camera reports a speaker (param 1241) support it; others answer `422`.

```bash
curl -X POST http://<unraid-ip>:3033/api/talkback/<serial> \
  -H 'content-type: application/json' \
  -d '{"url": "http://<ha-ip>:8123/local/halloween/scream.mp3", "volume": 150, "max_seconds": 10}'
# → 202 {"ok":true,"sn":"<serial>","durationMs":4032,"maxSeconds":10,"volume":150,"started":true}

# or upload the file itself
curl -X POST http://<unraid-ip>:3033/api/talkback/<serial> -F file=@scream.mp3
# stop it early
curl -X DELETE http://<unraid-ip>:3033/api/talkback/<serial>
```

- `url` must be `http://` or `https://`. Alternatively send the file as the raw body or as a multipart
  `file` part.
- `volume` is a gain in percent (`0`–`400`, default `100`) applied while transcoding. The device's own
  speaker volume setting is not changed.
- `max_seconds` cuts the clip short. It can never exceed `TALKBACK_MAX_SECONDS` (default 30). Files are
  capped at `TALKBACK_MAX_BYTES` (default 10 MiB), and a URL must answer within
  `TALKBACK_FETCH_TIMEOUT_MS` (default 15 s).
- The bridge answers `202` once the speaker is open and audio is flowing. Add `"wait": true` to get a
  `200` only after the whole clip has played. Other answers: `404` for an unknown serial, `409` if a clip
  is already playing on that device, and `413` if the file is too large.
- The same feature is available over the WebSocket as `device.talkback_play`; see
  [docs/ws-protocol.md](./docs/ws-protocol.md).
- Like every other bridge endpoint, this one has no authentication of its own. Keep the bridge port on
  your LAN.

The port in these examples is `3033` because that is the host port mapped to the container's `3000`;
use whatever you mapped. The `<serial>` is the device serial number, shown on the device's page in Home
Assistant or in the `devices.list` WS reply.

### From Home Assistant

Put the clip in Home Assistant's `config/www/` folder, for example `config/www/halloween/scream.mp3`.
HA then serves it at `http://<ha-ip>:8123/local/halloween/scream.mp3`. Next, add a `rest_command` to
`configuration.yaml`:

```yaml
rest_command:
  eufy_talkback:
    url: "http://<unraid-ip>:3033/api/talkback/{{ serial }}"
    method: POST
    content_type: "application/json"
    # Opening the speaker can take several seconds on a sleeping battery device.
    timeout: 30
    payload: >-
      {"url": "{{ media_url }}",
       "volume": {{ volume | default(100) }},
       "max_seconds": {{ max_seconds | default(30) }}}
```

Then call it from an automation. This example plays a scream when the floodlight camera sees a person
after dark. Replace the entity id with your camera's person-detection entity and the serial with your
device's serial:

```yaml
automation:
  - alias: "Halloween scream on person detection"
    mode: single
    trigger:
      - platform: state
        entity_id: binary_sensor.floodlight_cam_e340_person_detected
        to: "on"
    condition:
      - condition: sun
        after: sunset
    action:
      - service: rest_command.eufy_talkback
        data:
          serial: "T8425XXXXXXXXXXX"
          media_url: "http://<ha-ip>:8123/local/halloween/scream.mp3"
          volume: 150
          max_seconds: 10
      # Don't retrigger while the clip plays (the bridge would answer 409 anyway).
      - delay: "00:00:15"
```

## Doorbell rings (including video locks)

A doorbell press reaches the WS as a `doorbellPress` event (eufy push type 3103). The bridge also lists
`doorbell` in a device's `capabilities`, which is what the Home Assistant integration uses to decide
whether to build these doorbell entities:

- an **event** entity named `<device> Doorbell` (device class `doorbell`), which fires event type `ring`;
- a **binary_sensor** named `<device> Ringing`, which turns on with each press and back off after 30 s;
- a **device trigger** called "Doorbell ringing";
- a `<device> Package` binary_sensor.

The SDK recognises a doorbell by its model name, which leaves out video smart locks such as the
FamiLock S3 (T85V0), even though their keypad has a doorbell button. The bridge therefore reports any
lock that also has a camera as a doorbell. After updating the bridge, **reload the eufy integration in
Home Assistant** (or restart HA) so it creates the new entities.

For a lock named "Front Door", trigger an automation on its Doorbell event entity:

```yaml
automation:
  - alias: "Front door rang"
    mode: single
    trigger:
      - platform: state
        entity_id: event.front_door_doorbell
    condition:
      # The event entity's state is the time it last fired; skip the restore at startup.
      - condition: template
        value_template: >-
          {{ trigger.from_state is not none
             and trigger.from_state.state != 'unavailable'
             and trigger.to_state.attributes.event_type == 'ring' }}
    action:
      - service: notify.mobile_app_phone
        data:
          message: "Someone rang the front door"
```

Alternatively, trigger on `binary_sensor.front_door_ringing` turning `on`, or pick the device in the
automation editor and choose its "Doorbell ringing" trigger.

The `ring` type appears on the **Doorbell** event entity, not on the "Detection" one
(`event.front_door_detection`). Detection's event types are fixed in the integration and don't include
a ring.

**Checking that a press arrives.** The event log is on by default (`BRIDGE_EVENT_LOG=1`). Each press
should log two lines:

```
[bridge:event] push raw: event_type=3103 (PRESS_DOORBELL) sn=T85V0K102515088E
[bridge:event] push in: doorbellPress sn=T85V0K102515088E [detection → HA refreshes Last event] → broadcast to 1 frontend client(s)
```

- **Only the `push raw:` line appears, with a different `event_type`:** the device rings with another
  push type. Set `BRIDGE_RING_EVENT_TYPES=<that number>` and restart the bridge, and that type is
  reported as a `doorbellPress` too.
- **No `push raw:` line at all:** the push never reached the bridge. Check `pushConnected` in
  `/healthz`, and make sure doorbell notifications are on for the device in the eufy app.
- **The device isn't shown as a doorbell:** add its serial to `BRIDGE_DOORBELL_DEVICES`.

`BRIDGE_DEBUG_P2P=1` adds the SDK's own trace for each push (`[push] in: eventType=… events=…`), along
with a lot of transport noise, so turn it off again afterwards.

## Where it fits

| Repo                                                                  | Role                                          |
| --------------------------------------------------------------------- | --------------------------------------------- |
| [`eufy-sdk`](https://github.com/mega-yfue/eufy-sdk)                   | the HA-agnostic library                       |
| **`ha-eufy-sdk-bridge`**                                              | **this** — WS + HTTP + go2rtc daemon (Docker) |
| [`ha-eufy-sdk-addon`](https://github.com/mega-yfue/ha-eufy-sdk-addon) | Home Assistant add-on wrapper                 |
| [`ha-eufy-sdk`](https://github.com/mega-yfue/ha-eufy-sdk)             | the HACS integration (front door)             |

> Status: working — WS control + auth-over-WS (2FA/captcha), device listing, snapshots, and go2rtc
> streaming. **Optional Anker Solix** support (power stations / smart meter / Solarbank, a separate account)
> via `SOLIX_EMAIL` / `SOLIX_PASSWORD` — see [docs/ws-protocol.md](./docs/ws-protocol.md) (`solix.*`).
> Published image: `ghcr.io/mega-yfue/ha-eufy-sdk-bridge` (multi-arch: `amd64` · `arm64`).
> [`.github/workflows/publish-ghcr.yml`](./.github/workflows/publish-ghcr.yml) publishes to
> `ghcr.io/<owner>/<repo>` (so a fork publishes under its own account): a push to `main` pushes `:latest`
> and `:sha-<short>`, a `vX.Y.Z` tag (or a GitHub Release) adds `:X.Y.Z` / `:X.Y`, and a pull request
> only builds. The same
> build runs locally via [`scripts/publish-multiarch.sh`](./scripts/publish-multiarch.sh). A merge to the
> `dev` branch publishes a rolling `:dev` tag for testing.

## Contributing

Contributions are welcome — please branch from **`dev`** and open your PR against **`dev`** (not
`main`). See [CONTRIBUTING.md](./CONTRIBUTING.md) for the branch model, CI checks, and how releases
are cut.

## Develop

The bridge is ESM (no build step) and depends on the SDK as a normal npm package
([`@mega-yfue/eufy-sdk`](https://www.npmjs.com/package/@mega-yfue/eufy-sdk)) — `npm install` pulls it
from the registry, no sibling checkout needed.

```bash
npm install
npm test          # node --test
npm run lint      # prettier --check .   (npm run format to fix)
```

Every PR into `main` or `dev` runs the CI gate ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)):
`npm ci` → lint → compile (`node --check` on each `.mjs`) → test. `main` is the public release line;
`dev` is the development line (rolling `:dev` image).
