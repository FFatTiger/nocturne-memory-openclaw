'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BookOpen,
  Braces,
  Database,
  FileSearch,
  FlaskConical,
  Link2,
  Radar,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../src/lib/api';

const STORAGE_KEY = 'nocturne-plugin-lab:v1';

const DEFAULT_FORM = {
  domain: 'core',
  path: '',
  navOnly: false,
  searchQuery: '',
  searchDomain: '',
  searchLimit: 10,

  createDomain: 'core',
  createParentPath: '',
  createTitle: '',
  createPriority: 0,
  createDisclosure: '',
  createContent: '',

  updateDomain: 'core',
  updatePath: '',
  updatePriority: 0,
  updateDisclosure: '',
  updateContent: '',

  deleteDomain: 'core',
  deletePath: '',

  aliasNewUri: '',
  aliasTargetUri: '',
  aliasPriority: 0,
  aliasDisclosure: '',

  triggerUri: '',
  triggerAdd: '',
  triggerRemove: '',

  glossaryKeyword: '',
  glossaryNodeUuid: '',

  sessionId: 'plugin-lab-demo',
  sessionKey: '',
  sessionUri: '',
  sessionNodeUuid: '',
  sessionSource: 'ui:plugin-lab',

  reviewNodeUuid: '',
  orphanId: '',

  recallQuery: '',
  recallLimit: 12,
  recallMinScore: 0,
  recallMaxDisplayItems: 3,
  recallMinDisplayScore: 0.6,
  recallScorePrecision: 2,
  recallExcludeBoot: true,
  recallReadNodeDisplayMode: 'soft',
  recallEmbeddingBaseUrl: '',
  recallEmbeddingApiKey: '',
  recallEmbeddingModel: '',
  recallEmbeddingTimeoutMs: 30000,
};

function splitTokens(raw) {
  return String(raw || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toUri(domain, path) {
  const cleanDomain = String(domain || 'core').trim() || 'core';
  const cleanPath = String(path || '').trim().replace(/^\/+|\/+$/g, '');
  return `${cleanDomain}://${cleanPath}`;
}

function readCueList(item) {
  const cues = Array.isArray(item?.cues) ? item.cues : [];
  return cues.map((x) => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 3);
}

function formatRecallBlock(items, precision = 2) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lines = ['<recall>'];
  for (const item of items) {
    const score = Number.isFinite(item?.score_display)
      ? Number(item.score_display).toFixed(precision)
      : String(item?.score ?? '');
    const cues = readCueList(item);
    const cueText = `${item?.read ? 'read · ' : ''}${cues.join(' · ')}`.trim();
    lines.push(`${score} | ${item?.uri || ''}${cueText ? ` | ${cueText}` : ''}`);
  }
  lines.push('</recall>');
  return lines.join('\n');
}

function Input({ label, value, onChange, placeholder, mono = false, type = 'text' }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={clsx(
          'w-full rounded-xl border border-white/10 bg-zinc-950/80 px-3 py-2.5 text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/40 focus:outline-none',
          mono && 'font-mono',
        )}
      />
    </label>
  );
}

function TextArea({ label, value, onChange, placeholder, rows = 4, mono = false }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">{label}</span>
      <textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={clsx(
          'w-full rounded-xl border border-white/10 bg-zinc-950/80 px-3 py-2.5 text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/40 focus:outline-none',
          mono && 'font-mono',
        )}
        spellCheck={false}
      />
    </label>
  );
}

