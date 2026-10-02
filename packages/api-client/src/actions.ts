import { ApiError, type KraftverkApi } from '@kraftverk/api-contract';

import { withConfirmation, type Ask, type ConfirmTone } from './confirm';
import type { DeviceActions } from './screens';
import type { DeviceView } from './types';

/*
  What a device's screens can do, through whoever holds it (`DeviceActions`):
  each sent through the home, which sends it on to the node that holds the
  device, and a person asked when the gateway wants their yes. Pure but for
  the asking, which the platform hands in.
*/

/** Who holds a device's connection in use: the home's master, this node for it, another node, or nobody right now. */
export type InUseBy = 'master' | 'this-node' | 'other-node' | 'none';

export function holderOf(device: Pick<DeviceView, 'connections'>): InUseBy {
  const inUse = device.connections.find((connection) => connection.inUse);
  if (inUse?.heldBy.kind === 'this-node') return 'this-node';
  if (inUse?.heldBy.kind === 'node') return 'other-node';
  if (device.connections.some((connection) => connection.heldBy.kind === 'master')) return 'master';
  return 'none';
}

/** The longest a write is held for its dwell: a person's is two seconds. */
const MAX_SETTLE_MS = 10_000;

/**
 * A write, answered once the setting may be written again: the gateway
 * refuses a second write to it within its dwell, so the control that wrote it
 * stays busy that long rather than let the next nudge be refused.
 */
export async function settled<R extends { settlingMs?: number }>(result: R): Promise<R> {
  if (result.settlingMs) await new Promise((resolve) => setTimeout(resolve, Math.min(result.settlingMs!, MAX_SETTLE_MS)));
  return result;
}

/**
 * A device's actions, sent through the home to whoever holds it. A command
 * or a write the gateway wants a yes for is asked — as dangerous when it
 * touches a setting its device declares so — and sent again with it; a tool
 * that cannot be undone, the same. Held by nobody now, each says why not.
 */
export function deviceActions(api: KraftverkApi, device: DeviceView, ask: Ask): DeviceActions {
  const holder = holderOf(device);
  if (holder !== 'master' && holder !== 'this-node') {
    const why = async (): Promise<never> => {
      throw new Error(device.health.detail);
    };
    return {
      tool: why,
      write: async () => ({ outcome: 'refused', detail: device.health.detail }),
      command: async () => ({ outcome: 'refused', detail: device.health.detail }),
      diagnostic: null,
    };
  }

  /** A write is dangerous when it touches a setting its device declares so: one that can harm the hardware. */
  const toneOf = (patch: Record<string, unknown>): ConfirmTone => (device.description.attributes.some((attribute) => attribute.dangerous && attribute.key in patch) ? 'dangerous' : 'careful');
  /** Sent, and when the gateway wants a person's yes, asked for it; declined, it says so. */
  const confirmed = async <R extends { detail: string; needsConfirmation?: string; reason?: string }>(send: (confirmation?: string) => Promise<R>, tone: ConfirmTone = 'careful'): Promise<R> => {
    const { answer, declined } = await withConfirmation(send, (reason) => ({ title: 'Confirm', message: reason, yes: 'Do it', tone }), ask);
    return declined ? { ...answer, detail: 'Not confirmed', needsConfirmation: undefined } : answer;
  };
  const inUse = device.connections.find((connection) => connection.inUse) ?? device.connections.find((connection) => connection.heldBy.kind === 'master');

  return {
    tool: async <T>(name: string, input?: Record<string, unknown>) => {
      const spec = device.tools.find((tool) => tool.name === name);
      const label = spec?.label ?? name;
      // The home asks, for a tool that cannot be undone: its question, with a token for the yes.
      const run = async (confirmation?: string): Promise<{ answer: T } | { needsConfirmation: string; reason: string }> => {
        try {
          return { answer: (await api.devices.tool(device.id, name, { input: input as never, reading: !spec?.writes, ...(confirmation ? { confirmation } : {}) })) as T };
        } catch (error) {
          if (error instanceof ApiError && error.kind === 'needs-yes' && error.needsConfirmation) return { needsConfirmation: error.needsConfirmation, reason: error.message };
          throw error;
        }
      };
      const { answer, declined } = await withConfirmation(run, (reason) => ({ title: `${label}?`, message: reason, yes: label, tone: 'dangerous' }), ask);
      if (declined || !('answer' in answer)) throw new Error('Not confirmed');
      return answer.answer;
    },
    write: (patch) => confirmed((confirmation) => api.devices.write(device.id, { patch: patch as never, ...(confirmation ? { confirmation } : {}) }), toneOf(patch)).then(settled),
    command: (input) =>
      confirmed((confirmation) => api.devices.command(device.id, input.part, input.capability, input.command, { args: input.args, ...(input.reason ? { reason: input.reason } : {}), ...(confirmation ? { confirmation } : {}) })),
    // A transport's diagnostics are the master's: a node holding for it has none to show here.
    diagnostic:
      inUse && holder === 'master'
        ? <T>(name: string, query?: Record<string, string | number>) => api.transports.diagnostic(inUse.transport, name, Object.fromEntries(Object.entries(query ?? {}).map(([key, value]) => [key, String(value)]))) as Promise<T>
        : null,
  };
}
