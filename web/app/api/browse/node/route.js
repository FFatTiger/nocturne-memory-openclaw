import { NextResponse } from 'next/server';
import { requireBearerAuth } from '../../../../server/auth';
import { getNodePayload } from '../../../../server/nocturne/browse';
import { createNode, deleteNodeByPath, updateNodeByPath } from '../../../../server/nocturne/write';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function asBoolean(value) {
  return value === '1' || value === 'true';
}

export async function GET(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const domain = (searchParams.get('domain') || 'core').trim() || 'core';
  const path = (searchParams.get('path') || '').trim().replace(/^\/+|\/+$/g, '');
  const navOnly = asBoolean((searchParams.get('nav_only') || '').toLowerCase());

  try {
    const data = await getNodePayload({ domain, path, navOnly });
    return NextResponse.json(data);
  } catch (error) {
    const status = Number(error?.status || 500);
    return NextResponse.json(
      { detail: error?.message || 'Failed to load node' },
      { status },
    );
  }
}

export async function PUT(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const domain = (searchParams.get('domain') || 'core').trim() || 'core';
  const path = (searchParams.get('path') || '').trim().replace(/^\/+|\/+$/g, '');

  try {
    const body = await request.json();
    const data = await updateNodeByPath({
      domain,
      path,
      content: body?.content,
      priority: body?.priority,
      disclosure: Object.prototype.hasOwnProperty.call(body || {}, 'disclosure') ? body.disclosure : undefined,
    });
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to update node' }, { status: Number(error?.status || 500) });
  }
}

export async function POST(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json();
    const data = await createNode({
      domain: (body?.domain || 'core').trim() || 'core',
      parentPath: String(body?.parent_path || '').trim().replace(/^\/+|\/+$/g, ''),
      content: String(body?.content || ''),
      priority: Number(body?.priority ?? 0),
      title: body?.title || '',
      disclosure: body?.disclosure ?? null,
    });
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to create node' }, { status: Number(error?.status || 500) });
  }
}

export async function DELETE(request) {
  const unauthorized = requireBearerAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const domain = (searchParams.get('domain') || 'core').trim() || 'core';
  const path = (searchParams.get('path') || '').trim().replace(/^\/+|\/+$/g, '');

  try {
    return NextResponse.json(await deleteNodeByPath({ domain, path }));
  } catch (error) {
    return NextResponse.json({ detail: error?.message || 'Failed to delete node' }, { status: Number(error?.status || 500) });
  }
}