import type { Metadata } from 'next';
import { LegalPlaceholder } from '@/components/legal-placeholder';

export const metadata: Metadata = { title: '개인정보 처리방침' };

export default function Page() {
  return <LegalPlaceholder title="개인정보 처리방침" />;
}
