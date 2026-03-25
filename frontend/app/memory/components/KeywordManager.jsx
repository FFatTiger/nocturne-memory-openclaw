'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Tag, X, Plus } from 'lucide-react';
import { api } from '../../../src/lib/api';

const KeywordManager = ({ keywords, nodeUuid, onUpdate }) => {
  const [adding, setAdding] = useState(false);
  const [newKeyword, setNewKeyword] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (adding && inputRef.current) inputRef.current.focus();
  }, [adding]);

  const handleAdd = async () => {
    const kw = newKeyword.trim();
    if (!kw || !nodeUuid) return;
    try {
      await api.post('/browse/glossary', { keyword: kw, node_uuid: nodeUuid });
      setNewKeyword('');
      setAdding(false);
      onUpdate();
    } catch (err) {
      alert(`Failed: ${err.response?.data?.detail || err.message}`);
    }
  };

  const handleRemove = async (kw) => {
    if (!nodeUuid) return;
    try {
      await api.delete('/browse/glossary', { data: { keyword: kw, node_uuid: nodeUuid } });
      onUpdate();
    } catch (err) {
      alert(`Failed: ${err.response?.data?.detail || err.message}`);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleAdd();
    if (e.key === 'Escape') {
      setAdding(false);
      setNewKeyword('');
    }
  };

  return (
    <div className="flex items-start gap-2 text-[12px] text-zinc-400">
      <Tag size={13} className="mt-0.5 flex-shrink-0 text-yellow-500" />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-zinc-300">Glossary</span>

        {keywords.map((kw) => (
          <span key={kw} className="glossary-tag">
            {kw}
            <button onClick={() => handleRemove(kw)} className="text-yellow-500/70 hover:text-yellow-300">
              <X size={8} />
            </button>
          </span>
        ))}

        {adding ? (
          <span className="inline-flex items-center gap-1">
            <input
              ref={inputRef}
              type="text"
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => {
                if (!newKeyword.trim()) setAdding(false);
              }}
              placeholder="keyword"
              className="w-28 rounded-md border border-yellow-500/20 bg-zinc-900/70 px-2 py-1 text-[11px] font-mono text-yellow-200 focus:border-yellow-500/35 focus:outline-none"
            />
          </span>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-white/12 bg-zinc-900/40 px-2 py-1 text-[11px] text-zinc-400 hover:border-white/20 hover:bg-zinc-800/50 hover:text-zinc-200"
          >
            <Plus size={9} /> add
          </button>
        )}
      </div>
    </div>
  );
};

export default KeywordManager;
