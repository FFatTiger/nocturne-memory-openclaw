'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Trash2, Sparkles, AlertTriangle, RefreshCw, ChevronDown, ChevronUp, ArrowRight, Unlink, Archive, CheckSquare, Square, PanelLeftOpen, PanelLeftClose } from 'lucide-react';
import { format } from 'date-fns';
import DiffViewer from '../../components/DiffViewer';
import { api } from '../../lib/api';
import clsx from 'clsx';

export default function MaintenancePage() {
  const [orphans, setOrphans] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [detailData, setDetailData] = useState({});
  const [detailLoading, setDetailLoading] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => { loadOrphans(); }, []);

  const loadOrphans = async () => {
    setLoading(true); setError(null); setSelectedIds(new Set());
    try { setOrphans((await api.get('/maintenance/orphans')).data); }
    catch (err) { setError("Failed: " + (err.response?.data?.detail || err.message)); }
    finally { setLoading(false); }
  };

  const toggleSelect = useCallback((id, e) => {
    e.stopPropagation();
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);

  const toggleSelectAll = useCallback((items) => {
    const ids = items.map(i => i.id);
    setSelectedIds(prev => { const n = new Set(prev); ids.every(id => n.has(id)) ? ids.forEach(id => n.delete(id)) : ids.forEach(id => n.add(id)); return n; });
  }, []);

  const handleBatchDelete = async () => {
    if (!selectedIds.size || !confirm(`Delete ${selectedIds.size} memories?`)) return;
    setBatchDeleting(true);
    const toDelete = [...selectedIds], failed = [];
    for (const id of toDelete) { try { await api.delete(`/maintenance/orphans/${id}`); } catch { failed.push(id); } }
    const fs = new Set(failed);
    setOrphans(prev => prev.filter(i => !toDelete.includes(i.id) || fs.has(i.id)));
    setSelectedIds(new Set(failed));
    if (expandedId && toDelete.includes(expandedId) && !fs.has(expandedId)) setExpandedId(null);
    setBatchDeleting(false);
  };

  const handleExpand = async (id) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    if (!detailData[id]) {
      setDetailLoading(id);
      try { const res = await api.get(`/maintenance/orphans/${id}`); setDetailData(p => ({ ...p, [id]: res.data })); }
      catch (err) { setDetailData(p => ({ ...p, [id]: { error: err.message } })); }
      finally { setDetailLoading(null); }
    }
  };

  const deprecated = orphans.filter(o => o.category === 'deprecated');
  const orphaned = orphans.filter(o => o.category === 'orphaned');

  const renderCard = (item) => {
    const isExpanded = expandedId === item.id;
    const detail = detailData[item.id];
    const isChecked = selectedIds.has(item.id);

    return (
      <div key={item.id} className="group glass rounded-xl overflow-hidden">
        <div className="flex items-start gap-3 p-4 cursor-pointer" onClick={() => handleExpand(item.id)}>
          <button onClick={(e) => toggleSelect(item.id, e)} className="mt-0.5 flex-shrink-0 text-slate-600 hover:text-slate-400">
            {isChecked ? <CheckSquare size={17} className="text-violet-400" /> : <Square size={17} />}
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1.5">
              <span className="text-[11px] font-mono text-slate-500">#{item.id}</span>
              {item.category === 'deprecated' ? (
                <span className="text-[10px] font-mono text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded"><Archive size={9} className="inline mr-1" />deprecated</span>
              ) : (
                <span className="text-[10px] font-mono text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded"><Unlink size={9} className="inline mr-1" />orphaned</span>
              )}
              <span className="text-[11px] text-slate-600">{item.created_at ? format(new Date(item.created_at), 'MM-dd HH:mm') : ''}</span>
            </div>
            {item.migration_target?.paths.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap mb-2">
                <ArrowRight size={11} className="text-violet-400/50" />
                {item.migration_target.paths.map((p, i) => <span key={i} className="text-[10px] font-mono text-violet-400/50 bg-violet-500/[0.06] px-1.5 py-0.5 rounded">{p}</span>)}
              </div>
            )}
            <div className="bg-white/[0.02] rounded-lg p-2.5 text-[12px] text-slate-500 font-mono leading-relaxed line-clamp-3">{item.content_snippet}</div>
          </div>
          <div className="text-slate-600">{isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</div>
        </div>
        {isExpanded && (
          <div className="border-t border-white/[0.04] p-5">
            {detailLoading === item.id ? (
              <div className="flex items-center gap-2 text-slate-500 py-3"><div className="w-3.5 h-3.5 border-2 border-violet-500/20 border-t-violet-500 rounded-full animate-spin" /><span className="text-[12px]">Loading...</span></div>
            ) : detail?.error ? (
              <div className="text-rose-400 text-[12px]">{detail.error}</div>
            ) : detail ? (
              <div className="space-y-4">
                <div>
                  <h4 className="text-[10px] uppercase tracking-widest text-slate-600 mb-2 font-semibold">Content</h4>
                  <div className="bg-black/30 rounded-lg p-4 border border-white/[0.04] text-[12px] text-slate-300 font-mono leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto">{detail.content}</div>
                </div>
                {detail.migration_target && (
                  <div>
                    <h4 className="text-[10px] uppercase tracking-widest text-slate-600 mb-2 font-semibold">Diff → #{detail.migration_target.id}</h4>
                    <div className="bg-black/30 rounded-lg border border-white/[0.04] p-4 max-h-96 overflow-y-auto">
                      <DiffViewer oldText={detail.content} newText={detail.migration_target.content} />
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full">
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm md:hidden" onClick={() => setSidebarOpen(false)} />}
      <div className={clsx("fixed top-0 left-0 bottom-0 z-40 md:relative md:z-auto transition-transform duration-200", sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0 md:w-0")}>
        <div className="h-full w-60 flex flex-col bg-[#0a0a0a] border-r border-white/[0.04] p-5">
          <div className="mb-5">
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center mb-3">
              <Sparkles className="text-amber-400" size={18} />
            </div>
            <h1 className="text-[15px] font-semibold text-white mb-1">Cleanup</h1>
            <p className="text-[12px] text-slate-500 leading-relaxed">Find and remove orphan memories.</p>
          </div>
          <div className="space-y-2.5 mt-auto">
            <div className="glass rounded-xl p-3.5">
              <div className="text-slate-500 text-[9px] uppercase font-semibold tracking-widest mb-1">Deprecated</div>
              <div className="text-xl font-mono text-amber-400">{deprecated.length}</div>
            </div>
            <div className="glass rounded-xl p-3.5">
              <div className="text-slate-500 text-[9px] uppercase font-semibold tracking-widest mb-1">Orphaned</div>
              <div className="text-xl font-mono text-rose-400">{orphaned.length}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 min-w-0 flex flex-col h-full">
        <div className="flex-shrink-0 flex items-center justify-between px-5 py-3 border-b border-white/[0.04]">
          <div className="flex items-center gap-3">
            <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-1.5 rounded-lg text-slate-600 hover:text-slate-300 hover:bg-white/[0.04]">
              {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </button>
            <h2 className="text-[12px] font-semibold text-slate-400 uppercase tracking-widest"><Trash2 size={12} className="inline mr-1.5" />Orphans</h2>
          </div>
          <div className="flex items-center gap-2">
            {selectedIds.size > 0 && (
              <button onClick={handleBatchDelete} disabled={batchDeleting} className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/10 disabled:opacity-50">
                {batchDeleting ? <div className="w-3 h-3 border-2 border-rose-400/20 border-t-rose-400 rounded-full animate-spin" /> : <Trash2 size={12} />}
                {selectedIds.size}
              </button>
            )}
            <button onClick={loadOrphans} className="p-1.5 text-slate-500 hover:text-violet-400 rounded-lg">
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 md:px-8 py-6">
          <div className="max-w-3xl mx-auto">
            {loading ? (
              <div className="flex items-center justify-center h-48 text-slate-600 gap-3">
                <div className="w-4 h-4 border-2 border-amber-500/20 border-t-amber-500 rounded-full animate-spin" />
                <span className="text-[11px] tracking-widest uppercase">Scanning...</span>
              </div>
            ) : error ? (
              <div className="glass text-rose-400 p-5 rounded-xl flex items-center gap-3">
                <AlertTriangle size={20} /><div><h3 className="font-medium text-rose-300 text-[13px]">Error</h3><p className="text-[12px] text-rose-400/70">{error}</p></div>
              </div>
            ) : !orphans.length ? (
              <div className="flex flex-col items-center justify-center py-20 text-slate-700 gap-3">
                <Sparkles size={40} className="opacity-15" /><p className="text-[13px] text-slate-500">All clean</p>
              </div>
            ) : (
              <div className="space-y-6">
                {deprecated.length > 0 && (
                  <section>
                    <h3 className="text-[10px] font-semibold uppercase tracking-widest text-amber-500/60 mb-3">
                      <Archive size={10} className="inline mr-1" />Deprecated <span className="text-slate-700">{deprecated.length}</span>
                    </h3>
                    <div className="space-y-2">{deprecated.map(renderCard)}</div>
                  </section>
                )}
                {orphaned.length > 0 && (
                  <section>
                    <h3 className="text-[10px] font-semibold uppercase tracking-widest text-rose-500/60 mb-3">
                      <Unlink size={10} className="inline mr-1" />Orphaned <span className="text-slate-700">{orphaned.length}</span>
                    </h3>
                    <div className="space-y-2">{orphaned.map(renderCard)}</div>
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
