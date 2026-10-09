import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { Button, Text, XStack, YStack } from 'tamagui';

import { describeError, PATHS, type ScriptView } from '@kraftverk/api-client';
import { Card, haptic, Icon, RowSeparator } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Loading } from '../../components/Loading';
import { Screen } from '../../components/Screen';
import { useTone } from '../../components/tone';
import { useFamily } from '../../state/FamilyProvider';
import { AutomationList } from './AutomationList';
import { useAutomations } from './useAutomations';

/** The family's scripts (docs/PLAN-SCRIPTS.md), read each time the page is shown: one written elsewhere is there when it is back. */
function Scripts() {
  const { api } = useFamily();
  const tone = useTone();
  const [scripts, setScripts] = useState<ScriptView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      api.scripts
        .list()
        .then((found) => (setScripts(found), setError(null)))
        .catch((err: unknown) => setError(describeError(err) || 'They could not be read'));
    }, [api])
  );

  return (
    <YStack gap="$3" role="region" aria-label="Scripts" paddingTop="$2">
      <XStack alignItems="center" justifyContent="space-between" gap="$3">
        <YStack flex={1} gap={2}>
          <Text role="heading" aria-level={2} fontSize={18} fontWeight="700" color="$color">
            Scripts
          </Text>
          <Text fontSize={14} color="$muted" lineHeight={20}>
            {scripts?.length ? `${scripts.length} script${scripts.length === 1 ? '' : 's'}, in TypeScript` : 'What an automation does, written in TypeScript.'}
          </Text>
        </YStack>
        {/* As "New" above, quieter: the page's own action is a new automation. */}
        <Button size="$4" chromeless borderWidth={1} borderColor="$borderColor" color="$color" icon={<Icon name="plus" size={16} color={tone('$accent')} />} aria-label="Write a script" onPress={() => (haptic(), router.push(PATHS.scripts.new))}>
          New
        </Button>
      </XStack>
      <ErrorText>{error}</ErrorText>
      {scripts?.length ? (
        <Card inset>
          {scripts.map((script, index) => (
            <YStack key={script.id}>
              {index ? <RowSeparator /> : null}
              <XStack role="link" aria-label={script.name} cursor="pointer" padding="$3" gap="$3" alignItems="center" pressStyle={{ opacity: 0.6 }} onPress={() => router.push(PATHS.scripts.one(script.id))}>
                <YStack width={36} height={36} borderRadius="$3" alignItems="center" justifyContent="center" backgroundColor="$backgroundPress">
                  <Icon name="code" size={16} color={tone('$accent')} />
                </YStack>
                <YStack flex={1} gap={2}>
                  <Text fontSize={15} fontWeight="600" color="$color">
                    {script.name}
                  </Text>
                  <Text fontSize={13} color={script.problems.length ? '$warning' : '$muted'}>
                    {script.problems.length
                      ? `${script.problems.length} thing${script.problems.length === 1 ? '' : 's'} to fix`
                      : [`${Object.keys(script.shape?.steps ?? {}).length} step`, `${Object.keys(script.shape?.functions ?? {}).length} function`, ...(script.usedBy.length ? [`used by ${script.usedBy.length} automation`] : [])].map((said) => (/(^|by )1 /.test(said) ? said : `${said}s`)).join(' · ')}
                  </Text>
                </YStack>
                <Icon name="chevron-right" size={16} color={tone('$muted')} />
              </XStack>
            </YStack>
          ))}
        </Card>
      ) : null}
    </YStack>
  );
}

/**
 * Automations (docs/AUTOMATIONS.md, docs/AUTOMATIONS-UX.md): each one a small
 * card — what starts it, its name, how it stands, and a button that runs it
 * now. Its name opens its own page, where it is seen whole and changed.
 *
 * Any can be run, for real. What it does on its own — its triggers — only
 * watches at first: it says what it would have done, until it is let act,
 * which is confirmed. Everything it does goes through the same gateway as a
 * tap on a switch. Under them, the family's scripts.
 */
export function AutomationsScreen() {
  // How each stands, kept current while this is open: read again when a run moves, or a reading each stands on.
  const { automations, error, replace } = useAutomations({ followReadings: true });

  return (
    <Screen back="Your devices" title="Automations">
      {!automations ? <Loading error={error} /> : <ErrorText>{error}</ErrorText>}
      {automations ? (
        <AutomationList
          automations={automations}
          onChanged={replace}
          empty="An automation is steps your devices take — “power the charger, wait for its plug, switch it on, and make sure it draws” — started by you, at a time, or when something holds. Build one block by block, or start from a recipe."
        />
      ) : null}
      <Scripts />
    </Screen>
  );
}
