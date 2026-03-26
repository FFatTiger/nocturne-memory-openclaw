import { NextResponse } from 'next/server';
import { requireBearerAuth } from '../../../../server/auth';
import { manageTriggers } from '../../../../server/nocturne/misc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await manageTriggers(await request.json()));
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to update triggers' }, { status: Number(error?.status || 500) });
  }
}
