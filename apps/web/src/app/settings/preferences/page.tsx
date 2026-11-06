import type { Metadata } from 'next';
import { PreferencesScreen } from '@/components/account/preferences-screen';
import { getScreen } from '@/screens';

export const metadata: Metadata = { title: getScreen('UX12-SETTINGS').name };

// UX12-SETTINGS. The settings layout's shell already requires a verified session.
export default function Page() {
  return <PreferencesScreen screenId="UX12-SETTINGS" />;
}
