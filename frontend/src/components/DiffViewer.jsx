'use client';

import React from 'react';
import { diffLines } from 'diff';

const DiffViewer = ({ oldText, newText }) => {
  const diff = diffLines(oldText || '', newText || '');
  const hasChanges = (oldText || '') !== (newText || '');

  return (
    <div className="w-full text-[13px] leading-7">
      {!hasChanges && <div className="text-slate-600 italic p-4 text-center border border-dashed border-white/[0.06] rounded-lg">No changes.</div>}
      <div className="space-y-0.5">
        {diff.map((part, i) => {
          if (part.removed) return (
            <div key={i} className="bg-rose-500/[0.04] border-l-2 border-rose-500/20 pl-4 pr-2 py-1 select-text">
              <span className="text-rose-400/30 font-mono text-[10px] block mb-0.5 select-none">−</span>
              <span className="text-rose-300/40 line-through font-mono whitespace-pre-wrap text-[12px]">{part.value}</span>
            </div>
          );
          if (part.added) return (
            <div key={i} className="bg-emerald-500/[0.04] border-l-2 border-emerald-500/30 pl-4 pr-2 py-1.5 my-0.5 rounded-r select-text">
              <span className="text-emerald-400/40 font-mono text-[10px] block mb-0.5 select-none">+</span>
              <span className="text-emerald-200/80 font-mono whitespace-pre-wrap text-[12px]">{part.value}</span>
            </div>
          );
          return (
            <div key={i} className="pl-4 pr-2 py-1 text-slate-600 whitespace-pre-wrap font-mono text-[12px] border-l-2 border-transparent">{part.value}</div>
          );
        })}
      </div>
    </div>
  );
};
export default DiffViewer;
