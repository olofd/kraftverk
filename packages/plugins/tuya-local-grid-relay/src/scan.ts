/**
 * Commissioning aid: find Tuya devices on this network.
 *
 *   bun packages/plugins/tuya-local-grid-relay/src/scan.ts [seconds]
 *
 * Needs no local key and no cloud account — the discovery broadcast is
 * encrypted with a key every Tuya device shares. Run it first: the protocol
 * version it reports decides how the plugin has to talk to the plug, and the
 * device id it prints is half of what the configuration needs.
 */
import { scan } from './discovery.ts';

const seconds = Number(process.argv[2] ?? 12);

console.log(`Listening for Tuya broadcasts for ${seconds}s (UDP 6666, 6667, 7000)…\n`);

const devices = await scan(seconds * 1000);

if (devices.length === 0) {
  console.log('Nothing found.');
  console.log('  - the plug must be on the same LAN segment as this machine');
  console.log('  - some Wi-Fi networks block broadcast traffic between clients');
  console.log('  - a plug that has never been paired in Smart Life does not broadcast');
  process.exit(0);
}

for (const device of devices) {
  console.log(`${device.gwId}`);
  console.log(`  address       ${device.ip}`);
  console.log(`  protocol      ${device.version}`);
  console.log(`  product key   ${device.productKey ?? '—'}`);
  console.log(`  paired        ${device.active === undefined ? '—' : device.active ? 'yes' : 'no'}`);
  console.log(`  encrypted     ${device.encrypted ? 'yes (needs the local key)' : 'no'}`);
  console.log();
}

console.log(`${devices.length} device(s). The local key is not broadcast — extract it with`);
console.log('`tuya-cli wizard` (npm i -g @tuyapi/cli) or `python -m tinytuya wizard`.');
