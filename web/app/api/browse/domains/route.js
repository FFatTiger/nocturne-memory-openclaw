import { NextResponse } from 'next/server';
import { requireBearerAuth } from '../../../../server/auth';
import { listDomains } from '../../../../server/nocturne/browse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const data = await listDomains();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      { detail: error?.message || 'Failed to load domains' },
      { status: 500 },
    );
  }
}
