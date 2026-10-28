// QOV-01-AC09 (UX3c): 전체 문제 (bank) skeleton while the bank loads.
import { SubPageSkeleton } from '@/components/workspaces/route-skeletons';

export default function Loading() {
  return <SubPageSkeleton label="전체 문제를 불러오는 중입니다." />;
}
