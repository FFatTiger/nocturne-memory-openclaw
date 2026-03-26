'use client';

import React from 'react';
import { Star } from 'lucide-react';
import clsx from 'clsx';

const PriorityBadge = ({ priority, size = 'sm' }) => {
  if (priority === null || priority === undefined) return null;

  const colors =
    priority === 0
      ? 'border-rose-500/20 bg-rose-500/10 text-rose-300'
      : priority <= 2
        ? 'border-yellow-500/20 bg-yellow-500/10 text-yellow-400'
        : priority <= 5
          ? 'border-sky-500/20 bg-sky-500/10 text-sky-400'
          : 'border-white/10 bg-zinc-900/60 text-zinc-400';

  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-md border font-mono font-medium',
        colors,
        size === 'lg' ? 'gap-1 px-2 py-0.5 text-[11px]' : 'gap-0.5 px-1.5 py-0.5 text-[10px]',
      )}
    >
      <Star size={size === 'lg' ? 10 : 8} />
      {priority}
    </span>
  );
};

export default PriorityBadge;
