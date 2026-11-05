import { createSupabaseServerClient } from '@/lib/supabase/server';

const headers = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getClaims();
    if (error) {
      if (error.name === 'AuthSessionMissingError') return Response.json({ id: null }, { headers });
      return Response.json({ error: 'identity_unavailable' }, { status: 503, headers });
    }
    if (data === null) return Response.json({ id: null }, { headers });
    if (typeof data.claims?.sub !== 'string' || !data.claims.sub) {
      return Response.json({ error: 'identity_unavailable' }, { status: 503, headers });
    }
    return Response.json({ id: data.claims.sub }, { headers });
  } catch {
    return Response.json({ error: 'identity_unavailable' }, { status: 503, headers });
  }
}
