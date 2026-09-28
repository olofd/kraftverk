import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { MessageBrokerPolicy, Protocol } from '@kraftverk/device-sdk';

/**
 * Who may publish what on the broker.
 *
 * Anyone may connect: a station connects with no username and no password, so
 * there is nothing to check a device by. But **no one but the server may
 * command a device**, and not even the server may send a command its protocol
 * says must never be delivered — writing 0 to a Sydpower station's register 68
 * destroys it.
 *
 * The broker knows no protocol itself. Which topics carry commands, to which
 * device, and which commands are refused, come from each installed protocol's
 * MQTT binding (`MessageBrokerPolicy`), found at start-up. A broker that finds
 * none refuses to start: a broker that forwarded commands without knowing what
 * they are would be the one way around every guard (see `loadPolicies`).
 */

export type Policies = readonly MessageBrokerPolicy[];

/** The policy that claims a topic as a command, and the device it addresses. */
export function commandOf(policies: Policies, topic: string): { policy: MessageBrokerPolicy; address: string } | null {
  for (const policy of policies) {
    const address = policy.commandFor(topic);
    if (address !== null) return { policy, address };
  }
  return null;
}

/** The policy that claims a published topic as a device's own, and which device. */
export function deviceOf(
  policies: Policies,
  topic: string
): { policy: MessageBrokerPolicy; address: string; channel: string } | null {
  for (const policy of policies) {
    const found = policy.fromDevice(topic);
    if (found) return { policy, ...found };
  }
  return null;
}

/**
 * Why a client may not publish `payload` to `topic`, or null if it may.
 *
 * The server guards its own writes several ways before they leave it; a broker
 * that let any client publish to a command topic would be a way around all of
 * them, open to every device on the LAN.
 *
 * A denylist, deliberately not an allowlist. aedes closes the connection of any
 * client whose publish it refuses, so an allowlist that missed a topic a device
 * legitimately uses would disconnect the device itself. What is refused is the
 * one direction that carries commands *to* a device, and the broker's own `$`
 * namespaces.
 *
 * Also consulted for last-will messages, which closes the obvious way round it:
 * connect with a will on a command topic, then drop the socket.
 *
 * The server passes the command check but not the protocol's own. Its writes
 * have already been through their guards; this is the last point every command
 * passes, whatever built it — including a raw-frame tool, which exists to send
 * frames a model's whitelist does not describe.
 */
export function refusalFor(policies: Policies, topic: string, payload: Uint8Array, privileged: boolean): string | null {
  // aedes's default policy, kept: a client publishing into $SYS can DoS it.
  if (topic.startsWith('$SYS/')) return '$SYS topics are reserved for the broker';
  // Presence and the journal are the broker's word; a forged one would lie to the server.
  if (topic.startsWith('$kraftverk/')) return '$kraftverk topics are reserved for the broker';

  const command = commandOf(policies, topic);
  if (!command) return null;
  if (!privileged) return 'Only the kraftverk server may send commands to a device';
  return command.policy.refuse(payload);
}

/** Whether a topic carries commands to a device, by any installed protocol. */
export const isCommandTopic = (policies: Policies, topic: string): boolean => commandOf(policies, topic) !== null;

/** Where the protocol packages are, from this file: packages/transports/mqtt/src/broker. */
export const PROTOCOLS_DIR = resolve(import.meta.dirname, '../../../../protocols');

/**
 * Finds every installed protocol and the broker policy of its MQTT binding.
 *
 * Found rather than listed, like device types: a protocol is a package that
 * says `"kraftverk": { "protocol": "./src/index.ts" }`. Throws when none is
 * found, so a broker never runs without knowing what a command is.
 */
export async function loadPolicies(dir: string = process.env.KRAFTVERK_PROTOCOLS_DIR || PROTOCOLS_DIR): Promise<MessageBrokerPolicy[]> {
  const policies: MessageBrokerPolicy[] = [];
  const problems: string[] = [];
  let entries: string[] = [];
  try {
    entries = (await readdir(dir)).sort();
  } catch (error) {
    problems.push(`${dir} could not be read: ${(error as Error).message}`);
  }

  for (const entry of entries) {
    try {
      const manifest = JSON.parse(await readFile(resolve(dir, entry, 'package.json'), 'utf8')) as {
        kraftverk?: { protocol?: string };
      };
      const path = manifest.kraftverk?.protocol;
      if (!path) continue;
      const loaded = (await import(pathToFileURL(resolve(dir, entry, path)).href)) as { default?: Protocol };
      const policy = loaded.default?.bindings.mqtt?.broker;
      if (policy) policies.push(policy);
    } catch (error) {
      problems.push(`${entry}: ${(error as Error).message}`);
    }
  }

  /*
    All or nothing. A protocol that failed to load is one whose commands the
    broker would forward unrecognised — and unguarded — so one failure is as
    good a reason not to start as none found at all.
  */
  if (problems.length) {
    throw new Error(`A protocol could not be loaded, so the broker will not start: ${problems.join('; ')}`);
  }
  if (!policies.length) {
    throw new Error(
      `No protocol with an MQTT binding was found in ${dir}. ` +
        'The broker will not run without one: it would not know which messages are commands, or which to refuse.'
    );
  }
  return policies;
}
