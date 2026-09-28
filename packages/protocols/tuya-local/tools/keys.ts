/**
 * Fetches the local keys for your Tuya devices.
 *
 *   npm run keys:tuya                      sign in with the Smart Life app (QR code)
 *   npm run keys:tuya -- --developer       through a Tuya IoT Platform cloud project
 *
 * The default needs nothing but the app: type its User Code, scan a QR code,
 * and every device on the account is listed with its key. The cloud-project
 * path is the same request the add flow's "Fetch it with my Tuya account"
 * makes, and is taken whenever project credentials are given.
 *
 * Credentials come from arguments, the environment, or prompts, and are used
 * for exactly one listing. Nothing is written to disk.
 */
import { toQR } from 'toqr';

import { isRegion, REGIONS, TuyaCloud, TuyaCloudError, type CloudDevice, type Region } from '../src/cloud.ts';
import type { DiscoveredTuyaDevice } from '../src/discovery.ts';
import { pollLogin, qrLoginContent, requestQrToken, smartLifeDevices, SmartLifeError } from '../src/smartlife.ts';
import { listen } from './listen.ts';

const flag = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const ask = (question: string, fallback?: string): string => {
  const given = flag(question) ?? process.env[`TUYA_${question.toUpperCase()}`];
  if (given) return given;
  const answer = prompt(`${question}${fallback ? ` [${fallback}]` : ''}:`) ?? '';
  return answer.trim() || fallback || '';
};

const http = (url: string, init?: RequestInit & { timeoutMs?: number }) => {
  const { timeoutMs = 15_000, ...rest } = init ?? {};
  return fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A QR code in the terminal, two modules per character cell. Drawn dark on an
 * explicitly light background: phone scanners want dark modules, and a dark
 * terminal theme would otherwise invert it.
 */
function drawQr(content: string): string {
  const modules = toQR(content);
  const size = Math.sqrt(modules.length);
  const quiet = 2;
  const dark = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < size && y < size && modules[y * size + x] === 1;
  const lines: string[] = [];
  for (let y = -quiet; y < size + quiet; y += 2) {
    let line = '';
    for (let x = -quiet; x < size + quiet; x++) {
      const top = dark(x, y);
      const bottom = dark(x, y + 1);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`  \x1b[30;47m${line}\x1b[0m`);
  }
  return lines.join('\n');
}

async function withSmartLifeApp(): Promise<CloudDevice[]> {
  console.log('Sign in with the Smart Life (or Tuya Smart) app — no developer account needed.\n');
  console.log('In the app: Me → Settings (gear, top right) → Account and Security → User Code.\n');
  const userCode = ask('userCode');
  if (!userCode) throw new Error('The User Code is required.');

  const token = await requestQrToken(http, userCode);
  console.log('\nScan this with the same app: Me → the scan icon, top right.\n');
  console.log(drawQr(qrLoginContent(token)));
  console.log('\nThe phone asks to authorise "Home Assistant": that is the name Tuya gave this login.');
  console.log('Waiting for the scan…');

  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const session = await pollLogin(http, token, userCode);
    if (session) {
      console.log(`\nSigned in. Asking ${new URL(session.endpoint).host}…`);
      return smartLifeDevices(http, session);
    }
  }
  throw new SmartLifeError('Nobody scanned the code within three minutes. Run it again for a fresh one.');
}

async function withCloudProject(found: Promise<DiscoveredTuyaDevice[]>): Promise<CloudDevice[]> {
  console.log('Through a Tuya IoT Platform cloud project. Walkthrough: docs/TUYA-LOCAL-KEY.md\n');

  // A device id is needed to bootstrap the account lookup, and the network can
  // usually supply one — so offer that before asking anyone to type a 22-character
  // identifier from a phone screen.
  let seedDeviceId = flag('device') ?? '';
  if (!seedDeviceId) {
    console.log('Looking for plugs on this network first (no credentials needed)…');
    const seen = await found;
    if (seen.length > 0) {
      console.log('');
      seen.forEach((device, index) => console.log(`  ${index + 1}. ${device.gwId}  ${device.ip}  protocol ${device.version}`));
      console.log('');
      const pick = ask('Use which number (blank to type an id)', seen.length === 1 ? '1' : '');
      const index = Number(pick) - 1;
      if (Number.isInteger(index) && seen[index]) seedDeviceId = seen[index]!.gwId;
    } else {
      console.log('  none found — you can still paste a device id from the Smart Life app.\n');
    }
  }

  const regionInput = ask('region', 'eu');
  if (!isRegion(regionInput)) {
    throw new Error(`Unknown data centre "${regionInput}". One of: ${Object.keys(REGIONS).join(', ')}`);
  }
  const region: Region = regionInput;
  const clientId = ask('clientId');
  const clientSecret = ask('clientSecret');
  if (!seedDeviceId) seedDeviceId = ask('deviceId');
  if (!clientId || !clientSecret || !seedDeviceId) {
    throw new Error('Access ID, Access Secret and one device id are all required.');
  }

  const cloud = new TuyaCloud(region, clientId, clientSecret, http);
  console.log(`\nAsking ${cloud.host}…`);
  await cloud.authenticate();
  return cloud.allDevices(seedDeviceId);
}

console.log('\nTuya local keys\n');

const developer = process.argv.includes('--developer') || Boolean(flag('clientId') ?? process.env.TUYA_CLIENTID);
// Listening costs nothing and runs while the person is busy with their phone;
// it is how the list below says which devices are on this network.
const found = listen(8_000);

try {
  const devices = developer ? await withCloudProject(found) : await withSmartLifeApp();
  const local = new Map((await found).map((device) => [device.gwId, device]));

  console.log(`\n${devices.length} device${devices.length === 1 ? '' : 's'}:\n`);
  for (const device of devices) {
    const here = local.get(device.id);
    console.log(`  ${device.name || '(unnamed)'}${here ? '   ← on this network' : ''}`);
    console.log(`    device id   ${device.id}`);
    console.log(`    local key   ${device.localKey || '(none — not a device that speaks Tuya on the LAN)'}`);
    if (device.productName) console.log(`    product     ${device.productName}`);
    if (here) console.log(`    address     ${here.ip}, protocol ${here.version}`);
    console.log('');
  }
  console.log('Add the plug in the app — Smart plugs, then your plug — and paste the key when it asks.');
  console.log('Treat the key like a password: it is all anyone on your network needs to control the plug.');
  process.exit(0);
} catch (error) {
  const refused = error instanceof TuyaCloudError || error instanceof SmartLifeError;
  console.error(refused ? `\nTuya refused: ${error.message}` : `\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
