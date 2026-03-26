import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unsupported() {
  return NextResponse.json(
    {
      detail: 'Unknown API route. The legacy Python backend proxy is disabled in the Next.js build.',
    },
    { status: 404 },
  );
}

export async function GET() {
  return unsupported();
}

export async function POST() {
  return unsupported();
}

export async function PUT() {
  return unsupported();
}

export async function DELETE() {
  return unsupported();
}

export async function PATCH() {
  return unsupported();
}
