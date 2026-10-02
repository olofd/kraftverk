import type { CapabilityName, CapabilityNeed, DeviceReader, QueryAnswer, QueryName, Value, ValueType } from '@kraftverk/device-sdk';

/*
  What a package brings a rule beside its device's words: functions over
  the part filling a role, asked of the device through its reader — never
  reaching it any other way — and answering a value with why.
*/

/** A value, and in words why it is what it is. */
export type Evaluation = { value: Value; detail: string | null };

/** The part filling a role, as a function sees it. */
export type RulePart = {
  /** "Heater plug", or "Garage station — AC outlets". */
  name: string;
  part: string;
  /** Null when there is nothing to ask: it is offline, or held by an app. */
  device: DeviceReader | null;
  /** Why it cannot answer, when it cannot. */
  offline: string;
};

/**
 * Asks the part filling a role one of a library capability's queries, and
 * answers in the type the capability declares — checked by the reader, so a function reads
 * a forecast as a forecast, with no cast. Throws, saying why, when the part
 * cannot answer or answers something else.
 */
export async function ask<Name extends CapabilityName, Query extends QueryName<Name>>(
  part: RulePart,
  capability: Name,
  query: Query,
  args: Readonly<Record<string, Value>>
): Promise<QueryAnswer<Name, Query>> {
  if (!part.device) throw new Error(`${part.name} is not answering: ${part.offline}`);
  // The reader checks the answer against the declaration the type is derived from: once, there.
  return (await part.device.query({ part: part.part, capability, query, args })) as QueryAnswer<Name, Query>;
}

export type FunctionContext = {
  part: RulePart;
  args: Readonly<Record<string, Value>>;
  now: Date;
  /** The automation's clock: "Europe/Stockholm". */
  timeZone: string;
};

/**
 * A computation a package contributes, for what comparing readings cannot
 * say: whether tomorrow looks sunny. Generic over the capability it needs, not
 * over the package's own device — any part that offers it will do. The only
 * place an automation runs a package's code; it answers, it never acts.
 */
export type AutomationFunction = {
  /** Namespaced by the type: `acme.weather.skyLooks`. */
  id: string;
  label: string;
  description: string;
  /** What the part it is asked about must offer. */
  needs: CapabilityNeed;
  args: Readonly<Record<string, ValueType>>;
  returns: ValueType;
  /** Its answer, or null when it cannot tell — with why, either way. */
  evaluate(ctx: FunctionContext): Promise<Evaluation>;
};

export const defineFunction = (fn: AutomationFunction): AutomationFunction => fn;
