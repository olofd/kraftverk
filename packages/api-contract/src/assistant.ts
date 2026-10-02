import type { CapabilityId, ConfigSchema, ConnectionHealth, LinkKind, SavedDeviceId, Value } from '@kraftverk/device-sdk';

/*
  What an assistant is told of a home (docs/ARCHITECTURE.md, the assistant):
  the house as it stands, the words a rule may use, and a rule rehearsed
  against its history.
*/

/** One value a part reports, as the world snapshot says it: what it means, what it is, and whether it is current. */
export type WorldValue = {
  key: string;
  label: string;
  /** Its meaning in the shared vocabulary, or a type's own: `battery.soc`. */
  means: string | null;
  value: Value;
  unit: string | null;
  /** Seconds since the device observed it; null when it has never said. */
  age: number | null;
  /** Still current for its attribute: a stale value is known, but not to be acted on. */
  current: boolean;
};

export type WorldPart = { id: string; label: string; kind: string; capabilities: CapabilityId[]; values: WorldValue[] };

export type WorldDevice = {
  id: SavedDeviceId;
  name: string;
  type: string;
  kind: 'hardware' | 'service';
  status: ConnectionHealth['status'];
  detail: string;
  parts: WorldPart[];
  /** Facts about the house from this device's parts: "outlet.ac feeds Cabin station input.ac". */
  links: { kind: LinkKind; part: string; role: 'source' | 'target'; device: SavedDeviceId; name: string; otherPart: string }[];
};

/**
 * `GET /world`: the house as a model reads it — every device, its parts and
 * what each offers and reports, with freshness, and the links between them.
 * Typed and small, in a stable order. `?format=text` is the same, a few lines
 * a device, for a context window.
 */
export type WorldView = {
  at: string;
  /** Every write is refused: the master is read-only. */
  readOnly: boolean;
  /** What an assistant may do, in a sentence per rule: what the gateway will hold it to. */
  rules: string[];
  devices: WorldDevice[];
};

/**
 * `GET /vocabulary`: the words the world is said in — capabilities with their
 * commands, queries and what makes a command consequential; meanings with
 * their units; link kinds; the recipes an automation can be made from, and
 * the values the home has set.
 */
export type VocabularyView = {
  capabilities: Record<string, { label: string; attributes: Record<string, string>; commands: Record<string, { description: string; args: Record<string, unknown>; consequential: unknown }>; queries: Record<string, { description: string; args: Record<string, unknown> }> }>;
  meanings: Record<string, { label: string; type: 'number' | 'boolean'; unit: string | null }>;
  links: Record<string, { verb: string; from: string; to: string; description: string }>;
  recipes: { id: string; label: string; description: string; roles: Record<string, { label: string; capabilities: readonly string[]; oneOf?: readonly string[] } | { label: string; automation: true }>; params: ConfigSchema }[];
  policy: Record<string, { label: string; value: number; unit: string }>;
};

/** What rehearsing a rule on what happened found: when it would have run, and what it would have done. */
export type Rehearsal = {
  from: string;
  to: string;
  /** Oldest first. */
  runs: { at: string; outcome: 'would-act' | 'idle' | 'unknown'; summary: string }[];
  /** What the rehearsal could not see: a function history does not keep, a device with no history. */
  caveats: string[];
};
