import { parseCommand } from './modbus.ts';

/**
 * The one rule no frame to a Sydpower station may break, whoever built it.
 *
 * Holding register 68 is the whole-machine sleep timer, and writing 0 to it
 * permanently bricks the station. It is a fact about the family, not about one
 * model — which is why it lives in the protocol and not beside a model's write
 * whitelist — and it is applied everywhere a frame can leave from: every link,
 * on the server and in the app, and the MQTT broker (docs/ARCHITECTURE.md §5).
 */

/** Holding register 68: whole-machine sleep, in minutes. */
export const SLEEP_REGISTER = 68;

/**
 * The only values register 68 may take.
 *
 * Corroborated by the vendor app itself: BrightEMS offers "Never" for the USB,
 * AC and DC standby timers — all of which accept 0 — but offers only
 * 5/10/30/480 minutes for the whole-machine timer. The one register where 0 is
 * documented as fatal is the one where the vendor removed the ability to pick it.
 */
export const SLEEP_VALUES = [5, 10, 30, 480] as const;

/**
 * Why these bytes must never reach a station, whoever built them — or null.
 *
 * A model's write whitelist guards writes its code *composes*. This guards
 * frames that are only *carried*: raw frames from a diagnostics tool, and
 * anything a broker is asked to forward. Those are arbitrary bytes, so a
 * whitelist cannot apply — raw frames exist to reach registers it does not
 * list — but one rule is absolute: register 68 is never set outside its
 * permitted values.
 *
 * Checked whatever the CRC says. A frame with a bad CRC is one the station
 * should drop; a guard that relied on that would be trusting the firmware to
 * protect the hardware from the firmware.
 *
 * And it fails closed. What passes is what this guard can show is safe: a read,
 * or a write it has read completely and that leaves 68 within its permitted
 * values. Everything else is refused — a function code it does not know, which
 * may well write (a vendor's own, say), and a known write it cannot read to the
 * end. Kraftverk sends only reads and single-register writes, so refusing the
 * rest costs it nothing; only a raw-frame tool loses the unknown.
 */
export function commandRefusal(frame: Uint8Array): string | null {
  const sleep = SLEEP_REGISTER;
  const command = parseCommand(frame);
  if (!command) return `Refused: ${frame.length} bytes is not a command this guard can read.`;

  switch (command.kind) {
    case 'read':
      return null;

    case 'write':
      if (command.register !== sleep) return null;
      if ((SLEEP_VALUES as readonly number[]).includes(command.value)) return null;
      return (
        `Refused: register ${sleep}: ${command.value} not allowed. Permitted: ${SLEEP_VALUES.join(', ')}. ` +
        `Register ${sleep} set to 0 permanently bricks the station.`
      );

    case 'writeMany':
    case 'readWriteMany':
      if (!command.wellFormed) {
        return 'Refused: a multi-register write whose register count, byte count and data disagree, so which registers it writes depends on the firmware.';
      }
      if (command.start <= sleep && sleep < command.start + command.count) {
        return `Refused: a multi-register write spanning register ${sleep}, which bricks the station if set to 0.`;
      }
      return null;

    case 'maskWrite':
      // Whatever the masks: the result depends on a value this guard cannot
      // see, and AND 0 / OR 0 is the brick write spelled differently.
      if (command.register === sleep) {
        return `Refused: a mask write to register ${sleep}, which bricks the station if it ends up 0.`;
      }
      if (command.and === null || command.or === null) return 'Refused: a mask write cut off before its masks.';
      return null;

    case 'other':
      return `Refused: function 0x${command.fn.toString(16).padStart(2, '0')} is not one this guard can check, and it may write.`;
  }
}
