import type { Metadata } from 'next';
import { LegalPlaceholder } from '@/components/legal-placeholder';

export const metadata: Metadata = { title: '이용약관' };

export default function Page() {
  return <LegalPlaceholder title="이용약관" />;
}
