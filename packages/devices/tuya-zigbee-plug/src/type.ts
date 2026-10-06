import { defineTuyaSocket, type SocketProfile } from '@kraftverk/integration-tuya';

/**
 * A 16 A Zigbee energy plug, paired with a Tuya Zigbee gateway: the Tuya
 * socket, reached through the gateway on the home network rather than on Wi-Fi.
 *
 * Every datapoint here was established on a real one, behind an RSH GW018-DM
 * (README.md): changed in the Smart Life app while kraftverk listened to the
 * gateway, and read off the wire. The gateway has no key of its own in Tuya's
 * cloud: the plug's is the gateway's, and it names the plug by its Zigbee
 * address — so the plug's address here is the gateway's, `#`, that address.
 *
 * What is offered as a setting: what it does after a power cut, its indicator
 * light, and locking its button. Its countdown is read, to explain a switch
 * nobody pressed, and never offered: timing things is kraftverk's automations'
 * job. So are the app's schedules, cycles and random switching, which live
 * with the gateway or the cloud and reach kraftverk only as a switch.
 */

const SETTING = { access: 'write', category: 'config' } as const;

export const ZIGBEE_PLUG: SocketProfile = {
  id: 'tuya-zigbee-plug-16a',
  label: 'Tuya Zigbee energy plug, 16 A',
  relay: { dp: 1 },
  // Measured when asked: each poll has the gateway ask the plug, and what changed is pushed (README.md). Energy it pushes on its own.
  metrics: {
    amps: { dp: 18, scale: 3 },
    watts: { dp: 19, scale: 1 },
    volts: { dp: 20, scale: 1 },
    // In Wh — where a Wi-Fi socket's generic layout counts hundredths of a kWh.
    kwh: { dp: 17, scale: 3 },
  },
  datapoints: [
    {
      dp: 27,
      key: 'afterPowerCut',
      label: 'After a power cut',
      description: 'What the plug does when the mains comes back. It keeps this itself, so it holds even with kraftverk and the gateway down.',
      value: { type: 'enum', options: [{ value: 'asItWas', label: 'Back to how it was' }, { value: 'on', label: 'Always on' }, { value: 'off', label: 'Stay off' }] },
      // The app calls "back to how it was" Keep.
      wire: { asItWas: 'memory', on: 'on', off: 'off' },
      ...SETTING,
      section: 'Power',
      consequence: 'Stay off leaves whatever it feeds without power after every cut until someone switches it on.',
      example: 'asItWas',
    },
    {
      dp: 28,
      key: 'indicator',
      label: 'Indicator light',
      description: 'The light on the plug.',
      value: {
        type: 'enum',
        options: [
          { value: 'showsOn', label: 'Lit while it is on' },
          { value: 'findInDark', label: 'Lit while it is off, to find it in the dark' },
          { value: 'off', label: 'Always off' },
        ],
      },
      wire: { showsOn: 'relay', findInDark: 'pos', off: 'none' },
      ...SETTING,
      section: 'Light',
      example: 'showsOn',
    },
    {
      dp: 29,
      key: 'buttonLocked',
      label: 'Button locked',
      description: 'The button on the plug does nothing — a child lock. Undone at the plug too: press its button four times, or unplug it.',
      value: { type: 'boolean', words: { true: 'Locked', false: 'Unlocked' } },
      ...SETTING,
      section: 'Button',
      example: false,
    },
    {
      dp: 9,
      key: 'countdown',
      label: 'Countdown',
      description: 'A countdown set in the maker’s app: when it runs out, the plug switches. Read, so a switch nobody pressed is explained.',
      value: { type: 'number', unit: 's', integer: true, min: 0 },
      quantity: 'duration',
      category: 'diagnostic',
      history: false,
      example: 0,
    },
  ],
  notes: 'Mapped on the owner’s plug behind an RSH GW018-DM gateway, Tuya 3.4 (README.md).',
};

export default defineTuyaSocket({
  id: 'tuya.zigbee-plug',
  meta: {
    name: 'Tuya Zigbee plug',
    brand: 'Tuya',
    models: ['Smart plug', 'TS011F'],
    description:
      'A 16 A Zigbee plug that measures power, paired with a Tuya Zigbee gateway in Smart Life: switched and read through the gateway on your home network, with no cloud.',
    support: 'experimental',
    supportNote: 'Mapped on one plug behind an RSH GW018-DM gateway; other Tuya Zigbee gateways speak the same way.',
  },
  profiles: [ZIGBEE_PLUG],
  reached: 'gateway',
  // Each read asks the gateway's memory and has the plug measure, over Zigbee: every 15 s, and every 2 s while an automation watches it.
  pollSeconds: 15,
});
