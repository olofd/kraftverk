import { heardAs, identityOf, type ConfigSchema, type ConfigValues, type Protocol, type SetupAction, type SetupActionResult, type Sighting } from '@kraftverk/device-sdk';

import { CompanionLink } from './companion.ts';
import { idText, PairingRefused, PairSetup, readCredentials, writeCredentials, type Credentials } from './pairing.ts';

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

/**
 * An Apple TV's permanent identity: the pairing id it answers pair-verify
 * with — learnt once paired, so what it announces carries none.
 */
export const appleIdentity = (credentials: Credentials): string => identityOf('apple-media', idText(credentials.tvId).toLowerCase());

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
  fields: { pin: { type: 'string', presentation: 'code', length: 4, title: 'PIN', description: 'The four digits on the TV.', required: true } },
};

/** A pairing started, waiting for its PIN on a connection kept open: held by the setup between its turns. */
type Started = { link: CompanionLink; setup: PairSetup; reply: Uint8Array };

/** Pairing, as a setup action: the TV shows a PIN, it is asked for in a turn of its own, and what pairing leaves is kept. */
const pair: SetupAction = {
  id: 'pair',
  label: 'Pair with the TV',
  description: 'The TV shows a PIN, which is asked for next. Once, for as long as the TV keeps the pairing.',
  async run(ctx, input: ConfigValues): Promise<SetupActionResult> {
    // A later turn: the PIN, on the connection the first turn left open.
    if (typeof input.pairing === 'string') {
      const held = ctx.held.take<Started>(input.pairing);
      if (!held) return { ok: false, detail: 'The pairing ended before the PIN came: pair again' };
      const pin = typeof input.pin === 'string' ? input.pin.replace(/\s/g, '') : '';
      if (!/^\d{4}$/.test(pin)) {
        const again = ctx.held.keep(held, { ttlMs: PAIRING_HELD_MS, close: () => held.link.close() });
        return { ok: false, detail: 'Type the four digits the TV shows', ask: { schema: ASK_PIN, carry: { pairing: again } } };
      }
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
      const started: Started = { link, setup, reply };
      const token = ctx.held.keep(started, { ttlMs: PAIRING_HELD_MS, close: () => link.close() });
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
      // What a device speaking Companion announces: the service, on its port, its model code in TXT. Which models a
      // type is for, its way's matcher says: a Mac and an iPhone announce it too.
      recognise(sighting: Sighting) {
        const companion = heardAs(sighting, 'mdns').find((said) => said.service === '_companion-link._tcp');
        const model = companion ? txtOf(companion.txt, 'rpMd') : undefined;
        if (!companion || !model) return null;
        return {
          name: companion.instance || model,
          model,
          detail: `${sighting.address} · ${model}`,
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
