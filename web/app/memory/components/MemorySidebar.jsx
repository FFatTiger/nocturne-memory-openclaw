'use client';

import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight, FileText, Database } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../../lib/api';

const TreeNode = ({ domain, path, name, childrenCount, activeDomain, activePath, onNavigate, level }) => {
  const isAncestor = activeDomain === domain && activePath.startsWith(`${path}/`);
  const isActive = activeDomain === domain && activePath === path;
  const [expanded, setExpanded] = useState(isAncestor || isActive);
  const [children, setChildren] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const prevActivePath = useRef(activePath);
  const prevActiveDomain = useRef(activeDomain);
  const hasChildren = fetched ? children.length > 0 : childrenCount === undefined || childrenCount > 0;

  useEffect(() => {
    if (expanded && !fetched && hasChildren) fetchChildren();
  }, [expanded, fetched, hasChildren]);

  useEffect(() => {
    const changed = activePath !== prevActivePath.current || activeDomain !== prevActiveDomain.current;
    if (changed && (isAncestor || isActive) && !expanded) setExpanded(true);
    prevActivePath.current = activePath;
    prevActiveDomain.current = activeDomain;
  }, [activePath, activeDomain, isAncestor, isActive, expanded]);

  const fetchChildren = async () => {
    setLoading(true);
    try {
      setChildren((await api.get('/browse/node', { params: { domain, path, nav_only: true } })).data.children);
      setFetched(true);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleClick = (e) => {
    e.stopPropagation();
    if (isActive) {
      if (hasChildren) setExpanded(!expanded);
    } else {
      onNavigate(path, domain);
      if (!expanded && hasChildren) setExpanded(true);
    }
  };

  return (
    <div>
      <div
        className={clsx(
          'flex cursor-pointer items-center gap-1.5 rounded-lg py-1.5 pr-2 text-[13px] transition-colors',
          isActive
            ? 'bg-violet-500/12 text-zinc-100'
            : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200',
        )}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
        onClick={handleClick}
      >
        <div
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center"
          onClick={(e) => {
            if (hasChildren) {
              e.stopPropagation();
              setExpanded(!expanded);
            }
          }}
        >
          {loading ? (
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-violet-400" />
          ) : hasChildren ? (
            <ChevronRight size={13} className={clsx('text-zinc-500 transition-transform', expanded && 'rotate-90')} />
          ) : null}
        </div>
        <FileText size={13} className={clsx('flex-shrink-0', isActive ? 'text-violet-300' : 'text-zinc-500')} />
        <span className="truncate flex-1">{name}</span>
      </div>

      {expanded && children.length > 0 && (
        <div>
          {children.map((c) => (
            <TreeNode
              key={c.path}
              domain={domain}
              path={c.path}
              name={c.name}
              childrenCount={c.approx_children_count}
              activeDomain={activeDomain}
              activePath={activePath}
              onNavigate={onNavigate}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const DomainNode = ({ domain, rootCount, activeDomain, activePath, onNavigate }) => {
  const [expanded, setExpanded] = useState(activeDomain === domain);
  const [children, setChildren] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const prevActiveDomain = useRef(activeDomain);
  const prevActivePath = useRef(activePath);
  const hasChildren = fetched ? children.length > 0 : rootCount === undefined || rootCount > 0;

  useEffect(() => {
    if (expanded && !fetched && hasChildren) fetchChildren();
  }, [expanded, fetched, hasChildren]);

  useEffect(() => {
    const changed = activeDomain !== prevActiveDomain.current || activePath !== prevActivePath.current;
    if (changed && activeDomain === domain && !expanded) setExpanded(true);
    prevActiveDomain.current = activeDomain;
    prevActivePath.current = activePath;
  }, [activeDomain, activePath, domain, expanded]);

  const fetchChildren = async () => {
    setLoading(true);
    try {
      setChildren((await api.get('/browse/node', { params: { domain, path: '', nav_only: true } })).data.children);
      setFetched(true);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const isActive = activeDomain === domain && activePath === '';

  const handleClick = (e) => {
    e.stopPropagation();
    if (isActive) {
      if (hasChildren) setExpanded(!expanded);
    } else {
      onNavigate('', domain);
      if (!expanded && hasChildren) setExpanded(true);
    }
  };

  return (
    <div className="mb-1">
      <div
        className={clsx(
          'flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-2 text-[13px] transition-colors',
          isActive
            ? 'bg-violet-500/12 text-zinc-100'
            : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200',
        )}
        onClick={handleClick}
      >
        <div
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center"
          onClick={(e) => {
            if (hasChildren) {
              e.stopPropagation();
              setExpanded(!expanded);
            }
          }}
        >
          {loading ? (
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-600 border-t-violet-400" />
          ) : hasChildren ? (
            <ChevronRight size={15} className={clsx('text-zinc-500 transition-transform', expanded && 'rotate-90')} />
          ) : null}
        </div>
        <Database size={15} className={clsx('flex-shrink-0', isActive ? 'text-violet-300' : 'text-zinc-500')} />
        <span className="flex-1 truncate font-medium">{domain.charAt(0).toUpperCase() + domain.slice(1)}</span>
        {rootCount !== undefined && <span className="text-[10px] text-zinc-500">{rootCount}</span>}
      </div>

      {expanded && children.length > 0 && (
        <div>
          {children.map((c) => (
            <TreeNode
              key={c.path}
              domain={domain}
              path={c.path}
              name={c.name}
              childrenCount={c.approx_children_count}
              activeDomain={activeDomain}
              activePath={activePath}
              onNavigate={onNavigate}
              level={1}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default DomainNode;
