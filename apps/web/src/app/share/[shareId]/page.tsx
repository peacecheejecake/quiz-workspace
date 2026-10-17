import { StubScreen, stubMetadata } from '@/components/stub-screen';

export const metadata = stubMetadata('WS-VIEW-01');

export default async function Page({ searchParams }: PageProps<'/share/[shareId]'>) {
  return (
    <StubScreen
      screenId="WS-VIEW-01"
      queryScreenId="WS-FORK-01"
      searchParams={await searchParams}
    />
  );
}
