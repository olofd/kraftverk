import {
  capabilityIn,
  checkValue,
  validateConfig,
  type DeviceDescription,
  type DeviceReader,
  type DeviceSession,
  type ToolSpec,
  type Value,
} from '@kraftverk/device-sdk';

/**
 * Running what a device declares as data, the same in every holder: a tool,
 * with its input checked against what it asks for and its answer against what
 * it says it answers; and a capability's query, answered in the type the
 * capability declares. A package whose answer drifts from its declaration is
 * refused here, saying where, rather than handing a screen, a bridge or an
 * automation something it was never promised.
 */

/** Why a tool did not answer, and so what to say: 404, 400, 423, 409 or 502 over HTTP. */
export type ToolRefusal = 'missing' | 'input' | 'read-only' | 'failed' | 'answer';

export class ToolRefused extends Error {
  constructor(
    readonly reason: ToolRefusal,
    message: string
  ) {
    super(message);
  }
}

export type ToolCall = {
  /** "Garage station", for the sentences. */
  deviceName: string;
  name: string;
  /** Its type's declaration, if it declares one by that name. */
  spec: ToolSpec | undefined;
  session: DeviceSession;
  /** As given: checked here against the tool's input. */
  input: unknown;
  /** Every hardware write is refused where it runs. */
  readOnly: boolean;
};

/** The tools a session can run: those its type declares and it implements. */
export const toolsOf = (declared: Readonly<Record<string, ToolSpec>> | undefined, session: DeviceSession | null): { name: string; spec: ToolSpec }[] =>
  Object.entries(declared ?? {})
    .filter(([name]) => typeof session?.tools?.[name] === 'function')
    .map(([name, spec]) => ({ name, spec }));

/** Runs a tool, holding it to its declaration both ways. Throws `ToolRefused`. */
export async function runTool(call: ToolCall): Promise<Value> {
  const run = call.session.tools?.[call.name];
  if (!call.spec || typeof run !== 'function') throw new ToolRefused('missing', `${call.deviceName} has no tool called "${call.name}"`);
  const input = validateConfig(call.spec.input ?? { fields: {} }, call.input ?? {});
  if (!input.ok) throw new ToolRefused('input', input.issues.map((issue) => issue.message).join('; '));
  if (call.spec.writes && !call.spec.honoursReadOnly && call.readOnly) throw new ToolRefused('read-only', 'Every write to hardware is refused: read-only');

  let answer: Value;
  try {
    answer = await run(input.value);
  } catch (error) {
    throw new ToolRefused('failed', (error as Error).message);
  }
  const checked = checkValue(call.spec.answer, answer);
  if (!checked.ok) throw new ToolRefused('answer', `${call.name} answered something it does not declare: its answer ${checked.problem}`);
  return checked.value;
}

/**
 * A device as whatever only reads may see it — an automation's function, a
 * bridge: its readings, its health, and its queries answered in the type each
 * capability declares. Nothing that acts.
 */
export function deviceReader(session: DeviceSession, description: () => DeviceDescription): DeviceReader {
  return {
    readings: () => session.readings(),
    health: () => session.health(),
    async query(request) {
      const declared = capabilityIn(description(), request.capability)?.queries[request.query];
      if (!declared) throw new Error(`${request.capability} has no query "${request.query}"`);
      if (!session.query) throw new Error('It answers no queries');
      for (const [name, type] of Object.entries(declared.args)) {
        const given = request.args[name];
        if (given === undefined || given === null) continue;
        const checked = checkValue(type, given);
        if (!checked.ok) throw new Error(`${request.capability}.${request.query}: ${name} ${checked.problem}`);
      }
      const answer = await session.query(request);
      const checked = checkValue(declared.answer, answer);
      if (!checked.ok) throw new Error(`It answered ${request.capability}.${request.query} with something else: its answer ${checked.problem}`);
      return checked.value;
    },
  };
}
