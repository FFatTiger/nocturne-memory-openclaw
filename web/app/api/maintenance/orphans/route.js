import { NextResponse } from 'next/server';
import { requireBearerAuth } from '../../../../server/auth';
import { listOrphans } from '../../../../server/nocturne/maintenance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;

  try {
    return NextResponse.json(await listOrphans());
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to load orphans' }, { status: 500 });
  }
}
