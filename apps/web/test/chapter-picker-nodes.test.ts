import { describe, expect, it } from 'vitest';
import { chapterPickerNodes } from '@/lib/questions/chapter-picker';
import { targetPickerNodes, type RedistributionList } from '@/lib/questions/redistribution';
import { createSearchClient, flattenOutline, type OutlineItem } from '@/lib/search/client';

const chapter = (id: string, level: number, documentId: string) => ({
  id,
  title: `제목 ${id}`,
  level,
  documentId,
  documentTitle: `문서 ${documentId}`,
});

const outline = (id: string, level: number, children: OutlineItem[] = []): OutlineItem => ({
  id,
  title: id,
  level,
  children,
  block_id: null,
  page: null,
  section_key: id,
});

describe('chapterPickerNodes', () => {
  it('keeps one book flat at its own levels', () => {
    expect(chapterPickerNodes([chapter('a', 1, 'd'), chapter('b', 2, 'd')])).toEqual([
      { value: 'a', label: '제목 a', level: 1 },
      { value: 'b', label: '제목 b', level: 2 },
    ]);
  });

  it('groups several books, also when their chapters arrive apart', () => {
    const nodes = chapterPickerNodes([
      chapter('a', 1, 'd1'),
      chapter('b', 1, 'd2'),
      chapter('c', 2, 'd1'),
    ]);
    expect(nodes.map((n) => [n.value, n.level, n.group ?? false])).toEqual([
      ['document:d1', 0, true],
      ['a', 1, false],
      ['c', 2, false],
      ['document:d2', 0, true],
      ['b', 1, false],
    ]);
    expect(nodes[1]?.triggerLabel).toBe('제목 a (문서 d1)');
  });

  it('builds the redistribution tree from depth', () => {
    const list = {
      targets: [
        {
          document_id: 'd',
          document_title: '문서',
          chapters: [
            { id: 'a', title: 'A', depth: 1 },
            { id: 'b', title: 'B', depth: 2 },
          ],
        },
      ],
    } as unknown as RedistributionList;
    expect(targetPickerNodes(list)).toEqual([
      { value: 'a', label: 'A', level: 1 },
      { value: 'b', label: 'B', level: 2 },
    ]);
  });
});

describe('the outline of Ask and search', () => {
  it('reads sub-chapters in reading order', () => {
    const tree = [outline('1', 1, [outline('1.1', 2, [outline('1.1.1', 3)])]), outline('2', 1)];
    expect(flattenOutline(tree).map((item) => item.id)).toEqual(['1', '1.1', '1.1.1', '2']);
  });

  it('client.chapters returns every node, so a sub-chapter of the address stays known', async () => {
    const body = { items: [outline('1', 1, [outline('1.1', 2)])] };
    const client = createSearchClient(
      async () => new Response(JSON.stringify(body), { status: 200 }),
    );
    const items = await client.chapters('doc');
    expect(items.map((item) => item.id)).toEqual(['1', '1.1']);
  });
});
