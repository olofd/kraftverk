/**
 * Finds Tuya devices on this network, with no credentials.
 *
 *   npm run scan:tuya [-- seconds]
 *
 * The discovery broadcast is encrypted with a key every Tuya device shares, so
 * this needs no local key and no cloud account. Run it first: the protocol
 * version it reports decides how a plug has to be spoken to, and the device id
 * it prints is what fetching the key starts from. The app's add flow listens
 * the same way (the `lan` transport); this is the terminal's door to it.
 */
import { listen } from './listen.ts';

const seconds = Number(process.argv[2] ?? 12);
console.log(`Listening for Tuya broadcasts for ${seconds}s (UDP 6666, 6667, 7000)…\n`);

const devices = await listen(seconds * 1000);

if (devices.length === 0) {
  console.log('Nothing found.');
  console.log('  - the plug must be on the same network segment as this machine');
  console.log('  - some Wi-Fi networks block broadcast traffic between clients');
  console.log('  - a plug that has never been paired in Smart Life does not broadcast');
  process.exit(0);
}

for (const device of devices) {
  console.log(device.gwId);
  console.log(`  address       ${device.ip}`);
  console.log(`  protocol      ${device.version}`);
  console.log(`  product key   ${device.productKey ?? '—'}`);
  console.log(`  paired        ${device.active === undefined ? '—' : device.active ? 'yes' : 'no'}`);
  console.log(`  encrypted     ${device.encrypted ? 'yes (needs the local key)' : 'no'}`);
  console.log();
}

console.log(`${devices.length} device(s). The local key is not broadcast: \`npm run keys:tuya\` fetches it.`);
