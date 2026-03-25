'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { ShieldCheck, Database, Sparkles, AlertCircle, FlaskConical } from 'lucide-react';
import clsx from 'clsx';
import { getDomains, AUTH_ERROR_EVENT } from '../lib/api';
import TokenAuth from './TokenAuth';

const tabs = [
  { href: '/review', icon: ShieldCheck, label: 'Review' },
  { href: '/memory', icon: Database, label: 'Explorer' },
  { href: '/plugin', icon: FlaskConical, label: 'Plugin' },
  { href: '/maintenance', icon: Sparkles, label: 'Cleanup' },
];

function TabBar() {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <>
      <div className="fixed top-4 left-1/2 z-50 hidden -translate-x-1/2 md:flex">
        <div className="flex items-center gap-1 rounded-2xl border border-white/10 bg-zinc-900/75 px-1.5 py-1.5 shadow-2xl shadow-black/40 backdrop-blur-2xl">
          {tabs.map(({ href, icon: Icon, label }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <button
                key={href}
                onClick={() => router.push(href)}
                className={clsx(
                  'flex items-center gap-1.5 rounded-xl px-4 py-2 text-[12px] font-medium transition-colors',
                  active
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200',
                )}
              >
                <Icon size={14} />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="fixed bottom-3 left-3 right-3 z-50 md:hidden">
        <div
          className="grid gap-1 rounded-2xl border border-white/10 bg-zinc-900/90 p-1 shadow-2xl shadow-black/40 backdrop-blur-2xl"
          style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
        >
          {tabs.map(({ href, icon: Icon, label }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <button
                key={href}
                onClick={() => router.push(href)}
                className={clsx(
                  'flex flex-col items-center justify-center gap-1 rounded-xl py-2.5 text-[11px] font-medium transition-colors',
                  active
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200',
                )}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

export default function AppShell({ children }) {
  const router = useRouter();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [backendError, setBackendError] = useState(false);

  const handleAuthError = useCallback(() => setIsAuthenticated(false), []);
  const handleAuthenticated = useCallback(() => {
    setIsAuthenticated(true);
    setBackendError(false);
  }, []);

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        await getDomains();
        if (mounted) {
          setIsAuthenticated(true);
          setBackendError(false);
          setIsCheckingAuth(false);
        }
      } catch (e) {
        if (mounted) {
          if (!e.response) setBackendError(true);
          else if (e.response.status === 401) {
            setIsAuthenticated(false);
            setBackendError(false);
          }
          setIsCheckingAuth(false);
        }
      }
    };
    check();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    window.addEventListener(AUTH_ERROR_EVENT, handleAuthError);
    return () => window.removeEventListener(AUTH_ERROR_EVENT, handleAuthError);
  }, [handleAuthError]);

  useEffect(() => {
    if (isAuthenticated && window.location.pathname === '/') {
      router.replace('/memory');
    }
  }, [isAuthenticated, router]);

  if (isCheckingAuth) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0c0c0e]">
        <div className="flex items-center gap-3 text-[13px] text-zinc-400">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/10 border-t-violet-500" />
          Connecting...
        </div>
      </div>
    );
  }

  if (backendError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-[#0c0c0e]">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-500/10">
          <AlertCircle className="h-7 w-7 text-rose-400" />
        </div>
        <p className="text-lg font-semibold text-white">后端未连接</p>
        <p className="text-[13px] text-zinc-400">请检查后端服务</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-2 rounded-xl border border-white/10 bg-zinc-900/70 px-5 py-2.5 text-[13px] text-white hover:bg-zinc-800/80"
        >
          重试
        </button>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <TokenAuth onAuthenticated={handleAuthenticated} />;
  }

  return (
    <div className="relative h-screen overflow-hidden bg-[#0d0d10] text-zinc-300">
      <TabBar />
      <div className="h-full pt-0 pb-24 md:pt-16 md:pb-0">{children}</div>
    </div>
  );
}
