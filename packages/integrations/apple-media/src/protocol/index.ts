import { heardAs, identityOf, type ConfigSchema, type ConfigValues, type Protocol, type SetupAction, type SetupActionResult, type Sighting } from '@kraftverk/device-sdk';

import { CompanionLink } from './companion.ts';
import { randomBytes } from './crypto.ts';
import { PairingRefused, PairSetup, readCredentials, writeCredentials } from './pairing.ts';

/**
 * How an Apple TV is spoken to over Companion — the protocol Apple's own
 * remote uses for power, apps, the remote's keys and media control — on
 * the home network: HomeKit's pairing once, with the PIN the TV shows
 * (pairing.ts), then every connection verified and sealed (frames.ts,
 * companion.ts) and a session begun with the TV's remote service
 * (session.ts). Pure: over the TCP channel the home network's transport
 * opened, with the noble libraries' cryptography — it runs in the app as
 * well as on a server.
 *
 * Ported from pyatv (MIT), the library behind Home Assistant's `apple_tv`
 * integration; NOTICE.
 */

export * from './companion.ts';
export * from './frames.ts';
export * from './opack.ts';
export * from './pairing.ts';
export * from './session.ts';
export * from './tlv8.ts';

/** The port Companion answers on when the TV has not said: it announces its own. */
export const COMPANION_PORT = 49153;

/** The name a pairing is made under: what the TV lists it as, in Settings › Remotes and Devices. */
export const PAIRED_AS = 'kraftverk';

/** How long a pairing started waits for its PIN: the TV shows it for as long as the connection is open. */
export const PAIRING_HELD_MS = 2 * 60_000;

/** An Apple device's permanent identity: its MAC, as AirPlay names it — the same whichever protocol found it. */
export const appleIdentity = (mac: string): string => identityOf('apple-media', mac.toLowerCase().replace(/[^0-9a-f]/g, ''));

/** The models, by the codes they announce. */
const MODELS: Readonly<Record<string, string>> = {
  'AppleTV5,3': 'Apple TV HD',
  'AppleTV6,2': 'Apple TV 4K',
  'AppleTV11,1': 'Apple TV 4K (2nd generation)',
  'AppleTV14,1': 'Apple TV 4K (3rd generation)',
};
export const modelName = (code: string): string => MODELS[code] ?? 'Apple TV';

/** A TXT value, its key in any case: mDNS's keys are not case-sensitive. */
const txtOf = (txt: Readonly<Record<string, string>>, key: string): string | undefined => {
  const lower = key.toLowerCase();
  return Object.entries(txt).find(([name]) => name.toLowerCase() === lower)?.[1];
};

/**
 * What a way to an Apple TV keeps: where Companion answers — found with it
 * — and what pairing left, sealed, made by pairing and never typed.
 */
export const CREDENTIALS: ConfigSchema = {
  help: 'The TV shows a PIN when pairing starts: type it here. Pairing is kept, and the TV lists it under Settings › Remotes and Devices, where it can be removed.',
  fields: {
    port: { type: 'number', title: 'Port', description: 'Where the TV answers. Found with it: change it only if it said otherwise.', default: COMPANION_PORT },
    credentials: { type: 'string', presentation: 'secret', kept: 'session', title: 'Paired' },
  },
};

/** The PIN, as it is asked for. */
const ASK_PIN: ConfigSchema = {
  help: 'The TV shows four digits now.',
  fields: { pin: { type: 'string', title: 'PIN', description: 'The four digits on the TV.', required: true } },
};

/** Pairings started, each waiting for its PIN on a connection kept open: by the token its next turn carries. */
const started = new Map<string, { link: CompanionLink; setup: PairSetup; reply: Uint8Array; timer: ReturnType<typeof setTimeout> }>();

const tokenOf = (): string => [...randomBytes(16)].map((each) => each.toString(16).padStart(2, '0')).join('');

