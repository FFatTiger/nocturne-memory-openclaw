import { NextResponse } from 'next/server';
import { requireBearerAuth } from '../../../../server/auth';
import { addGlossaryKeyword, getGlossary, removeGlossaryKeyword } from '../../../../server/nocturne/misc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await getGlossary());
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to load glossary' }, { status: 500 });
  }
}

export async function POST(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await addGlossaryKeyword(await request.json()));
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to add glossary keyword' }, { status: Number(error?.status || 500) });
  }
}

export async function DELETE(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await removeGlossaryKeyword(await request.json()));
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to remove glossary keyword' }, { status: Number(error?.status || 500) });
  }
}
