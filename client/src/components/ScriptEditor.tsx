import { YamlEditor } from './YamlEditor';
import type { ScriptEditorProps } from './ProblemList';

/**
 * A script's TypeScript (docs/PLAN-SCRIPTS.md §11.3) — on a phone's own app:
 * a text field, its problems listed under it by line, as YAML is there. The
 * web's is an editor of its own (`ScriptEditor.web.tsx`); the phone's comes
 * with its WebView (S2).
 */
export function ScriptEditor({ minLines = 16, types: _types, ...props }: ScriptEditorProps) {
  return <YamlEditor {...props} minLines={minLines} />;
}
