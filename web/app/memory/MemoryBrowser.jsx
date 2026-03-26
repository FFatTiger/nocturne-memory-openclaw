'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Folder,
  FileText,
  Edit3,
  Save,
  X,
  AlertTriangle,
  Link2,
  ChevronRight,
  PanelLeftOpen,
  PanelLeftClose,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import PriorityBadge from './components/PriorityBadge';
import KeywordManager from './components/KeywordManager';
import DomainNode from './components/MemorySidebar';
import GlossaryHighlighter from './components/GlossaryHighlighter';

function SkeletonLine({ w = '100%' }) {
  return <div className="h-3 rounded-md skeleton" style={{ width: w }} />;
}

export default function MemoryBrowser() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const domain = searchParams.get('domain') || 'core';
  const path = searchParams.get('path') || '';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState({ node: null, children: [], breadcrumbs: [] });
  const [domains, setDomains] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editDisclosure, setEditDisclosure] = useState('');
  const [editPriority, setEditPriority] = useState(0);
  const [saving, setSaving] = useState(false);

  const currentRouteRef = useRef({ domain, path });
  useEffect(() => {
    currentRouteRef.current = { domain, path };
  }, [domain, path]);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth >= 768) {
      setSidebarOpen(true);
    }
  }, []);

  useEffect(() => {
    api.get('/browse/domains').then((r) => setDomains(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      setEditing(false);
      try {
        const res = await api.get('/browse/node', { params: { domain, path } });
        setData(res.data);
        setEditContent(res.data.node?.content || '');
        setEditDisclosure(res.data.node?.disclosure || '');
        setEditPriority(res.data.node?.priority ?? 0);
      } catch (err) {
        setError(err.response?.data?.detail || err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [domain, path]);

  const navigateTo = useCallback(
    (newPath, newDomain) => {
      const params = new URLSearchParams();
      params.set('domain', newDomain || domain);
      if (newPath) params.set('path', newPath);
      router.push(`/memory?${params.toString()}`);
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        setSidebarOpen(false);
      }
    },
    [domain, router],
  );

  const refreshData = () =>
    api.get('/browse/node', { params: { domain, path } }).then((res) => {
      setData((cd) =>
        currentRouteRef.current.domain === domain && currentRouteRef.current.path === path ? res.data : cd,
      );
    });

  const startEditing = () => {
    setEditContent(data.node?.content || '');
    setEditDisclosure(data.node?.disclosure || '');
    setEditPriority(data.node?.priority ?? 0);
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {};
      if (editContent !== (data.node?.content || '')) payload.content = editContent;
      if (editPriority !== (data.node?.priority ?? 0)) payload.priority = editPriority;
      if (editDisclosure !== (data.node?.disclosure || '')) payload.disclosure = editDisclosure;
      if (!Object.keys(payload).length) {
        setEditing(false);
        return;
      }
      await api.put('/browse/node', payload, { params: { domain, path } });
      await refreshData();
      setEditing(false);
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const isRoot = !path;
  const node = data.node;

  const breadcrumb = (
    <div className="flex min-w-0 items-center gap-1 text-[12px]">
      {data.breadcrumbs.map((crumb, i) => (
        <React.Fragment key={crumb.path}>
          {i > 0 && <ChevronRight size={11} className="flex-shrink-0 text-zinc-500" />}
          <button
            onClick={() => navigateTo(crumb.path)}
            className={clsx(
              'rounded-md px-1.5 py-0.5 whitespace-nowrap transition-colors',
              i === data.breadcrumbs.length - 1
                ? 'font-medium text-zinc-200'
                : 'text-zinc-400 hover:text-zinc-200',
            )}
          >
            {crumb.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );

  const sidebar = (
    <div
      className={clsx(
        'sidebar-panel h-full flex flex-col overflow-hidden transition-all duration-200',
        sidebarOpen ? 'w-[86vw] md:w-72' : 'w-0',
      )}
    >
      <div className="border-b border-white/5 px-4 pt-4 pb-3 flex-shrink-0">
        <h2 className="sidebar-section-title">Domains</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-2.5">
        {domains.map((d) => (
          <DomainNode
            key={d.domain}
            domain={d.domain}
            rootCount={d.root_count}
            activeDomain={domain}
            activePath={path}
            onNavigate={navigateTo}
          />
        ))}
        {domains.length === 0 && (
          <DomainNode domain="core" activeDomain={domain} activePath={path} onNavigate={navigateTo} />
        )}
      </div>
      <div className="border-t border-white/5 p-3 flex-shrink-0">
        <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-zinc-500">Current Path</div>
        <code className="block break-all rounded-md bg-zinc-900/70 px-2.5 py-2 text-[11px] font-mono text-zinc-300">
          {domain}://{path || 'root'}
        </code>
      </div>
    </div>
  );

  return (
    <div className="flex h-full bg-[#0d0d10] text-zinc-300">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div
        className={clsx(
          'fixed top-0 left-0 bottom-0 z-40 transition-transform duration-200 md:relative md:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        )}
      >
        {sidebar}
      </div>

      <div className="flex-1 min-w-0 flex flex-col h-full bg-[#0d0d10]">
        <div className="sticky top-0 z-20 flex flex-shrink-0 items-center gap-3 border-b border-white/4 bg-[#0d0d10] px-5 py-3">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-200"
            aria-label={sidebarOpen ? 'Close memory map' : 'Open memory map'}
          >
            {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>

          {breadcrumb}

          {node && !editing && (
            <button
              onClick={startEditing}
              className="ml-auto hidden md:inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-zinc-900/50 px-3 py-1.5 text-[12px] text-zinc-300 hover:border-white/20 hover:bg-zinc-800/60 hover:text-white"
            >
              <Edit3 size={13} /> Edit
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="mx-auto max-w-4xl px-6 py-12 md:px-10 space-y-6">
              <SkeletonLine w="60%" />
              <SkeletonLine w="40%" />
              <div className="space-y-3 pt-6">
                <SkeletonLine />
                <SkeletonLine w="90%" />
                <SkeletonLine w="75%" />
                <SkeletonLine w="95%" />
                <SkeletonLine w="60%" />
              </div>
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-rose-400">
              <p className="text-base font-medium text-white">Error</p>
              <p className="text-[13px] text-zinc-400">{error}</p>
              <button
                onClick={() => navigateTo('', domain)}
                className="mt-2 rounded-lg border border-white/10 bg-zinc-900/60 px-4 py-2 text-[12px] text-zinc-300 hover:bg-zinc-800/70"
              >
                Return to root
              </button>
            </div>
          ) : (
            <div className="mx-auto max-w-4xl px-4 py-6 md:px-10 md:py-10">
              {node && (!isRoot || !node.is_virtual || editing) && (
                <div className="mb-12">
                  <div className="mb-5 flex items-start gap-3">
                    <h1 className="text-2xl font-bold leading-tight tracking-tight text-zinc-100 md:text-3xl">
                      {node.name || path.split('/').pop()}
                    </h1>
                    {!editing && <PriorityBadge priority={node.priority} size="lg" />}
                  </div>

                  {node.disclosure && !editing && (
                    <div className="disclosure-box mb-5 max-w-2xl">
                      <AlertTriangle size={14} />
                      <span>
                        <span className="mr-1 font-medium text-yellow-400">Disclosure:</span>
                        <span className="italic text-yellow-200/90">{node.disclosure}</span>
                      </span>
                    </div>
                  )}

                  {node.aliases?.length > 0 && !editing && (
                    <div className="mb-5 flex items-start gap-2 text-[12px] text-zinc-400">
                      <Link2 size={12} className="mt-0.5 flex-shrink-0 text-zinc-500" />
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-zinc-400">Also reachable via</span>
                        {node.aliases.map((a) => (
                          <code
                            key={a}
                            className="rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[11px] font-mono text-blue-400"
                          >
                            {a}
                          </code>
                        ))}
                      </div>
                    </div>
                  )}

                  {!editing && !node.is_virtual && (
                    <div className="mb-7">
                      <KeywordManager
                        keywords={node.glossary_keywords || []}
                        nodeUuid={node.node_uuid}
                        onUpdate={refreshData}
                      />
                    </div>
                  )}

                  {editing && (
                    <div className="mb-6 space-y-4 rounded-2xl border border-white/10 bg-zinc-900/40 p-4 md:p-5">
                      <div className="flex items-center justify-end flex-wrap gap-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setEditing(false)}
                            className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800/60 hover:text-white"
                          >
                            <X size={14} />
                          </button>
                          <button
                            onClick={handleSave}
                            disabled={saving}
                            className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-[12px] font-medium text-white hover:bg-violet-500 disabled:opacity-50"
                          >
                            <Save size={13} /> {saving ? 'Saving...' : 'Save'}
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                            Priority
                          </label>
                          <input
                            type="number"
                            min="0"
                            value={editPriority}
                            onChange={(e) => setEditPriority(parseInt(e.target.value, 10) || 0)}
                            className="w-full rounded-lg border border-white/10 bg-zinc-950 px-3 py-2 text-[13px] font-mono text-zinc-200 focus:border-violet-500/50 focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                            Disclosure
                          </label>
                          <input
                            type="text"
                            value={editDisclosure}
                            onChange={(e) => setEditDisclosure(e.target.value)}
                            placeholder="when to recall..."
                            className="w-full rounded-lg border border-white/10 bg-zinc-950 px-3 py-2 text-[13px] text-zinc-200 focus:border-violet-500/50 focus:outline-none"
                          />
                        </div>
                      </div>
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="h-80 w-full resize-y rounded-xl border border-white/10 bg-zinc-950 p-5 font-mono text-[13px] leading-relaxed text-zinc-200 focus:border-violet-500/50 focus:outline-none"
                        spellCheck={false}
                      />
                    </div>
                  )}

                  {!editing && node.content && (
                    <article className="prose prose-invert max-w-none leading-relaxed">
                      <GlossaryHighlighter
                        key={node.node_uuid}
                        content={node.content}
                        glossary={node.glossary_matches || []}
                        currentNodeUuid={node.node_uuid}
                        onNavigate={navigateTo}
                      />
                    </article>
                  )}
                </div>
              )}

              {data.children?.length > 0 && (
                <div className="space-y-4 pt-2">
                  <div className="mb-3 flex items-center gap-3">
                    <div className="h-px flex-1 bg-white/5" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-400">
                      {isRoot ? 'Clusters' : 'Children'}
                    </span>
                    <span className="rounded-full bg-zinc-900/70 px-2 py-0.5 text-[11px] text-zinc-400">
                      {data.children.length}
                    </span>
                    <div className="h-px flex-1 bg-white/5" />
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    {data.children.map((child) => (
                      <button
                        key={`${child.domain || domain}:${child.path}`}
                        onClick={() => navigateTo(child.path, child.domain)}
                        className="child-card group"
                      >
                        <div className="mt-0.5 flex-shrink-0 rounded-lg border border-white/10 bg-zinc-900/70 p-2 text-zinc-400 group-hover:border-white/15 group-hover:bg-zinc-800/70 group-hover:text-violet-300">
                          {child.approx_children_count > 0 ? <Folder size={15} /> : <FileText size={15} />}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="child-card-title">
                              {child.name || child.path.split('/').pop()}
                            </span>
                            {child.domain && child.domain !== domain && (
                              <span className="cross-domain-badge">{child.domain}</span>
                            )}
                            <PriorityBadge priority={child.priority} />
                          </div>

                          <p className="child-card-desc font-mono">{child.path}</p>

                          {child.disclosure && (
                            <p className="mt-1 line-clamp-2 text-[12px] italic text-yellow-500/90">
                              {child.disclosure}
                            </p>
                          )}

                          {child.content_snippet ? (
                            <p className="child-card-snippet">{child.content_snippet}</p>
                          ) : (
                            <p className="child-card-snippet italic text-zinc-500">Empty</p>
                          )}
                        </div>

                        <ChevronRight size={15} className="mt-1 flex-shrink-0 text-zinc-500 group-hover:text-zinc-300" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {!data.children?.length && !node && (
                <div className="flex flex-col items-center justify-center gap-2 py-20 text-zinc-500">
                  <Folder size={32} className="opacity-20" />
                  <p className="text-[13px]">Empty</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
