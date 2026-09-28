import { HOLDING_NAMES, INPUT_NAMES, WRITABLE, type WriteRule } from './registers.ts';

/**
 * The register dump behind the Protocol screen, and the diff that makes it
 * evidence rather than a list of numbers.
 *
 * Snapshot a baseline, change one thing on the station, dump again: whatever
 * moved is the register behind that control. Everything in
 * `docs/P280-FINDINGS.md` was found this way.
 *
 * It lives in the shared package because the workflow has to be identical
 * whether the app is asking the server for the dump or reading the registers
 * over Bluetooth itself. A register that reads `changed` on one link and not
 * the other would quietly ruin the evidence.
 */

export type RegisterRow = {
  register: number;
  /** The documented name, when the register has one. */
  name: string | null;
  raw: number;
  hex: string;
  asTenths: number;
  /** What may be written here, or null for read-only banks and unknown registers. */
  writable: WriteRule | null;
  previous: number | null;
  /** Differs from the snapshot baseline. */
  changed: boolean;
};

export type RegisterDump = {
  mac: string | null;
  readOnly: boolean;
  baselineAt: string | null;
  input: RegisterRow[];
  holding: RegisterRow[];
};

/** A raw register bank, annotated and diffed against a baseline. */
export function describeRegisters(
  values: readonly number[],
  bank: 'input' | 'holding',
  before?: readonly number[]
): RegisterRow[] {
  const names = bank === 'input' ? INPUT_NAMES : HOLDING_NAMES;

  return values.map((raw, register) => {
    const previous = before?.[register];
    return {
      register,
      name: names[register] ?? null,
      raw,
      hex: raw.toString(16).padStart(4, '0'),
      asTenths: raw / 10,
      // Input registers are telemetry: nothing there is ever writable.
      writable: bank === 'holding' ? (WRITABLE[register] ?? null) : null,
      previous: previous ?? null,
      changed: previous !== undefined && previous !== raw,
    };
  });
}
