/**
 * Fetches the local keys for your Tuya devices.
 *
 *   npm run keys:tuya
 *
 * The same code the app's setup screen runs — this is the terminal door to it,
 * for people who would rather not click, and for the walkthrough in
 * docs/TUYA-LOCAL-KEY.md.
 *
 * Credentials come from arguments, the environment, or prompts, and are used
 * for exactly one request each. Nothing is written to disk.
 */
import { isRegion, REGIONS, TuyaCloud, TuyaCloudError, type Region } from './cloud.ts';
import { scan } from './discovery.ts';

const flag = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const ask = (question: string, fallback?: string): string => {
  const given = flag(question) ?? process.env[`TUYA_${question.toUpperCase()}`];
  if (given) return given;
  const answer = prompt(`${question}${fallback ? ` [${fallback}]` : ''}:`) ?? '';
  return answer.trim() || fallback || '';
};

console.log('\nTuya local keys\n');
console.log('You need a Tuya IoT Platform cloud project — free, five minutes, once.');
console.log('Walkthrough: docs/TUYA-LOCAL-KEY.md\n');

// A device id is needed to bootstrap the account lookup, and the network can
// usually supply one — so offer that before asking anyone to type a 22-character
// identifier from a phone screen.
let seedDeviceId = flag('device') ?? '';

if (!seedDeviceId) {
  console.log('Looking for plugs on this network first (no credentials needed)…');
  const found = await scan(8_000);

  if (found.length > 0) {
    console.log('');
    found.forEach((device, index) => {
      console.log(`  ${index + 1}. ${device.gwId}  ${device.ip}  protocol ${device.version}`);
    });
    console.log('');
    const pick = ask('Use which number (blank to type an id)', found.length === 1 ? '1' : '');
    const index = Number(pick) - 1;
    if (Number.isInteger(index) && found[index]) seedDeviceId = found[index]!.gwId;
  } else {
    console.log('  none found — you can still paste a device id from the Smart Life app.\n');
  }
}

const regionInput = ask('region', 'eu');
if (!isRegion(regionInput)) {
  console.error(`\nUnknown data centre "${regionInput}". One of: ${Object.keys(REGIONS).join(', ')}`);
  process.exit(1);
}
const region: Region = regionInput;

const clientId = ask('clientId');
const clientSecret = ask('clientSecret');
if (!seedDeviceId) seedDeviceId = ask('deviceId');

if (!clientId || !clientSecret || !seedDeviceId) {
  console.error('\nAccess ID, Access Secret and one device id are all required.');
  process.exit(1);
}

const cloud = new TuyaCloud(region, clientId, clientSecret);

try {
  console.log(`\nAsking ${cloud.host}…`);
  await cloud.authenticate();
  const devices = await cloud.allDevices(seedDeviceId);

  console.log(`\n${devices.length} device${devices.length === 1 ? '' : 's'}:\n`);
  for (const device of devices) {
    console.log(`  ${device.name || '(unnamed)'}`);
    console.log(`    device id   ${device.id}`);
    console.log(`    local key   ${device.localKey}`);
    if (device.productName) console.log(`    product     ${device.productName}`);
    if (device.ip) console.log(`    address     ${device.ip}`);
    console.log('');
  }

  console.log('Put the key into the plugin — in the app under Extensions, or:\n');
  console.log('  curl -X PATCH http://localhost:3333/api/plugins/com.tuya-local.grid-relay/config \\');
  console.log("    -H 'Content-Type: application/json' \\");
  console.log(`    -d '{"host":"<address>","deviceId":"<device id>","localKey":"<local key>"}'\n`);
  console.log('Treat the key like a password: it is all anyone on your LAN needs to control the plug.');
} catch (error) {
  if (error instanceof TuyaCloudError) {
    console.error(`\nTuya refused: ${error.message}`);
  } else {
    console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}
