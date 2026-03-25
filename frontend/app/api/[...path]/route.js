import { NextResponse } from 'next/server';

const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:18901';

function buildHeaders(request) {
  const headers = { 'Content-Type': 'application/json' };
  const auth = request.headers.get('authorization');
  if (auth) headers.Authorization = auth;
  return headers;
}

async function proxy(request, path) {
  const url = `${BACKEND}/${path.join('/')}`;
  const search = new URL(request.url).search;
  const target = search ? `${url}${search}` : url;

  const init = {
    method: request.method,
    headers: buildHeaders(request),
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const body = await request.text();
    if (body) init.body = body;
  }

  const res = await fetch(target, init);
  const text = await res.text();

  return new NextResponse(text, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
  });
}

export async function GET(request, ctx) {
  const { path } = await ctx.params;
  return proxy(request, path);
}

export async function POST(request, ctx) {
  const { path } = await ctx.params;
  return proxy(request, path);
}

export async function PUT(request, ctx) {
  const { path } = await ctx.params;
  return proxy(request, path);
}

export async function DELETE(request, ctx) {
  const { path } = await ctx.params;
  return proxy(request, path);
}

export async function PATCH(request, ctx) {
  const { path } = await ctx.params;
  return proxy(request, path);
}
