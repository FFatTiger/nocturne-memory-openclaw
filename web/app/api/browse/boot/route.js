import { NextResponse } from 'next/server';
import { requireBearerAuth } from '../../../../server/auth';
import { bootView } from '../../../../server/nocturne/misc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  try {
    return NextResponse.json(await bootView(searchParams.get('core_memory_uris')));
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to load boot view' }, { status: 500 });
  }
}
