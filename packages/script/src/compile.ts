import type { ScriptProblem } from '@kraftverk/automation';
import { transform } from 'sucrase';

/*
  A script's TypeScript made JavaScript a sandbox runs (docs/PLAN-SCRIPTS.md
  §8.4): its types stripped and its imports made calls to `require`, by
  sucrase — plain JavaScript itself, so it compiles wherever a hub runs,
  Hermes too. Nothing is type-checked here: that is the editor's. Lines stay
  where they were, so a fault inside names the line as written.
*/

/** A script compiled: its JavaScript, and the names it imports. */
export type Compiled = { code: string; imports: readonly string[] };

/** What sucrase says of where it stopped: "(3:14)" at the end of its words, the column counted from 1. */
const AT = /\s*\((\d+):(\d+)\)$/;

export function compileScript(source: string): { compiled: Compiled } | { problem: ScriptProblem } {
  let code: string;
  try {
    code = transform(source, { transforms: ['typescript', 'imports'], disableESTransforms: true, production: true }).code;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const at = AT.exec(message);
    return { problem: { message: message.replace(AT, ''), line: at ? Number(at[1]) : null, column: at ? Number(at[2]) : null } };
  }
  const imports = [...new Set([...code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]!))];
  return { compiled: { code, imports } };
}
