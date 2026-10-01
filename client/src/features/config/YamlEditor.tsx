import { TextArea, YStack } from 'tamagui';

import { ProblemList, type YamlEditorProps } from './shared';

/**
 * A configuration's YAML, read or written (docs/CONFIG.md) — on a phone's
 * own app: a text field, its problems listed under it by line. The web's is
 * an editor of its own (`YamlEditor.web.tsx`): the schema completing and
 * explaining as it is typed, each problem marked where it is.
 */
export function YamlEditor({ value, onChange, problems = [], label, minLines = 8 }: YamlEditorProps) {
  return (
    <YStack gap="$2">
      <TextArea
        value={value}
        onChangeText={onChange}
        readOnly={onChange === undefined}
        aria-label={label}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        fontFamily="$mono"
        fontSize={13}
        lineHeight={19}
        minHeight={minLines * 19 + 24}
        backgroundColor="$background"
        borderColor={problems.length ? '$warning' : '$borderColor'}
        textAlignVertical="top"
      />
      <ProblemList problems={problems} />
    </YStack>
  );
}
