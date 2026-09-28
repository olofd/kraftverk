# Getting your plug's local key

A Tuya smart plug will talk to anyone on your network who knows its **local key** — and it will
never tell you what that key is. The key is written at the factory and handed out only through
Tuya's cloud, to the account the plug is paired with.

So this project is local-only at runtime, and needs the cloud exactly once: now.

**Time:** about a minute. **Cost:** nothing. **Repeat:** never, unless you re-pair the plug.

---

## Before you start

The plug must already be working in the **Smart Life** (or **Tuya Smart**) app. If you have not
paired it yet, do that first — a plug that has never been paired has no key to fetch.

---

## 1. Sign in with the app — the easy way

From the repository root:

```bash
npm run keys:tuya
```

1. It asks for your **User Code**. In the app: **Me → Settings (gear, top right) → Account and
   Security → User Code**. Or pass it: `--userCode=…`, or `TUYA_USERCODE`.
2. A QR code appears in the terminal. In the app: **Me → the scan icon (top right)**, scan it,
   and confirm.
3. Every device on the account is printed with its local key; the ones broadcasting on this
   network are marked, with their address and protocol version.

No developer account, no cloud project, and no subscription to expire. This is the login Home
Assistant's Tuya integration uses, so the phone asks you to authorise **"Home Assistant"** — that
is the name Tuya registered for it, and there is no way to register another. The token it grants
is used for the one listing and never kept.

If that route is ever closed, the cloud project below still works.

---

## Or: through a Tuya cloud project

The original route, and what the app's **Fetch it with my Tuya account** button uses. It needs a
developer account whose **IoT Core** trial lapses after a month or so (see the table at the end).

### 1. Create a Tuya cloud project

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

### 2. Link your app account to the project

1. Open the project → **Devices** → **Link App Account** → **Add App Account**.
2. A QR code appears. In the Smart Life app: **Me → ⌐ (top right, scan)** and scan it.
3. Confirm the authorisation on the phone. Your devices now appear under the project.

That link is what lets the project read your plug's key. Nothing else is granted by it.

### 3. Fetch the key

From the repository root:

```bash
npm run keys:tuya -- --developer
```

It scans your network first and offers any plugs it finds, so you do not have to type a device id
by hand. Then it asks for the data centre, Access ID and Access Secret, and prints every device on
the account with its local key.

Prefer not to type them interactively? Pass them instead — giving a client id selects this route
without `--developer`:

```bash
npm run keys:tuya -- --region=eu --clientId=xxxx --clientSecret=yyyy
```

They are also read from `TUYA_REGION`, `TUYA_CLIENTID` and `TUYA_CLIENTSECRET`.

Nothing is written to disk, and the credentials are used for one request each.

---

## Give the key to the server

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
| `IoT Core service subscription has expired` | The cloud project's trial ran out — it lasts about a month. **Cloud → Cloud Services → IoT Core → Extend Trial Period** asks for more; "subscribe to trial" is refused a second time. Or skip the project: `npm run keys:tuya` without `--developer`. |
| `check the User Code` | The Smart Life route: the code is in **Me → Settings → Account and Security**, and belongs to the account the plug is paired with. |
| `Nobody scanned the code within three minutes` | Run it again for a fresh code. Scan with the Smart Life app's own scanner, not the phone camera. |

## What this means for privacy

The User Code, the login token, and the Access ID and Secret all stay on this machine. The one
cloud call asks Tuya for the keys of devices you already own. After this, the plug is driven entirely over your LAN — the
server never contacts Tuya again, and the plug does not need internet access at all.

Treat the local key like a password: anyone on your network who has it can switch the plug.

## If you would rather not use the cloud at all

The ATORCH S1 is a BK7231N module, and can be reflashed over Wi-Fi with
[OpenBeken](https://github.com/openshwprojects/OpenBK7231T_App) using
[tuya-cloudcutter](https://github.com/tuya-cloudcutter/tuya-cloudcutter) — no soldering, no Tuya
account, and the plug then speaks plain MQTT to the broker this server already runs. It also risks
bricking the plug and voids any warranty. See [`ATORCH-S1W.md`](ATORCH-S1W.md) §5.
