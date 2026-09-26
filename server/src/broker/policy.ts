import { commandRefusal } from '@kraftverk/protocol';

/**
 * Who may publish what on the broker.
 *
 * Anyone may connect: a station authenticates with credentials it fetched from
 * the Sydpower cloud, which we cannot predict. But **no one but the server may
 * command a station**, and not even the server may send the one frame that
 * destroys it.
 */

/**
 * Commands to a station travel on `<station>/client/request/<channel>`.
 *
 * The station subscribes there and executes whatever MODBUS frame arrives —
 * writes included. Observed on a P280 in BrightEMS's local-broker mode on
 * 2026-09-26: reads and writes both accepted on `<station>/client/request/data`.
 *
 * Matched wherever `client/request` appears as whole segments, not only in
 * second place: a leading slash or an extra level makes a different topic, and
 * a denylist should not be one spelling away from not applying. Broad costs
 * nothing here — stations only ever publish under `device/`.
 */
const COMMAND_TOPIC = /(?:^|\/)client\/request(?:\/|$)/i;

/**
 * Why a client may not publish `payload` to `topic`, or null if it may.
 *
 * The server guards its own writes three ways: the register whitelist, the
 * settings schema, and read-only mode. A broker that let any client publish to
 * a command topic would be a way around all three, open to every device on the
 * LAN — and writing 0 to holding register 68 permanently bricks a P280.
 *
 * A denylist, deliberately not an allowlist. aedes closes the connection of any
 * client whose publish it refuses, so an allowlist that missed a topic a station
 * legitimately uses would disconnect the station itself. Everything a station
 * says is on `<station>/device/...`; what is refused is the one direction that
 * carries commands *to* a station, and the broker's own `$` namespaces.
 *
 * Also consulted for last-will messages, which closes the obvious way round it:
 * connect with a will on the command topic, then drop the socket.
 *
 * The server passes the topic check but not the frame check. Its writes have
 * already been through the whitelist; this is the last point every frame to a
 * station passes, whatever built it — including the raw-MODBUS diagnostics
 * route, which exists to send frames the whitelist does not describe.
 */
export function refusalFor(topic: string, payload: Uint8Array, privileged: boolean): string | null {
  // aedes's default policy, kept: a client publishing into $SYS can DoS it.
  if (topic.startsWith('$SYS/')) return '$SYS topics are reserved for the broker';
  // Presence and the journal are the broker's word; a forged one would lie to the server.
  if (topic.startsWith('$kraftverk/')) return '$kraftverk topics are reserved for the broker';

  if (!COMMAND_TOPIC.test(topic)) return null;
  if (!privileged) return 'Only the kraftverk server may send commands to a station';
  return commandRefusal(payload);
}

/** Whether a topic carries commands to a station. */
export const isCommandTopic = (topic: string) => COMMAND_TOPIC.test(topic);

/** `<MAC>/device/response/[client/]<channel>`, where every station speaks. */
export const RESPONSE_TOPIC = /^([0-9A-Fa-f]{12})\/device\/response\/(?:client\/)?(\w+)$/;

/** `<MAC>/client/request/...`, which a station subscribes to. */
export const STATION_COMMAND_FILTER = /^([0-9A-Fa-f]{12})\/client\/request(?:\/|$)/;
