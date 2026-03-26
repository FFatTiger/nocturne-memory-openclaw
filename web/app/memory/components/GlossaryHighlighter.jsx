'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, X } from 'lucide-react';
import clsx from 'clsx';

const GlossaryPopup = ({ keyword, nodes, position, onClose, onNavigate }) => {
  const popupRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (popupRef.current && !popupRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return createPortal(
    <div
      ref={popupRef}
      className="fixed z-[100] flex w-72 flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/95 shadow-2xl shadow-black/60 backdrop-blur-2xl"
      style={{
        left: Math.min(position.x, (typeof window !== 'undefined' ? window.innerWidth : 800) - 300),
        ...(position.isAbove
          ? {
              bottom: (typeof window !== 'undefined' ? window.innerHeight : 600) - position.spanTop + 8,
              maxHeight: position.spanTop - 24,
            }
          : {
              top: position.y + 8,
              maxHeight: (typeof window !== 'undefined' ? window.innerHeight : 600) - position.y - 24,
            }),
      }}
    >
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-white/5 px-3.5 py-2.5">
        <BookOpen size={12} className="text-yellow-500" />
        <span className="text-[12px] font-semibold text-yellow-400">{keyword}</span>
        <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200">
          <X size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {nodes.map((node, i) => {
          const isUnlinked = node.uri?.startsWith('unlinked://');
          return (
            <button
              key={node.uri || i}
              onClick={() => {
                if (isUnlinked) return;
                const match = node.uri?.match(/^([^:]+):\/\/(.*)$/);
                if (match) onNavigate(match[2], match[1]);
                onClose();
              }}
              className={clsx(
                'w-full rounded-xl border border-transparent px-2.5 py-2 text-left transition-colors',
                isUnlinked
                  ? 'cursor-default opacity-70'
                  : 'hover:border-white/10 hover:bg-zinc-900/70 cursor-pointer',
              )}
            >
              <div className="flex items-center gap-2">
                <code
                  className={clsx(
                    'flex-1 truncate text-[11px] font-mono',
                    isUnlinked ? 'text-zinc-500' : 'text-blue-400',
                  )}
                >
                  {node.uri}
                </code>
                {isUnlinked && (
                  <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-[8px] text-rose-400">orphan</span>
                )}
              </div>
              {node.content_snippet && (
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-zinc-400">
                  {node.content_snippet}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
};

const GlossaryHighlighter = ({ content, glossary, currentNodeUuid, onNavigate }) => {
  const [popup, setPopup] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    setPopup(null);
  }, [content]);

  const filteredGlossary = useMemo(() => {
    if (!glossary) return [];
    return glossary
      .map((entry) => ({
        ...entry,
        nodes: entry.nodes?.filter((n) => n.node_uuid !== currentNodeUuid) || [],
      }))
      .filter((entry) => entry.nodes.length > 0);
  }, [glossary, currentNodeUuid]);

  useEffect(() => {
    if (!filteredGlossary.length || !containerRef.current) return;

    const keywords = filteredGlossary.map((entry) => entry.keyword).filter(Boolean);
    if (!keywords.length) return;

    const walker = document.createTreeWalker(containerRef.current, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    const keywordMap = {};
    for (const entry of filteredGlossary) keywordMap[entry.keyword] = entry;

    for (const textNode of textNodes) {
      const parentEl = textNode.parentElement;
      if (!parentEl) continue;
      if (parentEl.closest('code, pre, a, .glossary-keyword')) continue;

      const text = textNode.textContent;
      if (!text) continue;

      const matches = [];
      for (const kw of keywords) {
        let idx = text.indexOf(kw);
        while (idx !== -1) {
          matches.push({ start: idx, end: idx + kw.length, keyword: kw });
          idx = text.indexOf(kw, idx + kw.length);
        }
      }
      if (!matches.length) continue;

      matches.sort((a, b) => a.start - b.start);
      const filtered = [];
      let lastEnd = -1;
      for (const match of matches) {
        if (match.start >= lastEnd) {
          filtered.push(match);
          lastEnd = match.end;
        }
      }

      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const match of filtered) {
        if (match.start > pos) {
          frag.appendChild(document.createTextNode(text.slice(pos, match.start)));
        }
        const span = document.createElement('span');
        span.className = 'glossary-keyword';
        span.textContent = text.slice(match.start, match.end);
        span.dataset.keyword = match.keyword;
        frag.appendChild(span);
        pos = match.end;
      }
      if (pos < text.length) {
        frag.appendChild(document.createTextNode(text.slice(pos)));
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }

    const handleClick = (e) => {
      const target = e.target.closest('.glossary-keyword');
      if (!target) return;
      const kw = target.dataset.keyword;
      const entry = keywordMap[kw];
      if (!entry) return;
      const rect = target.getBoundingClientRect();
      let x = rect.left;
      if (x + 288 > window.innerWidth - 16) x = window.innerWidth - 304;
      if (x < 16) x = 16;
      const estimatedHeight = 250;
      const isAbove = rect.bottom + estimatedHeight > window.innerHeight - 16 && rect.top > estimatedHeight + 16;
      setPopup({
        keyword: kw,
        nodes: entry.nodes,
        position: { x, y: rect.bottom, isAbove, spanTop: rect.top },
      });
    };

    containerRef.current.addEventListener('click', handleClick);
    return () => containerRef.current?.removeEventListener('click', handleClick);
  }, [content, filteredGlossary]);

  return (
    <div ref={containerRef} className="relative">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      {popup && (
        <GlossaryPopup
          keyword={popup.keyword}
          nodes={popup.nodes}
          position={popup.position}
          onClose={() => setPopup(null)}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
};

export default GlossaryHighlighter;
