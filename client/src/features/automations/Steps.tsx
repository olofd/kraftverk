import { Fragment } from 'react';
import { Spinner, Text, XStack, YStack } from 'tamagui';

import type { AutomationRun, RunStep, StepLine } from '@kraftverk/api-client';
import { Icon, IconLabel } from '@kraftverk/ui';

import { useTone } from '../../components/tone';
import { KIND, STEP, stopwatch, took, useNow } from './looks';

/**
 * A sequence, the two ways it is shown (docs/SEQUENCES.md): what it will do —
 * numbered steps, the steps within them indented under what they are for —
 * and a run of it, step by step as it went or goes, each with how it went and
 * how long it took, the one it is in now counting down.
 */

/** What it does, step by step, and what it does if a step does not succeed. */
export function StepPlan({ steps, otherwise, numbered = true }: { steps: readonly StepLine[]; otherwise?: readonly StepLine[]; numbered?: boolean }) {
  const tone = useTone();
  return (
    <YStack gap="$3">
      <YStack gap="$2.5" role="list" aria-label="Its steps">
        {steps.map((line, index) => (
          <PlanLine key={`${index}:${line.text}`} line={line} number={numbered ? index + 1 : undefined} />
        ))}
      </YStack>
      {otherwise?.length ? (
        <YStack gap="$2" padding="$3" borderRadius="$4" backgroundColor="$backgroundPress">
          <XStack gap="$2" alignItems="center">
            <Icon name="corner-up-left" size={13} color={tone('$muted')} />
            <Text fontSize={12} fontWeight="800" color="$muted" textTransform="uppercase" letterSpacing={0.6}>
              If a step does not succeed, or you stop it
            </Text>
          </XStack>
          {otherwise.map((line, index) => (
            <PlanLine key={`${index}:${line.text}`} line={line} />
          ))}
        </YStack>
      ) : null}
    </YStack>
  );
}

function PlanLine({ line, number }: { line: StepLine; number?: number }) {
  const tone = useTone();
  return (
    <YStack gap="$2" role="listitem">
      {/* Its number and its kind, each in a box one line tall: centred on the first line of its words. */}
      <XStack gap="$2.5" alignItems="flex-start">
        {number !== undefined ? (
          <YStack height={22} justifyContent="center">
            <YStack width={22} height={22} borderRadius={11} alignItems="center" justifyContent="center" backgroundColor="$accent">
              <Text fontSize={11} lineHeight={22} fontWeight="800" color="$background">
                {number}
              </Text>
            </YStack>
          </YStack>
        ) : null}
        <YStack flex={1}>
          <IconLabel icon={KIND[line.kind]} size={14} color={tone('$muted')} lineHeight={22}>
            <Text fontSize={15} color="$color" lineHeight={22}>
              {line.text}
            </Text>
          </IconLabel>
        </YStack>
      </XStack>
      {line.branches.map((branch) => (
        <YStack key={branch.label} marginLeft={number !== undefined ? 32 : 10} paddingLeft="$3" borderLeftWidth={2} borderColor="$borderColor" gap="$2">
          <Text fontSize={11} fontWeight="800" color="$muted" textTransform="uppercase" letterSpacing={0.6}>
            {branch.label}
          </Text>
          {branch.steps.map((inner, index) => (
            <PlanLine key={`${index}:${inner.text}`} line={inner} />
          ))}
        </YStack>
      ))}
    </YStack>
  );
}

/**
 * A run's steps as it went — or goes: each step's mark, what it was, how it
 * went in the gateway's or the engine's words, and how long it took. The step
 * it is in now shows a spinner and counts down to the most it may take. Steps
 * within steps are indented, each group headed by what it is within.
 */
export function RunSteps({ run }: { run: AutomationRun }) {
  const tone = useTone();
  const waiting = run.steps.some((step) => step.outcome === 'waiting');
  const now = useNow(waiting);
  return (
    <YStack gap="$1" role="list" aria-label={run.outcome === 'running' ? 'Its steps so far' : 'Its steps'}>
      {run.steps.map((step, index) => {
        // What a group of steps is within — "Try 2 of 3", "After a step did not succeed" — said once, above it.
        const before = run.steps[index - 1];
        const heading = step.within && (before?.within !== step.within || before.depth !== step.depth) ? step.within : null;
        return (
          <Fragment key={`${index}:${step.at}:${step.what}`}>
            {heading ? (
              <Text marginLeft={step.depth * 20} marginTop="$1.5" fontSize={11} fontWeight="800" color="$muted" textTransform="uppercase" letterSpacing={0.6}>
                {heading}
              </Text>
            ) : null}
            <StepRow step={step} now={now} tone={tone} />
          </Fragment>
        );
      })}
    </YStack>
  );
}

function StepRow({ step, now, tone }: { step: RunStep; now: number; tone: ReturnType<typeof useTone> }) {
  const look = STEP[step.outcome];
  const going = step.outcome === 'waiting';
  const left = going && step.until ? Math.max(0, (Date.parse(step.until) - now) / 1000) : null;
  const total = step.until ? Math.max(1, (Date.parse(step.until) - Date.parse(step.at)) / 1000) : null;
  return (
    <XStack gap="$2.5" alignItems="flex-start" marginLeft={step.depth * 20} paddingVertical={3} role="listitem" aria-label={`${step.what}: ${going ? 'now' : look.label}. ${step.detail}`}>
      <YStack width={20} height={20} alignItems="center" justifyContent="center" marginTop={1}>
        {going ? <Spinner size="small" color="$accent" /> : <Icon name={look.icon} size={14} color={tone(look.tone)} />}
      </YStack>
      <YStack flex={1} gap={1}>
        <XStack gap="$2" alignItems="flex-start">
          <Text flex={1} fontSize={14} fontWeight={going ? '700' : '600'} color={step.outcome === 'would' ? '$muted' : '$color'} lineHeight={20}>
            {step.what}
          </Text>
          <Text fontSize={12} color="$muted" fontVariant={['tabular-nums']} marginTop={2}>
            {going
              ? left !== null && total !== null
                ? `${stopwatch(total - left)} of ${stopwatch(total)}`
                : took(step.at, now)
              : // How long it took, when that is worth saying: a second or more.
                step.endedAt && Date.parse(step.endedAt) - Date.parse(step.at) >= 1000
                ? took(step.at, step.endedAt)
                : ''}
          </Text>
        </XStack>
        {step.detail ? (
          <Text fontSize={12} color={going ? '$accent' : look.tone === '$danger' || look.tone === '$warning' ? look.tone : '$muted'} lineHeight={17}>
            {step.detail}
          </Text>
        ) : null}
        {going && left !== null && total !== null ? (
          <YStack height={3} borderRadius={2} backgroundColor="$backgroundPress" overflow="hidden" marginTop={3}>
            <YStack height={3} borderRadius={2} backgroundColor="$accent" width={`${Math.min(100, Math.round(((total - left) / total) * 100))}%`} />
          </YStack>
        ) : null}
      </YStack>
    </XStack>
  );
}
