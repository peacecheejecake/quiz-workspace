// WS-SHARE-01 screen model: current-link selection, failure mapping, expiry dates and the
// one-time share URL check.
import { describe, expect, it } from 'vitest';
import {
  classifyShareFailure,
  expiryDateValue,
  isShareUrl,
  parseExpiryDate,
  SHARE_LINK_INACTIVE,
  sharingState,
  type ShareLink,
} from '../src/lib/sharing/model';

const WS = '3f2b6f0e-8a4c-4d7e-9a51-1c2d3e4f5a6b';
const ID = '0b6a5c0e-1d2f-4a3b-8c4d-5e6f7a8b9c0d';
const SECRET = 'A'.repeat(43);

function link(id: string, status: ShareLink['status'], createdAt: string): ShareLink {
  return {
    id,
    workspace_id: WS,
    allow_fork: false,
    expires_at: null,
    revoked_at: status === 'revoked' ? createdAt : null,
    rotated_from_id: null,
    status,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe('sharingState', () => {
  it('is off without links', () => {
    expect(sharingState([])).toEqual({
      current: null,
      active: false,
      others: [],
      lastEnded: null,
    });
  });

  it('manages the newest active link; other non-revoked links are revoked with it', () => {
    const older = link('a', 'active', '2026-10-01T00:00:00Z');
    const newer = link('b', 'active', '2026-10-02T00:00:00Z');
    const revoked = link('c', 'revoked', '2026-10-03T00:00:00Z');
    const expired = link('d', 'expired', '2026-10-04T00:00:00Z');
    const state = sharingState([older, revoked, newer, expired]);
    expect(state.current?.id).toBe('b');
    expect(state.active).toBe(true);
    expect(state.others.map((l) => l.id)).toEqual(['d', 'a']);
    expect(state.lastEnded).toBeNull();
  });

  it('keeps an expired, non-revoked link manageable so its expiry can be extended', () => {
    const state = sharingState([
      link('a', 'expired', '2026-10-01T00:00:00Z'),
      link('b', 'revoked', '2026-10-02T00:00:00Z'),
    ]);
    expect(state.current?.id).toBe('a');
    expect(state.active).toBe(false);
    expect(state.lastEnded).toBe('expired');
  });

  it('is revoked when every link is revoked', () => {
    const state = sharingState([link('a', 'revoked', '2026-10-01T00:00:00Z')]);
    expect(state).toMatchObject({ current: null, active: false, lastEnded: 'revoked' });
  });
});

describe('classifyShareFailure', () => {
  it('maps the inactive-link conflict and falls back to the workspace mapping', () => {
    expect(classifyShareFailure(409, { type: SHARE_LINK_INACTIVE })).toBe('inactive');
    expect(classifyShareFailure(409, { type: 'other' })).toBe('unavailable');
    expect(
      classifyShareFailure(403, { type: 'urn:quiz-workspace:problem:workspace-archived' }),
    ).toBe('archived');
    expect(
      classifyShareFailure(403, { type: 'urn:quiz-workspace:problem:insufficient-role' }),
    ).toBe('forbidden');
    expect(classifyShareFailure(404, null)).toBe('notFound');
    expect(classifyShareFailure(401, undefined)).toBe('unauthenticated');
  });
});

describe('expiry dates', () => {
  const now = new Date(2026, 9, 18, 12, 0, 0);

  it('empty clears the expiry', () => {
    expect(parseExpiryDate('', now)).toEqual({ ok: true, expiresAt: null });
  });

  it('a chosen day lasts until its local end and round-trips to the same date', () => {
    const parsed = parseExpiryDate('2026-11-17', now);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const instant = new Date(parsed.expiresAt ?? '');
    expect([instant.getFullYear(), instant.getMonth(), instant.getDate()]).toEqual([2026, 10, 17]);
    expect([instant.getHours(), instant.getMinutes()]).toEqual([23, 59]);
    expect(expiryDateValue(parsed.expiresAt)).toBe('2026-11-17');
  });

  it('today is still allowed; past, impossible and malformed dates are not', () => {
    expect(parseExpiryDate('2026-10-18', now).ok).toBe(true);
    expect(parseExpiryDate('2026-10-17', now).ok).toBe(false);
    expect(parseExpiryDate('2026-02-30', now).ok).toBe(false);
    expect(parseExpiryDate('0002-11-17', now).ok).toBe(false);
    expect(parseExpiryDate('17.11.2026', now).ok).toBe(false);
  });

  it('shows no date for no or unreadable expiry', () => {
    expect(expiryDateValue(null)).toBe('');
    expect(expiryDateValue('not a date')).toBe('');
  });
});

describe('isShareUrl', () => {
  it('accepts only the link’s own /share/{id}#k={secret} URL', () => {
    expect(isShareUrl(`https://app.example.com/share/${ID}#k=${SECRET}`, ID)).toBe(true);
    expect(isShareUrl(`http://127.0.0.1:3000/share/${ID}#k=${SECRET}`, ID)).toBe(true);
    expect(isShareUrl(`https://app.example.com/share/${WS}#k=${SECRET}`, ID)).toBe(false);
    expect(isShareUrl(`https://app.example.com/share/${ID}?k=${SECRET}`, ID)).toBe(false);
    expect(isShareUrl(`https://app.example.com/share/${ID}?x=1#k=${SECRET}`, ID)).toBe(false);
    expect(isShareUrl(`https://app.example.com/share/${ID}#k=short`, ID)).toBe(false);
    expect(isShareUrl(`javascript:alert(1)//share/${ID}#k=${SECRET}`, ID)).toBe(false);
    expect(isShareUrl(null, ID)).toBe(false);
  });
});
