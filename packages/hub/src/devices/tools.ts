import { ApiError, type ToolBody } from '@kraftverk/api-contract';
import type { DeviceSession, Joining, ToolSpec, Value } from '@kraftverk/device-sdk';
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

/**
 * Lets devices join a bridge that devices join (a Zigbee coordinator) for a
 * while, or stops them: what can join the home changes, so it is run as a
 * tool that writes is — refused while read-only, on the timeline whether it
 * was done or refused. Answers until when devices may join.
 */
export async function joinBridge(asked: {
  device: { id: string; name: string };
  joining: Joining | null;
  seconds: number;
  readOnly: boolean;
  record: (kind: 'device.join' | 'device.join-refused', summary: string, detail: { seconds: number }) => void;
}): Promise<{ until: string | null }> {
  const { device, joining } = asked;
  if (!joining) throw new ApiError('not-found', `Nothing joins ${device.name}`);
  const seconds = Math.max(0, Math.min(joining.maxSeconds, Math.round(Number.isFinite(asked.seconds) ? asked.seconds : 0)));
  try {
    if (asked.readOnly) throw new ApiError('not-allowed', 'Every write to hardware is refused: this holder is read-only');
    const until = await joining.open(seconds);
    asked.record('device.join', seconds ? `Let devices join "${device.name}" for ${seconds} s` : `Stopped devices joining "${device.name}"`, { seconds });
    return { until };
  } catch (error) {
    asked.record('device.join-refused', `Letting devices join "${device.name}" was refused: ${(error as Error).message}`, { seconds });
    throw error;
  }
}
