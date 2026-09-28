# Getting your plug's local key

A Tuya smart plug will talk to anyone on your network who knows its **local key** — and it will
never tell you what that key is. The key is written at the factory and handed out only through
Tuya's cloud, to the account the plug is paired with.

So this project is local-only at runtime, and needs the cloud exactly once: now.

**Time:** about five minutes. **Cost:** nothing. **Repeat:** never, unless you re-pair the plug.

---

## Before you start

The plug must already be working in the **Smart Life** (or **Tuya Smart**) app. If you have not
paired it yet, do that first — a plug that has never been paired has no key to fetch.

---

## 1. Create a Tuya cloud project

1. Sign up at [iot.tuya.com](https://iot.tuya.com) and log in.
2. **Cloud → Development → Create Cloud Project**.
   - Give it any name.
   - **Data centre**: pick the one your phone app uses — for Sweden and the rest of Europe that
     is **Central Europe**. Getting this wrong is the most common failure, and it reports as an
     authorisation error rather than "wrong region".
3. When the project is created you are shown an **Access ID** and an **Access Secret**. Keep the
   page open; you need both.
4. On the project's **Service API** tab, make sure **IoT Core** is subscribed. It is free, and
   without it every request is refused.

## 2. Link your app account to the project

1. Open the project → **Devices** → **Link App Account** → **Add App Account**.
2. A QR code appears. In the Smart Life app: **Me → ⌐ (top right, scan)** and scan it.
3. Confirm the authorisation on the phone. Your devices now appear under the project.

That link is what lets the project read your plug's key. Nothing else is granted by it.

## 3. Fetch the key

From the repository root:

```bash
npm run keys:tuya
```

It scans your network first and offers any plugs it finds, so you do not have to type a device id
by hand. Then it asks for the data centre, Access ID and Access Secret, and prints every device on
the account with its local key.

Prefer not to type them interactively? Pass them instead:

```bash
npm run keys:tuya -- --region=eu --clientId=xxxx --clientSecret=yyyy
```

They are also read from `TUYA_REGION`, `TUYA_CLIENTID` and `TUYA_CLIENTSECRET`.

Nothing is written to disk, and the credentials are used for one request each.

## 4. Give the key to the server

In the app, the same two steps are part of adding the plug: **Add a device →
Smart plugs → ATORCH S1W** (or *Tuya smart plug*) **→ Home network, through your
server**. The plug is listed once it has been seen on the network — or type its
IP address — and the **Credentials** step has **Fetch it with my Tuya account**,
which fills in the key. The key stays on the server: the app is handed a
placeholder, never the key. The check then reads the plug once, and says which
protocol version answered and which datapoint is the relay.

A plug's key changes when it is paired again. Replace it on the plug's
**Settings → Connections**, or over the API, signed in — with the session
cookie from your browser and the header every change needs:

```bash
curl -X PUT 'http://localhost:3333/api/devices/<device id>/connections/<connection id>/secrets' \
  -b 'kraftverk_session=<from the browser>' -H 'X-Kraftverk-Client: curl' \
  -H 'Content-Type: application/json' \
  -d '{"localKey":"a1b2c3d4e5f6g7h8"}'
```

The device and connection ids are in `GET /api/devices`.

---

## When it goes wrong

| What you see | What it means |
| --- | --- |
| `connected, but no datapoints could be decoded — usually a wrong local key` | The plug is there and answering; the key does not decrypt it. Re-fetch — the key changes if the plug is re-paired. |
| `sign invalid` / authorisation errors from Tuya | Wrong data centre, or Access Secret mismatched with the Access ID. |
| `permission denied` / `not in the project's linked account` | Step 2 did not complete, or the plug is in a different Smart Life account. |
| `no API subscription` | Subscribe **IoT Core** on the project's Service API tab. |
| The scan finds nothing | The plug must be on the same LAN segment, and some Wi-Fi networks block client-to-client broadcast traffic. Guest networks usually do. |
| Trial expired after a year | Tuya's free tier needs renewing in the console. Your key does not change; you only need the cloud again if you re-pair. |

## What this means for privacy

The Access ID and Secret are yours and stay on this machine. The one cloud call asks Tuya for the
keys of devices you already own. After this, the plug is driven entirely over your LAN — the
server never contacts Tuya again, and the plug does not need internet access at all.

Treat the local key like a password: anyone on your network who has it can switch the plug.

## If you would rather not use the cloud at all

The ATORCH S1 is a BK7231N module, and can be reflashed over Wi-Fi with
[OpenBeken](https://github.com/openshwprojects/OpenBK7231T_App) using
[tuya-cloudcutter](https://github.com/tuya-cloudcutter/tuya-cloudcutter) — no soldering, no Tuya
account, and the plug then speaks plain MQTT to the broker this server already runs. It also risks
bricking the plug and voids any warranty. See [`ATORCH-S1W.md`](ATORCH-S1W.md) §5.
