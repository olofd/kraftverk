import { Text, XStack, YStack } from 'tamagui';

/**
 * Where you are in setting it up: "Step 2 of 5", and a bar of as many segments.
 * Done ones are filled, and a tap on one goes back to it with everything kept;
 * the step's own title is the heading below, so it is not said twice.
 *
 * `steps` are the ones the person goes through, each with its place in the
 * plan: a step the flow passed over (finding a device an earlier step already
 * found) is not counted, nor drawn as done.
 */
export function Progress({ steps, at, onGoTo }: { steps: { title: string; index: number }[]; at: number; onGoTo: (index: number) => void }) {
  const now = Math.max(0, steps.findIndex((step) => step.index === at));
  return (
    <YStack gap="$2">
      <Text fontSize={12} fontWeight="700" color="$muted" letterSpacing={0.6} textTransform="uppercase">
        Step {now + 1} of {steps.length}
      </Text>
      <XStack gap={4} aria-label="Setup steps">
        {steps.map((step, position) => {
          const done = position < now;
          return (
            <YStack
              key={`${step.title}-${step.index}`}
              flex={1}
              // A done step is a button: Tab reaches it, Enter or Space goes back to it.
              role={done ? 'button' : undefined}
              tabIndex={done ? 0 : undefined}
              aria-label={`${step.title}${done ? ', done: go back to it' : position === now ? ', now' : ''}`}
              aria-current={position === now ? 'step' : undefined}
              paddingVertical={6}
              cursor={done ? 'pointer' : 'default'}
              onPress={done ? () => onGoTo(step.index) : undefined}
              hoverStyle={done ? { opacity: 0.7 } : undefined}
              focusVisibleStyle={done ? { outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid', borderRadius: 4 } : undefined}
            >
              <YStack height={6} borderRadius={3} backgroundColor={position <= now ? '$accent' : '$backgroundPress'} opacity={done ? 0.55 : 1} />
            </YStack>
          );
        })}
      </XStack>
    </YStack>
  );
}
