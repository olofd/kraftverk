import { useEffect, useMemo, useRef } from 'react';
import { closeBrackets } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, tooltips } from '@codemirror/view';
import { useTheme, YStack } from 'tamagui';

import { ProblemList, type ScriptEditorProps } from './ProblemList';
import { diagnosticsOf, editableAs, lookOf } from './YamlEditor.web';

/**
 * A script's TypeScript, written in the browser (docs/PLAN-SCRIPTS.md
 * §11.3): CodeMirror with the YAML editor's look, its problems — the hub's,
 * from reading it — marked where they are and listed under it. Its types
 * coloured, completed and checked come with the editor's language service
 * (B4); until then it is text with lines.
 */
export function ScriptEditor({ value, onChange, problems = [], label, minLines = 16 }: ScriptEditorProps) {
  const theme = useTheme();
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const editable = useMemo(() => new Compartment(), []);
  const looks = useMemo(() => new Compartment(), []);
  const readOnly = !onChange;

  const colors = {
    background: theme.background?.val as string,
    card: (theme.card?.val ?? theme.background?.val) as string,
    color: theme.color?.val as string,
    muted: theme.muted?.val as string,
    border: theme.borderColor?.val as string,
    accent: theme.accent?.val as string,
    warning: theme.warning?.val as string,
    success: theme.success?.val as string,
    danger: theme.danger?.val as string,
  };
  const look = useMemo(() => lookOf(colors), [colors.background, colors.card, colors.color, colors.muted, colors.border, colors.accent, colors.warning, colors.success, colors.danger]);

  // Made once; what changes after is dispatched into it.
  useEffect(() => {
    if (!host.current) return;
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          EditorState.tabSize.of(2),
          indentUnit.of('  '),
          EditorView.lineWrapping,
          tooltips({ position: 'fixed', parent: document.body }),
          lintGutter(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
          editable.of(editableAs(readOnly)),
          looks.of(look),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, []);

  // A value given from outside replaces what is there.
  useEffect(() => {
    const current = view.current;
    if (current && current.state.doc.toString() !== value) current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.reconfigure(editableAs(readOnly)) });
  }, [readOnly, editable]);

  useEffect(() => {
    view.current?.dispatch({ effects: looks.reconfigure(look) });
  }, [look, looks]);

  useEffect(() => {
    const current = view.current;
    if (current) current.dispatch(setDiagnostics(current.state, diagnosticsOf(current.state, problems)));
  }, [problems]);

  return (
    <YStack gap="$2">
      <YStack borderWidth={1} borderColor={problems.length ? '$warning' : '$borderColor'} borderRadius="$4" overflow="hidden">
        <div ref={host} style={{ minHeight: minLines * 20 + 16, maxHeight: '70vh', overflow: 'auto', display: 'flex', flexDirection: 'column' }} />
      </YStack>
      <ProblemList problems={problems} />
    </YStack>
  );
}
