import { NextResponse } from 'next/server';
import { requireBearerAuth } from '../../../../server/auth';
import { recallMemories } from '../../../../server/nocturne/recall';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await recallMemories(await request.json()));
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Recall failed' }, { status: Number(error?.status || 500) });
  }
}
