import { NextResponse } from 'next/server';
import { requireBearerAuth } from '../../../../../server/auth';
import { ensureRecallIndex } from '../../../../../server/nocturne/recall';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const data = await ensureRecallIndex(await request.json());
    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Recall rebuild failed' }, { status: Number(error?.status || 500) });
  }
}
