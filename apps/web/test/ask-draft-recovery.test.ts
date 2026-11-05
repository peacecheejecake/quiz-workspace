import { describe, expect, it } from 'vitest';
import { recoverFailedDraft } from '../src/components/ask/ask-draft-recovery';

describe('UX11-AI-DIRECT failed send draft recovery', () => {
  it('restores the snapshot when no draft edit followed the send', () => {
    expect(recoverFailedDraft('질문', '', 4, 4)).toBe('질문');
  });

  it('preserves a new draft even if it was subsequently erased', () => {
    expect(recoverFailedDraft('질문', '새 질문', 4, 5)).toBe('새 질문');
    expect(recoverFailedDraft('질문', '', 4, 6)).toBe('');
  });
});
