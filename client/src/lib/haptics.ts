import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Light tap feedback for control changes. No-op on web and on any platform
 * where the taptic engine isn't available, so callers never need to guard.
 */
export function haptic(style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light) {
  if (Platform.OS === 'web') return;
  void Haptics.impactAsync(style).catch(() => {});
}
