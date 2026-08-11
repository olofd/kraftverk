import { SafeAreaView } from 'react-native-safe-area-context';
import { TamaguiProvider, Theme, YStack } from 'tamagui';
import config from './tamagui.config';
import HomeScreen from './src/screens/HomeScreen';

export default function App() {
  return (
    <TamiguiProvider config={config} disableInjectCSS>
      <Theme name="light">
        <SafeAreaView style={{ flex: 1 }}>
          <YStack flex={1} backgroundColor="$background">
            <HomeScreen />
          </YStack>
        </SafeAreaView>
      </Theme>
    </TamaguiProvider>
  );
}