function Checkbox({ label, checked, onChange, help }) {
  return (
    <label className="flex items-start gap-3 rounded-xl border border-white/8 bg-zinc-950/60 px-3 py-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-white/15 bg-zinc-950 text-violet-500 focus:ring-violet-500"
      />
      <span className="min-w-0">
        <span className="block text-[12px] font-medium text-zinc-200">{label}</span>
        {help ? <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-500">{help}</span> : null}
      </span>
    </label>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-white/10 bg-zinc-950/80 px-3 py-2.5 text-[13px] text-zinc-200 focus:border-violet-500/40 focus:outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ActionButton({ label, onClick, busy, tone = 'default' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-xl border px-3.5 py-2 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-60',
        tone === 'danger'
          ? 'border-rose-500/20 bg-rose-500/10 text-rose-300 hover:bg-rose-500/15'
          : tone === 'accent'
            ? 'border-violet-500/20 bg-violet-500/10 text-violet-200 hover:bg-violet-500/15'
            : 'border-white/10 bg-zinc-900/70 text-zinc-200 hover:border-white/15 hover:bg-zinc-800/80',
      )}
    >
      {busy ? <RefreshCw size={13} className="animate-spin" /> : <Activity size={13} />}
      {label}
    </button>
  );
}

function SectionCard({ icon: Icon, title, desc, children }) {
  return (
    <section className="glass rounded-2xl p-4 md:p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-300">
          <Icon size={18} />
        </div>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-white">{title}</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">{desc}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function ResultPane({ result }) {
  const recallBlock = useMemo(() => {
    if (!result?.ok) return '';
    const data = result?.data;
    if (!Array.isArray(data?.items)) return '';
    return formatRecallBlock(data.items, Number.isFinite(data?.items?.[0]?.score_display) ? undefined : 2);
  }, [result]);

  const requestText = useMemo(() => {
    if (!result?.request) return '';
    return JSON.stringify(result.request, null, 2);
  }, [result]);

  const responseText = useMemo(() => {
    if (!result) return '';
    const payload = result.ok ? result.data : result.error;
    if (typeof payload === 'string') return payload;
    return JSON.stringify(payload, null, 2);
  }, [result]);

  return (
    <div className="glass sticky top-20 rounded-2xl overflow-hidden">
      <div className="border-b border-white/8 px-4 py-3 md:px-5">
        <div className="flex items-center gap-2">
          <div className={clsx('h-2.5 w-2.5 rounded-full', result ? (result.ok ? 'bg-emerald-400' : 'bg-rose-400') : 'bg-zinc-600')} />
          <h2 className="text-[13px] font-semibold text-white">Result</h2>
        </div>
        {result ? (
          <div className="mt-2 space-y-1 text-[11px] text-zinc-500">
            <div>{result.label}</div>
            <div>{result.durationMs} ms</div>
          </div>
        ) : (
          <p className="mt-2 text-[12px] text-zinc-500">Run an action on the left. Response JSON and recall preview show up here.</p>
        )}
      </div>

      <div className="max-h-[calc(100vh-9rem)] overflow-y-auto p-4 md:p-5">
        {result ? (
          <div className="space-y-4">
            {recallBlock ? (
              <div className="rounded-2xl border border-violet-500/15 bg-violet-500/[0.06] p-4">
                <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-violet-300">
                  <Radar size={13} />
                  Recall block preview
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap text-[12px] leading-relaxed text-violet-100">{recallBlock}</pre>
              </div>
            ) : null}

            {requestText ? (
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Request</div>
                <pre className="overflow-x-auto rounded-2xl border border-white/8 bg-black/30 p-4 text-[12px] leading-relaxed text-zinc-300">{requestText}</pre>
              </div>
            ) : null}

            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                {result.ok ? 'Response' : 'Error'}
              </div>
              <pre
                className={clsx(
                  'overflow-x-auto rounded-2xl border p-4 text-[12px] leading-relaxed',
                  result.ok
                    ? 'border-white/8 bg-black/30 text-zinc-300'
                    : 'border-rose-500/15 bg-rose-500/[0.06] text-rose-200',
                )}
              >
                {responseText}
              </pre>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function PluginLabPage() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [ready, setReady] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        setForm((prev) => ({ ...prev, ...parsed }));
      }
    } catch {
      // ignore corrupted local state
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
  }, [form, ready]);

  const patch = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  async function runAction({ label, request, run, onSuccess }) {
    const requestMeta = typeof request === 'function' ? request() : request;
    const started = performance.now();
    setBusyLabel(label);
    try {
      const data = await run();
      const durationMs = Math.round(performance.now() - started);
      setResult({ ok: true, label, durationMs, request: requestMeta, data });
      onSuccess?.(data);
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      setResult({
        ok: false,
        label,
        durationMs,
        request: requestMeta,
        error: error?.response?.data || error?.message || 'Unknown error',
      });
    } finally {
      setBusyLabel('');
    }
  }

  const recallEmbedding = {
    base_url: form.recallEmbeddingBaseUrl.trim(),
    api_key: form.recallEmbeddingApiKey,
    model: form.recallEmbeddingModel.trim(),
    timeout_ms: asNumber(form.recallEmbeddingTimeoutMs, 30000),
  };

  const runGetNode = () =>
    runAction({
      label: 'Get node',
      request: () => ({
        method: 'GET',
        path: '/browse/node',
        params: {
          domain: form.domain,
          path: form.path,
          nav_only: form.navOnly,
        },
      }),
      run: async () => {
        const { data } = await api.get('/browse/node', {
          params: { domain: form.domain, path: form.path, nav_only: form.navOnly },
        });
        return data;
      },
      onSuccess: (data) => {
        const node = data?.node;
        if (!node) return;
        setForm((prev) => ({
          ...prev,
          sessionUri: node.uri || prev.sessionUri,
          sessionNodeUuid: node.node_uuid || prev.sessionNodeUuid,
          glossaryNodeUuid: node.node_uuid || prev.glossaryNodeUuid,
          reviewNodeUuid: node.node_uuid || prev.reviewNodeUuid,
          triggerUri: node.uri || prev.triggerUri,
          updateDomain: node.domain || prev.updateDomain,
          updatePath: node.path ?? prev.updatePath,
          updatePriority: node.priority ?? prev.updatePriority,
          updateDisclosure: node.disclosure || '',
          updateContent: node.content || '',
          deleteDomain: node.domain || prev.deleteDomain,
          deletePath: node.path ?? prev.deletePath,
        }));
      },
    });

  const quickActions = [
    {
      label: 'Status',
      tone: 'accent',
      run: () =>
        runAction({
          label: 'Status',
          request: { method: 'GET', path: '/health' },
          run: async () => (await api.get('/health')).data,
        }),
    },
    {
      label: 'Boot',
      run: () =>
        runAction({
          label: 'Boot',
          request: { method: 'GET', path: '/browse/boot' },
          run: async () => (await api.get('/browse/boot')).data,
        }),
    },
    {
      label: 'Domains',
      run: () =>
        runAction({
          label: 'Domains',
          request: { method: 'GET', path: '/browse/domains' },
          run: async () => (await api.get('/browse/domains')).data,
        }),
    },
    {
      label: 'Glossary',
      run: () =>
        runAction({
          label: 'Glossary',
          request: { method: 'GET', path: '/browse/glossary' },
          run: async () => (await api.get('/browse/glossary')).data,
        }),
    },
    {
      label: 'Review groups',
      run: () =>
        runAction({
          label: 'Review groups',
          request: { method: 'GET', path: '/review/groups' },
          run: async () => (await api.get('/review/groups')).data,
        }),
    },
    {
      label: 'Orphans',
      run: () =>
        runAction({
          label: 'Orphans',
          request: { method: 'GET', path: '/maintenance/orphans' },
          run: async () => (await api.get('/maintenance/orphans')).data,
        }),
    },
  ];

  return (
    <div className="h-full overflow-y-auto px-4 py-5 md:px-6 md:py-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <section className="glass rounded-3xl p-5 md:p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="max-w-2xl">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-violet-500/15 bg-violet-500/[0.07] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-300">
                <FlaskConical size={12} />
                Plugin Lab
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">Nocturne plugin playground</h1>
              <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-zinc-400">
                一个独立测试页。把 plugin 对应的主要能力都收进来了。包括 recall、session read、review、maintenance，方便直接点接口看返回。
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 md:w-[360px]">
              {quickActions.map((action) => (
                <ActionButton
                  key={action.label}
                  label={action.label}
                  tone={action.tone}
                  busy={busyLabel === action.label}
                  onClick={action.run}
                />
              ))}
            </div>
          </div>
        </section>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
          <div className="space-y-5">
            <SectionCard icon={BookOpen} title="Read tools" desc="测试 read / search / domain / node 这些只读能力。">
              <div className="grid gap-4 md:grid-cols-2">
                <Input label="Domain" value={form.domain} onChange={(v) => patch('domain', v)} placeholder="core" mono />
                <Input label="Path" value={form.path} onChange={(v) => patch('path', v)} placeholder="agent/my_user" mono />
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                <Checkbox
                  label="nav_only"
                  checked={form.navOnly}
                  onChange={(v) => patch('navOnly', v)}
                  help="跳过 glossary 匹配，适合只看树结构时测试。"
                />
                <ActionButton label="Get node" tone="accent" busy={busyLabel === 'Get node'} onClick={runGetNode} />
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-[minmax(0,1fr)_180px_120px_auto] md:items-end">
                <Input label="Search query" value={form.searchQuery} onChange={(v) => patch('searchQuery', v)} placeholder="OpenClaw" />
                <Input label="Domain filter" value={form.searchDomain} onChange={(v) => patch('searchDomain', v)} placeholder="optional" mono />
                <Input label="Limit" type="number" value={form.searchLimit} onChange={(v) => patch('searchLimit', v)} />
                <ActionButton
                  label="Search"
                  busy={busyLabel === 'Search'}
                  onClick={() =>
                    runAction({
                      label: 'Search',
                      request: () => ({
                        method: 'GET',
                        path: '/browse/search',
                        params: {
                          query: form.searchQuery,
                          domain: form.searchDomain || undefined,
                          limit: asNumber(form.searchLimit, 10),
                        },
                      }),
                      run: async () => {
                        const { data } = await api.get('/browse/search', {
                          params: {
                            query: form.searchQuery,
                            domain: form.searchDomain || undefined,
                            limit: asNumber(form.searchLimit, 10),
                          },
                        });
                        return data;
                      },
                    })
                  }
                />
              </div>
            </SectionCard>

            <SectionCard icon={Database} title="Node mutations" desc="创建、更新、删除节点。这里直接对 browse API 打。">
              <div className="grid gap-5 lg:grid-cols-2">
                <div className="space-y-4 rounded-2xl border border-white/8 bg-black/15 p-4">
                  <div className="text-[12px] font-medium text-white">Create node</div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Input label="Domain" value={form.createDomain} onChange={(v) => patch('createDomain', v)} placeholder="core" mono />
                    <Input label="Parent path" value={form.createParentPath} onChange={(v) => patch('createParentPath', v)} placeholder="project/nocturne" mono />
                    <Input label="Title" value={form.createTitle} onChange={(v) => patch('createTitle', v)} placeholder="plugin-lab-demo" mono />
                    <Input label="Priority" type="number" value={form.createPriority} onChange={(v) => patch('createPriority', v)} />
                  </div>
                  <Input label="Disclosure" value={form.createDisclosure} onChange={(v) => patch('createDisclosure', v)} placeholder="When testing plugin UI" />
                  <TextArea label="Content" value={form.createContent} onChange={(v) => patch('createContent', v)} placeholder="Write memory content..." rows={6} />
                  <ActionButton
                    label="Create"
                    tone="accent"
                    busy={busyLabel === 'Create node'}
                    onClick={() =>
                      runAction({
                        label: 'Create node',
                        request: () => ({
                          method: 'POST',
                          path: '/browse/node',
                          body: {
                            domain: form.createDomain,
                            parent_path: form.createParentPath,
                            title: form.createTitle || undefined,
                            priority: asNumber(form.createPriority, 0),
                            disclosure: form.createDisclosure || undefined,
                            content: form.createContent,
                          },
                        }),
                        run: async () => {
                          const body = {
                            domain: form.createDomain,
                            parent_path: form.createParentPath,
                            title: form.createTitle || undefined,
                            priority: asNumber(form.createPriority, 0),
                            disclosure: form.createDisclosure || undefined,
                            content: form.createContent,
                          };
                          return (await api.post('/browse/node', body)).data;
                        },
                      })
                    }
                  />
                </div>

                <div className="space-y-4 rounded-2xl border border-white/8 bg-black/15 p-4">
                  <div className="text-[12px] font-medium text-white">Update / delete node</div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Input label="Domain" value={form.updateDomain} onChange={(v) => patch('updateDomain', v)} placeholder="core" mono />
                    <Input label="Path" value={form.updatePath} onChange={(v) => patch('updatePath', v)} placeholder="project/nocturne/demo" mono />
                    <Input label="Priority" type="number" value={form.updatePriority} onChange={(v) => patch('updatePriority', v)} />
                    <Input label="Delete domain" value={form.deleteDomain} onChange={(v) => patch('deleteDomain', v)} placeholder="core" mono />
                  </div>
                  <Input label="Disclosure" value={form.updateDisclosure} onChange={(v) => patch('updateDisclosure', v)} placeholder="Optional" />
                  <TextArea label="Content" value={form.updateContent} onChange={(v) => patch('updateContent', v)} placeholder="Updated content..." rows={6} />
                  <Input label="Delete path" value={form.deletePath} onChange={(v) => patch('deletePath', v)} placeholder="project/nocturne/demo" mono />
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      label="Update"
                      tone="accent"
                      busy={busyLabel === 'Update node'}
                      onClick={() =>
                        runAction({
                          label: 'Update node',
                          request: () => ({
                            method: 'PUT',
                            path: '/browse/node',
                            params: { domain: form.updateDomain, path: form.updatePath },
                            body: {
                              priority: asNumber(form.updatePriority, 0),
                              disclosure: form.updateDisclosure,
                              content: form.updateContent,
                            },
                          }),
                          run: async () => {
                            const body = {
                              priority: asNumber(form.updatePriority, 0),
                              disclosure: form.updateDisclosure,
                              content: form.updateContent,
                            };
                            return (
                              await api.put('/browse/node', body, {
                                params: { domain: form.updateDomain, path: form.updatePath },
                              })
                            ).data;
                          },
                        })
                      }
                    />
                    <ActionButton
                      label="Delete"
                      tone="danger"
                      busy={busyLabel === 'Delete node'}
                      onClick={() =>
                        runAction({
                          label: 'Delete node',
                          request: () => ({
                            method: 'DELETE',
                            path: '/browse/node',
                            params: { domain: form.deleteDomain, path: form.deletePath },
                          }),
                          run: async () => {
                            return (
                              await api.delete('/browse/node', {
                                params: { domain: form.deleteDomain, path: form.deletePath },
                              })
                            ).data;
                          },
                        })
                      }
                    />
                  </div>
                </div>
              </div>
            </SectionCard>

            <SectionCard icon={Link2} title="Alias / triggers / glossary" desc="把 alias、trigger、glossary 相关操作放到一页里。">
              <div className="grid gap-5 lg:grid-cols-3">
                <div className="space-y-4 rounded-2xl border border-white/8 bg-black/15 p-4">
                  <div className="text-[12px] font-medium text-white">Add alias</div>
                  <Input label="New URI" value={form.aliasNewUri} onChange={(v) => patch('aliasNewUri', v)} placeholder="project://demo/alias" mono />
                  <Input label="Target URI" value={form.aliasTargetUri} onChange={(v) => patch('aliasTargetUri', v)} placeholder="core://agent" mono />
                  <Input label="Priority" type="number" value={form.aliasPriority} onChange={(v) => patch('aliasPriority', v)} />
                  <Input label="Disclosure" value={form.aliasDisclosure} onChange={(v) => patch('aliasDisclosure', v)} placeholder="Optional" />
                  <ActionButton
                    label="Add alias"
                    busy={busyLabel === 'Add alias'}
                    onClick={() =>
                      runAction({
                        label: 'Add alias',
                        request: () => ({
                          method: 'POST',
                          path: '/browse/alias',
                          body: {
                            new_uri: form.aliasNewUri,
                            target_uri: form.aliasTargetUri,
                            priority: asNumber(form.aliasPriority, 0),
                            disclosure: form.aliasDisclosure || undefined,
                          },
                        }),
                        run: async () => {
                          const body = {
                            new_uri: form.aliasNewUri,
                            target_uri: form.aliasTargetUri,
                            priority: asNumber(form.aliasPriority, 0),
                            disclosure: form.aliasDisclosure || undefined,
                          };
                          return (await api.post('/browse/alias', body)).data;
                        },
                      })
                    }
                  />
                </div>

                <div className="space-y-4 rounded-2xl border border-white/8 bg-black/15 p-4">
                  <div className="text-[12px] font-medium text-white">Manage triggers</div>
                  <Input label="URI" value={form.triggerUri} onChange={(v) => patch('triggerUri', v)} placeholder="core://agent" mono />
                  <TextArea label="Add triggers" value={form.triggerAdd} onChange={(v) => patch('triggerAdd', v)} placeholder="one\nper line\nor comma,separated" rows={4} mono />
                  <TextArea label="Remove triggers" value={form.triggerRemove} onChange={(v) => patch('triggerRemove', v)} placeholder="keyword-a, keyword-b" rows={4} mono />
                  <ActionButton
                    label="Update triggers"
                    busy={busyLabel === 'Manage triggers'}
                    onClick={() =>
                      runAction({
                        label: 'Manage triggers',
                        request: () => ({
                          method: 'POST',
                          path: '/browse/triggers',
                          body: {
                            uri: form.triggerUri,
                            add: splitTokens(form.triggerAdd),
                            remove: splitTokens(form.triggerRemove),
                          },
                        }),
                        run: async () => {
                          const body = {
                            uri: form.triggerUri,
                            add: splitTokens(form.triggerAdd),
                            remove: splitTokens(form.triggerRemove),
                          };
                          return (await api.post('/browse/triggers', body)).data;
                        },
                      })
                    }
                  />
                </div>

                <div className="space-y-4 rounded-2xl border border-white/8 bg-black/15 p-4">
                  <div className="text-[12px] font-medium text-white">Glossary mutate</div>
                  <Input label="Keyword" value={form.glossaryKeyword} onChange={(v) => patch('glossaryKeyword', v)} placeholder="OpenClaw" mono />
                  <Input label="Node UUID" value={form.glossaryNodeUuid} onChange={(v) => patch('glossaryNodeUuid', v)} placeholder="uuid" mono />
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      label="Add glossary"
                      busy={busyLabel === 'Add glossary'}
                      onClick={() =>
                        runAction({
                          label: 'Add glossary',
                          request: () => ({
                            method: 'POST',
                            path: '/browse/glossary',
                            body: { keyword: form.glossaryKeyword, node_uuid: form.glossaryNodeUuid },
                          }),
                          run: async () => {
                            return (
                              await api.post('/browse/glossary', {
                                keyword: form.glossaryKeyword,
                                node_uuid: form.glossaryNodeUuid,
                              })
                            ).data;
                          },
                        })
                      }
                    />
                    <ActionButton
                      label="Remove glossary"
                      tone="danger"
                      busy={busyLabel === 'Remove glossary'}
                      onClick={() =>
                        runAction({
                          label: 'Remove glossary',
                          request: () => ({
                            method: 'DELETE',
                            path: '/browse/glossary',
                            body: { keyword: form.glossaryKeyword, node_uuid: form.glossaryNodeUuid },
                          }),
                          run: async () => {
                            return (
                              await api.delete('/browse/glossary', {
                                data: {
                                  keyword: form.glossaryKeyword,
                                  node_uuid: form.glossaryNodeUuid,
                                },
                              })
                            ).data;
                          },
                        })
                      }
                    />
                  </div>
                </div>
              </div>
            </SectionCard>

            <SectionCard icon={Sparkles} title="Session reads / review / maintenance" desc="调 recall 相关的 session read，顺手把 review 和 orphan 也放在这里。">
              <div className="grid gap-5 lg:grid-cols-3">
                <div className="space-y-4 rounded-2xl border border-white/8 bg-black/15 p-4">
                  <div className="text-[12px] font-medium text-white">Session reads</div>
                  <Input label="Session ID" value={form.sessionId} onChange={(v) => patch('sessionId', v)} placeholder="plugin-lab-demo" mono />
                  <Input label="Session key" value={form.sessionKey} onChange={(v) => patch('sessionKey', v)} placeholder="optional" mono />
                  <Input label="URI" value={form.sessionUri} onChange={(v) => patch('sessionUri', v)} placeholder={toUri(form.domain, form.path)} mono />
                  <Input label="Node UUID" value={form.sessionNodeUuid} onChange={(v) => patch('sessionNodeUuid', v)} placeholder="optional" mono />
                  <Input label="Source" value={form.sessionSource} onChange={(v) => patch('sessionSource', v)} placeholder="ui:plugin-lab" mono />
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      label="Mark read"
                      busy={busyLabel === 'Mark session read'}
                      onClick={() =>
                        runAction({
                          label: 'Mark session read',
                          request: () => ({
                            method: 'POST',
                            path: '/browse/session/read',
                            body: {
                              session_id: form.sessionId,
                              session_key: form.sessionKey || undefined,
                              uri: form.sessionUri || toUri(form.domain, form.path),
                              node_uuid: form.sessionNodeUuid || undefined,
                              source: form.sessionSource,
                            },
                          }),
                          run: async () => {
                            const body = {
                              session_id: form.sessionId,
                              session_key: form.sessionKey || undefined,
                              uri: form.sessionUri || toUri(form.domain, form.path),
                              node_uuid: form.sessionNodeUuid || undefined,
                              source: form.sessionSource,
                            };
                            return (await api.post('/browse/session/read', body)).data;
                          },
                        })
                      }
                    />
                    <ActionButton
                      label="List reads"
                      busy={busyLabel === 'List session reads'}
                      onClick={() =>
                        runAction({
                          label: 'List session reads',
                          request: () => ({
                            method: 'GET',
                            path: '/browse/session/read',
                            params: { session_id: form.sessionId },
                          }),
                          run: async () => {
                            return (
                              await api.get('/browse/session/read', { params: { session_id: form.sessionId } })
                            ).data;
                          },
                        })
                      }
                    />
                    <ActionButton
                      label="Clear reads"
                      tone="danger"
                      busy={busyLabel === 'Clear session reads'}
                      onClick={() =>
                        runAction({
                          label: 'Clear session reads',
                          request: () => ({
                            method: 'DELETE',
                            path: '/browse/session/read',
                            params: { session_id: form.sessionId },
                          }),
                          run: async () => {
                            return (
                              await api.delete('/browse/session/read', { params: { session_id: form.sessionId } })
                            ).data;
                          },
                        })
                      }
                    />
                  </div>
                </div>

                <div className="space-y-4 rounded-2xl border border-white/8 bg-black/15 p-4">
                  <div className="text-[12px] font-medium text-white">Review</div>
                  <Input label="Node UUID" value={form.reviewNodeUuid} onChange={(v) => patch('reviewNodeUuid', v)} placeholder="uuid" mono />
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      label="List groups"
                      busy={busyLabel === 'Review groups'}
                      onClick={() =>
                        runAction({
                          label: 'Review groups',
                          request: { method: 'GET', path: '/review/groups' },
                          run: async () => (await api.get('/review/groups')).data,
                        })
                      }
                    />
                    <ActionButton
                      label="Diff"
                      busy={busyLabel === 'Review diff'}
                      onClick={() =>
                        runAction({
                          label: 'Review diff',
                          request: () => ({
                            method: 'GET',
                            path: `/review/groups/${encodeURIComponent(form.reviewNodeUuid)}/diff`,
                          }),
                          run: async () => (await api.get(`/review/groups/${encodeURIComponent(form.reviewNodeUuid)}/diff`)).data,
                        })
                      }
                    />
                    <ActionButton
                      label="Rollback"
                      tone="danger"
                      busy={busyLabel === 'Rollback review group'}
                      onClick={() =>
                        runAction({
                          label: 'Rollback review group',
                          request: () => ({
                            method: 'POST',
                            path: `/review/groups/${encodeURIComponent(form.reviewNodeUuid)}/rollback`,
                            body: {},
                          }),
                          run: async () => (await api.post(`/review/groups/${encodeURIComponent(form.reviewNodeUuid)}/rollback`, {})).data,
                        })
                      }
                    />
                  </div>
                </div>

                <div className="space-y-4 rounded-2xl border border-white/8 bg-black/15 p-4">
                  <div className="text-[12px] font-medium text-white">Maintenance</div>
                  <Input label="Orphan memory ID" value={form.orphanId} onChange={(v) => patch('orphanId', v)} placeholder="123" mono />
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      label="List orphans"
                      busy={busyLabel === 'Orphans'}
                      onClick={() =>
                        runAction({
                          label: 'Orphans',
                          request: { method: 'GET', path: '/maintenance/orphans' },
                          run: async () => (await api.get('/maintenance/orphans')).data,
                        })
                      }
                    />
                    <ActionButton
                      label="Get orphan"
                      busy={busyLabel === 'Get orphan'}
                      onClick={() =>
                        runAction({
                          label: 'Get orphan',
                          request: () => ({ method: 'GET', path: `/maintenance/orphans/${form.orphanId}` }),
                          run: async () => (await api.get(`/maintenance/orphans/${form.orphanId}`)).data,
                        })
                      }
                    />
                    <ActionButton
                      label="Delete orphan"
                      tone="danger"
                      busy={busyLabel === 'Delete orphan'}
                      onClick={() =>
                        runAction({
                          label: 'Delete orphan',
                          request: () => ({ method: 'DELETE', path: `/maintenance/orphans/${form.orphanId}` }),
                          run: async () => (await api.delete(`/maintenance/orphans/${form.orphanId}`)).data,
                        })
                      }
                    />
                  </div>
                </div>
              </div>
            </SectionCard>

            <SectionCard icon={Radar} title="Recall" desc="这里按 plugin 的 recall 形态直接测。右边会额外生成 <recall> block 预览。">
              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_140px_140px]">
                <TextArea label="Query" value={form.recallQuery} onChange={(v) => patch('recallQuery', v)} placeholder="继续 Nocturne 接入、确认当前架构，或判断是否需要回滚" rows={4} />
                <Input label="Limit" type="number" value={form.recallLimit} onChange={(v) => patch('recallLimit', v)} />
                <Input label="Min score" type="number" value={form.recallMinScore} onChange={(v) => patch('recallMinScore', v)} />
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Input label="Embedding base URL" value={form.recallEmbeddingBaseUrl} onChange={(v) => patch('recallEmbeddingBaseUrl', v)} placeholder="http://127.0.0.1:8090/v1" mono />
                <Input label="Embedding model" value={form.recallEmbeddingModel} onChange={(v) => patch('recallEmbeddingModel', v)} placeholder="text-embedding-3-small" mono />
                <Input label="Embedding API key" value={form.recallEmbeddingApiKey} onChange={(v) => patch('recallEmbeddingApiKey', v)} placeholder="local only" mono />
                <Input label="Timeout ms" type="number" value={form.recallEmbeddingTimeoutMs} onChange={(v) => patch('recallEmbeddingTimeoutMs', v)} />
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-5">
                <Input label="Max display items" type="number" value={form.recallMaxDisplayItems} onChange={(v) => patch('recallMaxDisplayItems', v)} />
                <Input label="Min display score" type="number" value={form.recallMinDisplayScore} onChange={(v) => patch('recallMinDisplayScore', v)} />
                <Input label="Score precision" type="number" value={form.recallScorePrecision} onChange={(v) => patch('recallScorePrecision', v)} />
                <Input label="Session ID" value={form.sessionId} onChange={(v) => patch('sessionId', v)} placeholder="plugin-lab-demo" mono />
                <Select
                  label="Read mode"
                  value={form.recallReadNodeDisplayMode}
                  onChange={(v) => patch('recallReadNodeDisplayMode', v)}
                  options={[
                    { value: 'soft', label: 'soft' },
                    { value: 'hard', label: 'hard' },
                  ]}
                />
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
                <Checkbox
                  label="Exclude boot nodes"
                  checked={form.recallExcludeBoot}
                  onChange={(v) => patch('recallExcludeBoot', v)}
                  help="和 plugin 一样，默认不把 boot core memories 混进 recall 结果。"
                />
                <ActionButton
                  label="Recall"
                  tone="accent"
                  busy={busyLabel === 'Recall'}
                  onClick={() =>
                    runAction({
                      label: 'Recall',
                      request: () => ({
                        method: 'POST',
                        path: '/browse/recall',
                        body: {
                          query: form.recallQuery,
                          session_id: form.sessionId || undefined,
                          limit: asNumber(form.recallLimit, 12),
                          min_score: asNumber(form.recallMinScore, 0),
                          max_display_items: asNumber(form.recallMaxDisplayItems, 3),
                          min_display_score: asNumber(form.recallMinDisplayScore, 0.6),
                          score_precision: asNumber(form.recallScorePrecision, 2),
                          exclude_boot_from_results: form.recallExcludeBoot,
                          read_node_display_mode: form.recallReadNodeDisplayMode,
                          embedding: recallEmbedding,
                        },
                      }),
                      run: async () => {
                        const body = {
                          query: form.recallQuery,
                          session_id: form.sessionId || undefined,
                          limit: asNumber(form.recallLimit, 12),
                          min_score: asNumber(form.recallMinScore, 0),
                          max_display_items: asNumber(form.recallMaxDisplayItems, 3),
                          min_display_score: asNumber(form.recallMinDisplayScore, 0.6),
                          score_precision: asNumber(form.recallScorePrecision, 2),
                          exclude_boot_from_results: form.recallExcludeBoot,
                          read_node_display_mode: form.recallReadNodeDisplayMode,
                          embedding: recallEmbedding,
                        };
                        return (await api.post('/browse/recall', body)).data;
                      },
                    })
                  }
                />
                <ActionButton
                  label="Rebuild index"
                  busy={busyLabel === 'Rebuild recall index'}
                  onClick={() =>
                    runAction({
                      label: 'Rebuild recall index',
                      request: () => ({
                        method: 'POST',
                        path: '/browse/recall/rebuild',
                        body: recallEmbedding,
                      }),
                      run: async () => (await api.post('/browse/recall/rebuild', recallEmbedding)).data,
                    })
                  }
                />
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
                embedding 配置只保存在浏览器 localStorage，不会写进仓库。这个页主要是把 plugin 的调用面一次性摸全。
              </p>
            </SectionCard>
          </div>

          <ResultPane result={result} />
        </div>
      </div>
    </div>
  );
}
