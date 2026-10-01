import { useEffect, useMemo, useRef } from 'react';
import { autocompletion, closeBrackets, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { yaml, yamlLanguage } from '@codemirror/lang-yaml';
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, hoverTooltip, keymap, lineNumbers, tooltips } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { stateExtensions, updateSchema } from 'codemirror-json-schema';
import { yamlCompletion, yamlSchemaHover } from 'codemirror-json-schema/yaml';
import { useTheme, YStack } from 'tamagui';

import { ProblemList, type TextProblem, type YamlEditorProps } from './shared';

/**
 * A configuration's YAML, read or written, in the browser (docs/CONFIG.md):
 * CodeMirror with its YAML language, and the JSON Schema it is written
 * against completing keys and values and explaining them on hover
 * (`codemirror-json-schema`). Its problems — found by the same code the
 * server checks with, placed by line and column — are marked where they are
 * and listed under it, so they are read without a pointer too.
 */
export function YamlEditor({ value, onChange, problems = [], schema = null, label, minLines = 8 }: YamlEditorProps) {
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
          // Long lines wrap, indented as they began: a phone is narrow, and a line scrolled sideways hides its end.
          EditorView.lineWrapping,
          indentUnit.of('  '),
          yaml(),
          stateExtensions(schema ?? undefined),
          yamlLanguage.data.of({ autocomplete: yamlCompletion() }),
          autocompletion(),
          // Above the page, not inside the editor's scrolling box: a completion near its edge is not cut off.
          tooltips({ position: 'fixed', parent: document.body }),
          hoverTooltip(yamlSchemaHover()),
          lintGutter(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A value given from outside — a file opened, the form's draft written again — replaces what is there.
  useEffect(() => {
    const current = view.current;
    if (current && current.state.doc.toString() !== value) current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    if (view.current) updateSchema(view.current, schema ?? undefined);
  }, [schema]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.reconfigure(editableAs(readOnly)) });
  }, [readOnly, editable]);

  useEffect(() => {
    view.current?.dispatch({ effects: looks.reconfigure(look) });
  }, [look, looks]);

  // Each problem marked where it is: its line and column, or its line's start.
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

const editableAs = (readOnly: boolean): Extension => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];

/** Problems as the editor marks them: at their line and column, kept inside the text as it is now. */
function diagnosticsOf(state: EditorState, problems: readonly TextProblem[]): Diagnostic[] {
  return problems.flatMap((problem) => {
    if (!problem.line || problem.line > state.doc.lines) return [];
    const line = state.doc.line(problem.line);
    const from = Math.min(line.from + Math.max(0, (problem.column ?? 1) - 1), line.to);
    // The word it is at, or the rest of its line.
    const word = /^[^\s:,]+/.exec(state.doc.sliceString(from, line.to))?.[0].length ?? 0;
    return [{ from, to: Math.max(from, Math.min(line.to, from + (word || line.to - from))), severity: 'warning' as const, message: problem.message }];
  });
}

type Colors = { background: string; card: string; color: string; muted: string; border: string; accent: string; warning: string; success: string; danger: string };

/** The app's own colours, light or dark, on the editor and its highlighting. */
function lookOf(colors: Colors): Extension {
  const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
  return [
    EditorView.theme({
      '&': { backgroundColor: colors.background, color: colors.color, fontSize: '13px', flex: '1' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: mono, lineHeight: '20px' },
      '.cm-content': { caretColor: colors.accent, padding: '8px 0' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: colors.accent },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: `${colors.accent}55` },
      '.cm-activeLine': { backgroundColor: `${colors.muted}14` },
      '.cm-gutters': { backgroundColor: colors.card, color: colors.muted, borderRight: `1px solid ${colors.border}` },
      '.cm-activeLineGutter': { backgroundColor: `${colors.muted}22`, color: colors.color },
      '.cm-tooltip': { backgroundColor: colors.card, color: colors.color, border: `1px solid ${colors.border}`, borderRadius: '8px', maxWidth: '420px' },
      '.cm-tooltip-hover, .cm-tooltip-lint': { padding: '6px 10px', fontSize: '13px', lineHeight: '19px' },
      '.cm-tooltip code': { fontFamily: mono, fontSize: '12px' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: `${colors.accent}33`, color: colors.color },
      '.cm-completionDetail': { color: colors.muted },
      '.cm-diagnostic-warning': { borderLeft: `3px solid ${colors.warning}` },
      '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: `underline wavy ${colors.warning}`, textUnderlineOffset: '3px' },
    }),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: colors.accent },
        { tag: [tags.string, tags.special(tags.string)], color: colors.color },
        { tag: [tags.number, tags.bool, tags.null], color: colors.success },
        { tag: [tags.comment, tags.lineComment], color: colors.muted, fontStyle: 'italic' },
        { tag: [tags.typeName, tags.labelName, tags.meta], color: colors.warning },
        { tag: [tags.punctuation, tags.separator, tags.squareBracket, tags.brace], color: colors.muted },
      ])
    ),
  ];
}
