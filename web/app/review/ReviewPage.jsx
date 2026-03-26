'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { getGroups, getGroupDiff, rollbackGroup, approveGroup, clearAll } from '../../lib/api';
import SnapshotList from '../../components/SnapshotList';
import DiffViewer from '../../components/DiffViewer';
import {
  Activity, Check, FileText, Layout, RotateCcw,
  ShieldCheck, Database, Box, Link as LinkIcon, BookOpen,
  PanelLeftOpen, PanelLeftClose
} from 'lucide-react';
import clsx from 'clsx';

function ReviewPage() {
  const [changes, setChanges] = useState([]);
  const [selectedChange, setSelectedChange] = useState(null);
  const [diffData, setDiffData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [diffError, setDiffError] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const diffRequestRef = useRef(0);

  useEffect(() => { loadChanges(); }, []);

  const loadChanges = async () => {
    setLoading(true);
    try {
      const list = await getGroups();
      setChanges(list);
      if (selectedChange && !list.find(c => c.node_uuid === selectedChange.node_uuid))
        setSelectedChange(list.length > 0 ? list[0] : null);
      else if (list.length > 0 && !selectedChange) setSelectedChange(list[0]);
      if (!list.length) { setSelectedChange(null); setDiffData(null); }
    } catch { setDiffError("Backend offline."); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (selectedChange) loadDiff(selectedChange.node_uuid); }, [selectedChange]);

  const loadDiff = async (nodeUuid) => {
    const req = ++diffRequestRef.current;
    setDiffError(null); setDiffData(null);
    try {
      const data = await getGroupDiff(nodeUuid);
      if (req === diffRequestRef.current) setDiffData(data);
    } catch (err) {
      if (req === diffRequestRef.current) { setDiffError(err.response?.data?.detail || "Failed"); setDiffData(null); }
    }
  };

  const handleRollback = async () => {
    if (!selectedChange || !confirm(`Reject ${selectedChange.display_uri}?`)) return;
    try { await rollbackGroup(selectedChange.node_uuid); await loadChanges(); }
    catch (err) { alert("Failed: " + (err.response?.data?.detail || err.message)); }
  };

  const handleApprove = async () => {
    if (!selectedChange) return;
    try { await approveGroup(selectedChange.node_uuid); await loadChanges(); }
    catch (err) { alert("Failed: " + err.message); }
  };

  const handleClearAll = async () => {
    if (!confirm("Integrate ALL?")) return;
    try { await clearAll(); setChanges([]); setSelectedChange(null); setDiffData(null); }
    catch (err) { alert("Failed: " + err.message); }
  };

  const handleSelect = useCallback((item) => { setSelectedChange(item); setSidebarOpen(false); }, []);

  const typeColor = (action) => {
    switch (action) {
      case 'created': return "bg-emerald-500/10 border-emerald-500/15 text-emerald-400";
      case 'deleted': return "bg-rose-500/10 border-rose-500/15 text-rose-400";
      default: return "bg-amber-500/10 border-amber-500/15 text-amber-400";
    }
  };

  const typeIcon = (type) => {
    const icons = { nodes: Box, memories: FileText, edges: LinkIcon, paths: Database, glossary_keywords: BookOpen };
    return icons[type] || FileText;
  };

  return (
    <div className="flex h-full">
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm md:hidden" onClick={() => setSidebarOpen(false)} />}
      <div className={clsx(
        "fixed top-0 left-0 bottom-0 z-40 md:relative md:z-auto transition-transform duration-200",
        sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0 md:w-0"
      )}>
        <div className="h-full w-64 flex flex-col bg-[#0a0a0a] border-r border-white/[0.04]">
          <div className="px-4 pt-4 pb-3 border-b border-white/[0.04] flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-violet-500/10 flex items-center justify-center">
                <ShieldCheck className="w-3 h-3 text-violet-400" />
              </div>
              <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest">Review</h2>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {loading ? (
              <div className="p-6 flex justify-center"><div className="w-4 h-4 border-2 border-violet-500/20 border-t-violet-500 rounded-full animate-spin" /></div>
            ) : <SnapshotList snapshots={changes} selectedId={selectedChange?.node_uuid} onSelect={handleSelect} />}
          </div>
          {changes.length > 0 && (
            <div className="p-3 border-t border-white/[0.04]">
              <button onClick={handleClearAll} className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-[11px] text-slate-500 hover:text-emerald-400 hover:bg-white/[0.03]">
                <Check size={12} /> Integrate All
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 flex flex-col h-full">
        {selectedChange ? (
          <>
            <div className="flex-shrink-0 flex items-center justify-between px-5 py-3 border-b border-white/[0.04]">
              <div className="flex items-center gap-3 min-w-0">
                <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-1.5 rounded-lg text-slate-600 hover:text-slate-300 hover:bg-white/[0.04]">
                  {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
                </button>
                {(() => { const Icon = typeIcon(selectedChange.top_level_table); return (
                  <div className={clsx("w-8 h-8 rounded-full flex items-center justify-center border flex-shrink-0", typeColor(selectedChange.action))}>
                    <Icon size={15} />
                  </div>
                ); })()}
                <div className="min-w-0">
                  <h2 className="text-[14px] font-medium text-white truncate">{selectedChange.display_uri}</h2>
                  <span className="text-[11px] text-slate-600">{selectedChange.top_level_table} {selectedChange.action || 'modified'}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button onClick={handleRollback} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] text-slate-400 hover:text-rose-400 hover:bg-white/[0.04]">
                  <RotateCcw size={13} /> <span className="hidden sm:inline">Reject</span>
                </button>
                <button onClick={handleApprove} className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[12px] font-medium bg-violet-600/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/15">
                  <Check size={13} /> <span className="hidden sm:inline">Integrate</span>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 md:px-8 py-6">
              <div className="max-w-3xl mx-auto">
                {diffError ? (
                  <div className="mt-16 flex flex-col items-center gap-4">
                    <div className="w-14 h-14 rounded-2xl bg-rose-500/[0.06] flex items-center justify-center"><Activity size={24} className="text-rose-400" /></div>
                    <p className="text-[14px] font-medium text-white">{diffError}</p>
                    <button onClick={() => loadDiff(selectedChange.node_uuid)} className="glass px-4 py-2 rounded-lg text-[12px] text-slate-300">Retry</button>
                  </div>
                ) : diffData ? (
                  <div className="space-y-6">
                    <div className="flex justify-end">
                      <div className={clsx(
                        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-widest border",
                        diffData.action === 'deleted' ? "bg-rose-500/5 border-rose-500/10 text-rose-400"
                        : diffData.action === 'created' ? "bg-emerald-500/5 border-emerald-500/10 text-emerald-400"
                        : (diffData.has_changes || diffData.path_changes?.length) ? "bg-amber-500/5 border-amber-500/10 text-amber-400"
                        : "bg-white/[0.02] border-white/[0.06] text-slate-600"
                      )}>
                        {diffData.action === 'deleted' ? "Deleted" : diffData.action === 'created' ? "Created"
                          : (diffData.has_changes || diffData.path_changes?.length) ? "Modified" : "No Changes"}
                      </div>
                    </div>

                    {diffData.path_changes?.length > 0 && (
                      <div className="glass rounded-xl p-4">
                        <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-3">Paths</h3>
                        <div className="space-y-1.5">
                          {diffData.path_changes.map((pc, i) => (
                            <div key={i} className="flex items-center gap-2 text-[12px]">
                              <span className={clsx("text-[9px] font-semibold", pc.action === 'deleted' ? "text-rose-400" : "text-emerald-400")}>
                                {pc.action === 'deleted' ? '−' : '+'}
                              </span>
                              <span className={clsx("font-mono", pc.action === 'deleted' ? "text-rose-400/40 line-through" : "text-emerald-400")}>{pc.uri}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {diffData.glossary_changes?.length > 0 && (
                      <div className="glass rounded-xl p-4">
                        <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-3">Glossary</h3>
                        <div className="space-y-1.5">
                          {diffData.glossary_changes.map((gc, i) => (
                            <div key={i} className="flex items-center gap-2 text-[12px]">
                              <span className={clsx("text-[9px] font-semibold", gc.action === 'deleted' ? "text-rose-400" : "text-emerald-400")}>
                                {gc.action === 'deleted' ? '−' : '+'}
                              </span>
                              <span className={clsx("font-mono", gc.action === 'deleted' ? "text-rose-400/40 line-through" : "text-emerald-400")}>{gc.keyword}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {diffData.before_meta && diffData.current_meta && (() => {
                      const keys = ['priority', 'disclosure'];
                      const hasPath = diffData.path_changes?.length > 0;
                      const diffs = keys.filter(k => {
                        if (JSON.stringify(diffData.before_meta[k]) !== JSON.stringify(diffData.current_meta[k])) return true;
                        return hasPath && (diffData.before_meta[k] != null || diffData.current_meta[k] != null);
                      });
                      if (!diffs.length) return null;
                      return (
                        <div className="glass rounded-xl p-4">
                          <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-3">Metadata</h3>
                          {diffs.map(k => {
                            const o = diffData.before_meta[k], n = diffData.current_meta[k];
                            const changed = JSON.stringify(o) !== JSON.stringify(n);
                            return (
                              <div key={k} className="grid grid-cols-[70px_1fr_14px_1fr] gap-2 text-[12px] items-center py-1">
                                <span className="text-slate-600 capitalize">{k}</span>
                                <span className={clsx("font-mono text-right", changed ? "text-rose-400/40 line-through" : "text-slate-700")}>{o != null ? String(o) : '∅'}</span>
                                <span className="text-center text-slate-800">{changed ? '→' : '='}</span>
                                <span className={clsx("font-mono", changed ? "text-emerald-400" : "text-slate-600")}>{n != null ? String(n) : '∅'}</span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}

                    <div className="glass rounded-xl p-6">
                      <DiffViewer oldText={diffData.before_content ?? ''} newText={diffData.current_content ?? ''} />
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-48">
                    <div className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-pulse" />
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <button onClick={() => setSidebarOpen(!sidebarOpen)} className="absolute top-3 left-4 p-1.5 rounded-lg text-slate-600 hover:text-slate-300">
              {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </button>
            <div className="w-14 h-14 rounded-2xl bg-white/[0.02] flex items-center justify-center">
              <Layout size={24} className="text-slate-700" />
            </div>
            <p className="text-[13px] text-slate-600">Select a fragment</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default ReviewPage;
