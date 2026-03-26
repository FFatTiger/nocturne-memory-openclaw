import { NextResponse } from 'next/server';
import { requireBearerAuth } from '../../../../../server/auth';
import { getOrphanDetail, permanentlyDeleteDeprecatedMemory } from '../../../../../server/nocturne/maintenance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;

  const memoryId = Number(params.memoryId);
  try {
    const detail = await getOrphanDetail(memoryId);
    if (!detail) return NextResponse.json({ detail: `Memory ${memoryId} not found` }, { status: 404 });
    return NextResponse.json(detail);
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to load orphan detail' }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;

  const memoryId = Number(params.memoryId);
  try {
    return NextResponse.json(await permanentlyDeleteDeprecatedMemory(memoryId));
  } catch (error) {
    return NextResponse.json(
      { detail: error?.message || 'Failed to delete orphan memory' },
      { status: Number(error?.status || 500) },
    );
  }
}
