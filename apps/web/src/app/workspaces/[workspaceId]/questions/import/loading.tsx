// QOV-01-AC09 (UX3c): 문제 PDF 가져오기 skeleton while the latest import loads.
import { SubPageSkeleton } from '@/components/workspaces/route-skeletons';

export default function Loading() {
  return <SubPageSkeleton label="문제 PDF 가져오기를 불러오는 중입니다." />;
}
