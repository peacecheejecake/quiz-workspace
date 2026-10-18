import type { Metadata } from 'next';
import { LegalPlaceholder } from '@/components/legal-placeholder';
import styles from '@/components/stub-screen.module.css';

export const metadata: Metadata = { title: '개인정보 처리방침' };

// Draft list of processors (docs/deployment.md §1, §6). Cloudflare receives document text chunks
// and search queries for embedding (M7.4b, user decision 2026-10-18).
const PROCESSORS: readonly { name: string; purpose: string }[] = [
  { name: 'Supabase', purpose: '계정 인증, 데이터베이스, PDF 파일 저장' },
  { name: 'Vercel', purpose: '웹 화면 호스팅' },
  { name: 'Railway', purpose: 'API 서버와 문서 처리 작업 실행' },
  { name: 'Qdrant', purpose: '검색 색인 저장' },
  {
    name: 'Cloudflare (Workers AI)',
    purpose: '업로드한 문서의 원문 일부와 검색어로 의미 검색용 임베딩 계산',
  },
];

export default function Page() {
  return (
    <LegalPlaceholder title="개인정보 처리방침">
      <section aria-labelledby="privacy-processors" className={styles.panel}>
        <h2 id="privacy-processors" className={styles.panelTitle}>처리 위탁(초안)</h2>
        <p>서비스 제공을 위해 다음 업체가 데이터를 처리합니다.</p>
        <ul>
          {PROCESSORS.map((p) => (
            <li key={p.name}>
              <strong>{p.name}</strong>: {p.purpose}
            </li>
          ))}
        </ul>
      </section>
    </LegalPlaceholder>
  );
}
