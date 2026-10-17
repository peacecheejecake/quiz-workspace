import { StubScreen, stubMetadata } from '@/components/stub-screen';

export const metadata = stubMetadata('QOV-01');

export default async function Page({
  searchParams,
}: PageProps<'/workspaces/[workspaceId]/questions'>) {
  return (
    <StubScreen screenId="QOV-01" queryScreenId="QPLAY-01" searchParams={await searchParams} />
  );
}
