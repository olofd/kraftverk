import { YStack } from 'tamagui';

import type { RecipeView } from '@kraftverk/api-client';
import { Card, haptic, Icon, Row, RowSeparator } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { useTone } from '../../../components/tone';
import { Empty, Group } from '../page/Group';

/**
 * Where a new one starts: from nothing, or a recipe copied — its steps then
 * the owner's to change. Started from a device, the recipes it can take part
 * in come first.
 */
export function StartFrom({ recipes, fits, onChoose, onYaml }: { recipes: readonly RecipeView[]; fits: (recipe: RecipeView) => boolean; onChoose: (recipe: RecipeView | null) => void; onYaml: () => void }) {
  const tone = useTone();
  const ordered = [...recipes].sort((a, b) => Number(fits(b)) - Number(fits(a)));
  return (
    <Group icon="plus-circle" title="Start from">
      <Card inset backgroundColor="$background">
        <Pressable onPress={() => (haptic(), onChoose(null))} label="Start from nothing">
          <Row title="Nothing" subtitle="Build it block by block: what starts it, and each step it takes." accessory={<Icon name="plus" size={18} color={tone('$accent')} />} />
        </Pressable>
        <RowSeparator />
        <Pressable onPress={() => (haptic(), onYaml())} label="Write it as YAML">
          <Row title="As YAML" subtitle="Write it in a configuration’s words — or paste one exported from here or another server." accessory={<Icon name="code" size={18} color={tone('$accent')} />} />
        </Pressable>
        {ordered.map((recipe) => (
          <YStack key={recipe.id}>
            <RowSeparator />
            <Pressable onPress={() => (haptic(), onChoose(recipe))} label={`Start from ${recipe.label}`}>
              <Row title={recipe.label} subtitle={recipe.from ? `${recipe.description} From ${recipe.from.name}.` : recipe.description} />
            </Pressable>
          </YStack>
        ))}
      </Card>
      <Empty>A recipe is a starting point: once copied, every step of it is yours to change.</Empty>
    </Group>
  );
}
