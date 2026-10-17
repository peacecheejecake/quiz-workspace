// Local Mailpit (Supabase `[local_smtp]`) helper for AUTH-03 / AUTH-05 / AUTH-06 flows.
//
// Uses Node `fetch` so verification/recovery links (single-use credentials) are not recorded in
// Playwright traces. Do not attach returned links to reports or put them in test titles.
import { localEndpoints } from './local-env.ts';

export interface MailMessage {
  readonly id: string;
  readonly subject: string;
  readonly to: readonly string[];
  readonly html: string;
  readonly text: string;
}

export interface WaitOptions {
  /** Default 15 s. */
  readonly timeoutMs?: number;
  /** Only messages created at or after this time (e.g. right before the action under test). */
  readonly since?: Date;
}

interface SearchResult {
  messages: { ID: string; Created: string }[];
}

interface MessageBody {
  ID: string;
  Subject: string;
  To: { Address: string }[] | null;
  HTML: string;
  Text: string;
}

async function mailpit<T>(path: string, init?: RequestInit): Promise<T> {
  const { mailpitUrl } = localEndpoints();
  const res = await fetch(`${mailpitUrl}/api/v1${path}`, init);
  if (!res.ok)
    throw new Error(`Mailpit ${init?.method ?? 'GET'} ${path} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

function searchQuery(email: string): string {
  return `/search?query=${encodeURIComponent(`to:"${email}"`)}`;
}

/** Latest message sent to `email`, polling until it arrives. Throws on timeout. */
export async function waitForLatestMessage(
  email: string,
  options: WaitOptions = {},
): Promise<MailMessage> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  // 1 s tolerance for clock skew between the host and the Mailpit container.
  const since = (options.since?.getTime() ?? 0) - 1_000;
  for (;;) {
    const found = await mailpit<SearchResult>(searchQuery(email));
    const latest = found.messages.find((m) => Date.parse(m.Created) >= since);
    if (latest) {
      const msg = await mailpit<MessageBody>(`/message/${encodeURIComponent(latest.ID)}`);
      return {
        id: msg.ID,
        subject: msg.Subject,
        to: (msg.To ?? []).map((t) => t.Address),
        html: msg.HTML,
        text: msg.Text,
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(`no email for the test user arrived in Mailpit within the timeout`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&#x3D;': '=',
  '&#61;': '=',
};

function unescapeHtml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39|#x27|#x3D|#61);/gi, (e) => ENTITIES[e] ?? e);
}

/** All `href` targets in a message's HTML, entity-decoded, in document order. */
export function extractLinks(html: string): string[] {
  return [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => unescapeHtml(m[1] ?? ''));
}

/**
 * The single link in the latest mail to `email` (optionally the single one matching `match`).
 * Throws when zero or several links qualify, so templates with extra links fail loudly.
 */
export async function waitForMailLink(
  email: string,
  options: WaitOptions & { readonly match?: RegExp } = {},
): Promise<string> {
  const message = await waitForLatestMessage(email, options);
  const links = extractLinks(message.html).filter((l) => !options.match || options.match.test(l));
  if (links.length !== 1) {
    throw new Error(`expected exactly one matching link in the mail, found ${links.length}`);
  }
  return links[0] as string;
}

/** Deletes every message addressed to `email` (fixture teardown). */
export async function deleteMessagesFor(email: string): Promise<void> {
  const found = await mailpit<SearchResult>(searchQuery(email));
  if (!found.messages.length) return;
  const { mailpitUrl } = localEndpoints();
  const res = await fetch(`${mailpitUrl}/api/v1/messages`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ IDs: found.messages.map((m) => m.ID) }),
  });
  if (!res.ok) throw new Error(`Mailpit DELETE /messages failed: HTTP ${res.status}`);
}
