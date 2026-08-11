import { Link, Stack } from 'expo-router';
import { Button, Text, YStack } from 'tamagui';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <YStack
        flex={1}
        alignItems="center"
        justifyContent="center"
        gap="$4"
        padding="$6"
        backgroundColor="$background"
      >
        <Text fontSize={22} fontWeight="800" color="$color">
          This screen doesn&apos;t exist
        </Text>
        <Link href="/" asChild>
          <Button size="$4">Back to dashboard</Button>
        </Link>
      </YStack>
    </>
  );
}
