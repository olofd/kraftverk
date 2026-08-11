import { Feather } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useTheme } from 'tamagui';

export default function TabsLayout() {
  const theme = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accent?.val,
        tabBarInactiveTintColor: theme.muted?.val,
        tabBarStyle: {
          backgroundColor: theme.card?.val,
          borderTopColor: theme.borderColor?.val,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        sceneStyle: { backgroundColor: theme.background?.val },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color, size }) => <Feather name="zap" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => <Feather name="sliders" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="devices"
        options={{
          title: 'Devices',
          tabBarIcon: ({ color, size }) => <Feather name="radio" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="diagnostics"
        options={{
          title: 'Protocol',
          tabBarIcon: ({ color, size }) => <Feather name="activity" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
