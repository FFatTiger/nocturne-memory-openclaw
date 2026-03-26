import { NextResponse } from 'next/server';
import { requireBearerAuth } from '../../../../server/auth';
import { addAlias } from '../../../../server/nocturne/write';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json();
    return NextResponse.json(await addAlias(body || {}));
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to add alias' }, { status: Number(error?.status || 500) });
  }
}
