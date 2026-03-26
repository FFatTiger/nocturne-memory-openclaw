import { NextResponse } from 'next/server';
import { requireBearerAuth } from '../../../../../server/auth';
import { approveReviewGroup, rollbackReviewGroup } from '../../../../../server/nocturne/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(request, { params }) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await approveReviewGroup(params.nodeUuid));
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to approve review group' }, { status: Number(error?.status || 500) });
  }
}

export async function POST(request, { params }) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await rollbackReviewGroup(params.nodeUuid));
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to rollback review group' }, { status: Number(error?.status || 500) });
  }
}
