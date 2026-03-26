import { NextResponse } from 'next/server';
import { sql } from '../../../server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await sql('SELECT 1');
    return NextResponse.json({ status: 'ok', database: 'connected' });
  } catch {
    return NextResponse.json({ status: 'degraded', database: 'disconnected' }, { status: 503 });
  }
}
