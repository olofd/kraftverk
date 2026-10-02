import { ApiError, type ToolBody } from '@kraftverk/api-contract';
import type { DeviceSession, ToolSpec, Value } from '@kraftverk/device-sdk';
import { subjectOf, type Confirmations } from '@kraftverk/gateway';
import { runTool } from '@kraftverk/holder';

/** A tool asked of a device this node holds: what it is, who asked, and what the node it runs on keeps. */
export type AskedTool = {
  device: { id: string; name: string };
  name: string;
  spec: ToolSpec;
  session: DeviceSession;
  body: ToolBody & { reading?: boolean };
  /** Who asked: what a yes is bound to, and the timeline says. */
  by: string;
  /** Where a yes to one that cannot be undone is asked, and its token accepted. */
  confirmations: Confirmations;
  /** Every write to hardware refused where it runs, and this device not simulated. */
  readOnly: boolean;
  /** Where the timeline is: the home's own, or owed to the master. */
  record: (kind: 'device.tool' | 'device.tool-refused', summary: string, detail: { tool: string; input: Record<string, Value> }) => void;
};

/**
 * Runs a tool a person — or an assistant for one — asked of a device this
 * node holds, the same on the master and on a node following it: held to
 * its declaration both ways (`runTool`). One that writes is never run as a
 * reading, is refused while read-only, and is on the timeline — refused too,
 * since an attempt at a write that can harm the device is what the timeline
 * is for. One that says what it cannot undo waits for a person's yes, bound
 * to this device, tool, input and person.
 */
export async function runAskedTool(asked: AskedTool): Promise<unknown> {
  const { device, name, spec, body } = asked;
  if (body.reading && spec.writes) throw new ApiError('not-allowed', `${name} changes the device: send it as a write`);
  const input = body.input ?? {};
  if (spec.writes && spec.confirm) {
    const subject = subjectOf({ device: device.id, tool: name, input, by: asked.by });
    if (!asked.confirmations.accept(body.confirmation, subject)) throw new ApiError('needs-yes', spec.confirm, { needsConfirmation: asked.confirmations.ask(subject) });
  }
  try {
    const answer = await runTool({ deviceName: device.name, name, spec, session: asked.session, input, readOnly: asked.readOnly });
    if (spec.writes) asked.record('device.tool', `Ran ${spec.label.toLowerCase()} on "${device.name}"`, { tool: name, input });
    return answer;
  } catch (error) {
    if (spec.writes) asked.record('device.tool-refused', `${spec.label} on "${device.name}" was refused: ${(error as Error).message}`, { tool: name, input });
    throw error;
  }
}
