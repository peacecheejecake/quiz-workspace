import type { Metadata } from 'next';
import { HelpScreen } from '@/components/help/help-screen';
import { getScreen } from '@/screens';

export const metadata: Metadata = { title: getScreen('UX12-HELP').name };

// UX12-HELP. Static content; the help layout's shell requires a verified session.
export default function Page() {
  return <HelpScreen screenId="UX12-HELP" />;
}
