import { NextResponse } from 'next/server';
import { requireBearerAuth } from '../../../../../../server/auth';
import { getReviewGroupDiff } from '../../../../../../server/nocturne/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await getReviewGroupDiff(params.nodeUuid));
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to load review diff' }, { status: Number(error?.status || 500) });
  }
}
