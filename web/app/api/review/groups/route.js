import { NextResponse } from 'next/server';
import { requireBearerAuth } from '../../../../server/auth';
import { listReviewGroups } from '../../../../server/nocturne/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await listReviewGroups());
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to list review groups' }, { status: Number(error?.status || 500) });
  }
}
