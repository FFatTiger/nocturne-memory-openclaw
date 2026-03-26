import { NextResponse } from 'next/server';
import { requireBearerAuth } from '../../../../../server/auth';
import { clearSessionReads, listSessionReads, markSessionRead } from '../../../../../server/nocturne/misc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  try {
    return NextResponse.json(await listSessionReads(searchParams.get('session_id') || ''));
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to list session reads' }, { status: 500 });
  }
}

export async function POST(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await markSessionRead(await request.json()));
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to mark session read' }, { status: Number(error?.status || 500) });
  }
}

export async function DELETE(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  try {
    return NextResponse.json(await clearSessionReads(searchParams.get('session_id') || ''));
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to clear session reads' }, { status: 500 });
  }
}
