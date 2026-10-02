import { Text, XStack, YStack } from 'tamagui';

import { Icon } from '@kraftverk/ui';

import { useTone } from './tone';

/** A problem in a configuration's text: what, and where — its line and column, when it has them. */
export type TextProblem = { message: string; line: number | null; column: number | null };

export type YamlEditorProps = {
  value: string;
  /** Absent: read only. */
  onChange?: (text: string) => void;
  /** Its problems, placed: marked where they are, and listed under it. */
  problems?: readonly TextProblem[];
  /** The JSON Schema it is written against: what the web's editor completes and explains with. */
  schema?: object | null;
  /** What it is, said to a screen reader. */
  label: string;
  /** How tall it is at the least, in lines. */
  minLines?: number;
};

/** A connection's secrets as a person says them: "localKey" is "local key". */
export const secretWords = (fields: readonly string[]): string => fields.map((field) => field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()).join(', ');

/** "line 4: …", or the message alone. */
export const problemText = (problem: TextProblem): string => (problem.line ? `Line ${problem.line}${problem.column ? `, column ${problem.column}` : ''}: ${problem.message}` : problem.message);

/** Problems, each by its line, in the warning tone: under a text, or a plan. */
export function ProblemList({ problems }: { problems: readonly TextProblem[] }) {
  const tone = useTone();
  if (!problems.length) return null;
  return (
    <YStack gap="$1.5" role="alert">
      {problems.map((problem, index) => (
        <XStack key={`${index}:${problem.message}`} gap="$2" alignItems="flex-start">
          <YStack paddingTop={2}>
            <Icon name="alert-triangle" size={14} color={tone('$warning')} />
          </YStack>
          <Text flex={1} fontSize={13} color="$color" lineHeight={19}>
            {problemText(problem)}
          </Text>
        </XStack>
      ))}
    </YStack>
  );
}
