import { NextResponse } from 'next/server';
import { requireBearerAuth } from '../../../server/auth';
import { clearAllReviewGroups } from '../../../server/nocturne/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await clearAllReviewGroups());
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to clear review groups' }, { status: Number(error?.status || 500) });
  }
}
