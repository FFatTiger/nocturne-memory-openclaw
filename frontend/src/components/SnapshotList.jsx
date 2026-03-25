'use client';

import React from 'react';
import clsx from 'clsx';

const getActionColor = (action) => {
  if (action === 'created') return 'emerald';
  if (action === 'deleted') return 'rose';
  return 'amber';
};

const getActionLabel = (table, action) => {
  let name = table;
  if (table === 'memories') name = 'Memory';
  else if (table.endsWith('s')) name = table.slice(0, -1);
  return `${name.charAt(0).toUpperCase() + name.slice(1)} ${action ? action.charAt(0).toUpperCase() + action.slice(1) : 'Modified'}`;
};

const DOT = {
  emerald: { active: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]", idle: "bg-emerald-900", label: "text-emerald-600" },
  rose: { active: "bg-rose-400 shadow-[0_0_6px_rgba(244,63,94,0.5)]", idle: "bg-rose-900", label: "text-rose-600" },
  amber: { active: "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)]", idle: "bg-amber-900", label: "text-amber-600" },
};

const SnapshotList = ({ snapshots, selectedId, onSelect }) => {
  if (!snapshots.length) return <div className="text-center py-10 text-slate-700 text-[11px] tracking-widest uppercase">Empty</div>;

  return (
    <div className="flex flex-col">
      {snapshots.map(item => {
        const sel = item.node_uuid === selectedId;
        const c = DOT[getActionColor(item.action)];
        return (
          <button key={item.node_uuid} onClick={() => onSelect(item)}
            className={clsx("relative text-left py-2.5 px-5 border-l-2 outline-none",
              sel ? "border-violet-500/50 bg-violet-500/[0.03]" : "border-transparent text-slate-600 hover:text-slate-300 hover:bg-white/[0.01]")}>
            <div className="flex items-center gap-2.5">
              <div className={clsx("flex-shrink-0 w-1.5 h-1.5 rounded-full", sel ? c.active : c.idle)} />
              <div className="min-w-0 flex-1">
                <div className={clsx("font-medium text-[12px] truncate", sel ? "text-white" : "text-slate-400")}>{item.display_uri}</div>
                <div className="mt-0.5 flex justify-between">
                  <span className={clsx("text-[9px] uppercase tracking-wider font-semibold", c.label)}>{getActionLabel(item.top_level_table, item.action)}</span>
                  {item.row_count > 1 && <span className="text-[9px] text-slate-700">{item.row_count}</span>}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
};
export default SnapshotList;
