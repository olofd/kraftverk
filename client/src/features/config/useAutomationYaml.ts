import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { automationYaml, draftOfEntry, readAutomationText, type AutomationSettings } from '@kraftverk/api-client/config';
import { type AutomationView, type DeviceView } from '@kraftverk/api-client';
import type { RoleFills } from '@kraftverk/automation';
import type { Rule } from '@kraftverk/automation';
import { entryJsonSchema } from '@kraftverk/home-file';

import type { TextProblem } from '../../components/ProblemList';
import { useAnswer } from '../../components/useAnswer';
import { useHome } from '../../state/HomeProvider';

/** What the form edits: its name, rule, and what fills each role. */
type Draft = { name: string; rule: Rule } & RoleFills;

/**
 * An automation written as YAML instead of through the form (docs/CONFIG.md):
 * the form's draft written out when it is opened, and every change read back
 * — checked here, by the same code the server checks with — into the draft
 * and settings the form saves, as soon as it reads right. While it does not,
 * its problems say where, and the draft stays as it last read.
 */
export function useAutomationYaml({
  automationKey,
  madeFrom,
  madeFromFixed,
  devices,
  automations,
  onRead,
}: {
  /** Its key: where its problems are said to be. A new one has none yet. */
  automationKey: string;
  /** The recipe it was copied from. An automation that exists keeps it; a new one is made from what its YAML says. */
  madeFrom: string | null;
  madeFromFixed: boolean;
  devices: readonly DeviceView[];
  automations: readonly Pick<AutomationView, 'id' | 'key'>[];
  /** What it read: the draft and settings — and the key a whole file pasted in gives it, when it differs. */
  onRead: (read: { draft: Draft; settings: AutomationSettings; key: string | null; madeFrom: string | null }) => void;
}) {
  const { api } = useHome();
  // What a file may name here — the installed types, the keys of what you have — read once.
  const { value: vocabulary, error } = useAnswer(() => api.configuration.vocabulary(), [api], { failure: 'What a configuration may name could not be read' });
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<TextProblem[]>([]);
  /** Typed, and not read yet: nothing can be saved until it is. */
  const [reading, setReading] = useState(false);
  const read = useRef(onRead);
  read.current = onRead;

  /** The draft and its settings, written out: what the editor opens with. */
  const open = useCallback(
    (draft: Draft, settings: AutomationSettings) => {
      setText(automationYaml({ ...draft, madeFrom, ...settings }, devices, automations));
      setProblems([]);
      setReading(false);
    },
    [madeFrom, devices, automations]
  );

  const change = useCallback((next: string) => {
    setText(next);
    setReading(true);
  }, []);

  // Read a moment after each change: into the draft when it reads right, its problems placed where it does not.
  useEffect(() => {
    if (!reading || !vocabulary) return;
    const timer = setTimeout(() => {
      const result = readAutomationText(text, automationKey, vocabulary);
      const found: TextProblem[] = [...result.problems];
      if (madeFromFixed && result.entry && result.entry.madeFrom !== madeFrom) found.push({ message: madeFrom ? `"made from" says where it was copied from: ${madeFrom}. It does not change` : '"made from" says which recipe it was copied from: it was built from nothing', line: null, column: null });
      setProblems(found);
      setReading(false);
      if (result.entry && !found.length) read.current({ ...draftOfEntry(result.entry, devices, automations), key: result.key !== automationKey ? result.key : null, madeFrom: result.entry.madeFrom });
    }, 200);
    return () => clearTimeout(timer);
  }, [reading, text, vocabulary, automationKey, madeFrom, madeFromFixed, devices, automations]);

  const schema = useMemo(() => (vocabulary ? entryJsonSchema(vocabulary, 'automation') : null), [vocabulary]);
  return { text, change, open, problems, reading, ready: vocabulary !== null, error, schema };
}