/** Pairing, as a setup action: the TV shows a PIN, it is asked for in a turn of its own, and what pairing leaves is kept. */
const pair: SetupAction = {
  id: 'pair',
  label: 'Pair with the TV',
  description: 'The TV shows a PIN, which is asked for next. Once, for as long as the TV keeps the pairing.',
  async run(ctx, input: ConfigValues): Promise<SetupActionResult> {
    // A later turn: the PIN, on the connection the first turn left open.
    if (typeof input.pairing === 'string') {
      const held = started.get(input.pairing);
      if (!held) return { ok: false, detail: 'The pairing ended before the PIN came: pair again' };
      const pin = typeof input.pin === 'string' ? input.pin.replace(/\s/g, '') : '';
      if (!/^\d{4}$/.test(pin)) return { ok: false, detail: 'Type the four digits the TV shows', ask: { schema: ASK_PIN, carry: { pairing: input.pairing } } };
      started.delete(input.pairing);
      clearTimeout(held.timer);
      try {
        const credentials = await held.link.finishPairing(held.setup, held.reply, pin, PAIRED_AS);
        return { ok: true, detail: `Paired: the TV lists it as “${PAIRED_AS}”.`, suggestedConfig: { credentials: writeCredentials(credentials) } };
      } catch (error) {
        return { ok: false, detail: error instanceof PairingRefused ? error.message : `Pairing stopped: ${(error as Error).message}` };
      } finally {
        await held.link.close();
      }
    }
    // The first turn: a connection to the TV, kept open while it shows the PIN.
    if (!ctx.open) return { ok: false, detail: 'Choose the TV first' };
    const channel = await ctx.open();
    if (channel.kind !== 'bytes') {
      await channel.close();
      return { ok: false, detail: 'This way does not reach the TV over a connection of its own' };
    }
    const link = new CompanionLink(channel);
    const setup = new PairSetup();
    try {
      const reply = await link.startPairing(setup);
      const token = tokenOf();
      const timer = setTimeout(() => {
        started.delete(token);
        void link.close();
      }, PAIRING_HELD_MS);
      started.set(token, { link, setup, reply, timer });
      return { ok: true, detail: 'The TV shows a PIN', ask: { schema: ASK_PIN, carry: { pairing: token } } };
    } catch (error) {
      await link.close();
      return { ok: false, detail: error instanceof PairingRefused ? error.message : `The TV did not start pairing: ${(error as Error).message}` };
    }
  },
};

/** What pairing left, read from a connection's secret; null when it has not paired. */
export const pairedWith = readCredentials;

/** An address typed by hand: an IPv4 address, or a local name. */
const parseAddress = (input: string): string | null => {
  const text = input.trim().toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text) && text.split('.').every((part) => Number(part) <= 255)) return text;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/.test(text) ? text : null;
};

const protocol: Protocol = {
  id: 'apple-media-companion',
  label: 'Companion',
  bindings: {
    lan: {
      open: (_address, config) => ({ port: typeof config?.port === 'number' && config.port > 0 ? config.port : COMPANION_PORT }),
      // What an Apple TV announces: Companion, its model in TXT, and — over AirPlay, the same host — its MAC.
      recognise(sighting: Sighting) {
        const companion = heardAs(sighting, 'mdns').find((said) => said.service === '_companion-link._tcp');
        const model = companion ? txtOf(companion.txt, 'rpMd') : undefined;
        if (!companion || !model?.startsWith('AppleTV')) return null;
        const mac = heardAs(sighting, 'mdns')
          .filter((said) => said.service === '_airplay._tcp')
          .map((said) => txtOf(said.txt, 'deviceid'))
          .find((id): id is string => !!id && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(id));
        return {
          name: companion.instance || modelName(model),
          ...(mac ? { identity: appleIdentity(mac) } : {}),
          model: modelName(model),
          detail: `${sighting.address} · ${modelName(model)}`,
          config: { port: companion.port },
        };
      },
      instructions: {
        title: 'Get it ready',
        body: 'Turn the TV on, and have it on the same network. When pairing starts it shows a PIN on the screen: have the remote nearby to dismiss it if you stop.',
      },
      parseAddress,
      addressLabel: 'IP address',
    },
  },
  credentials: { schema: CREDENTIALS, actions: [pair], title: 'Pair with the TV' },
};

export default protocol;
