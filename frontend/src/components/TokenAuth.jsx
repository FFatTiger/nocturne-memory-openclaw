'use client';

import React, { useState, useCallback } from 'react';
import { LayoutGrid, KeyRound, Loader2, AlertCircle } from 'lucide-react';
import { getDomains } from '../lib/api';

const TokenAuth = ({ onAuthenticated }) => {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    setLoading(true);
    setError('');
    // Store token in cookie (not localStorage) so API route can read it
    document.cookie = `api_token=${encodeURIComponent(trimmed)}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`;
    try {
      await getDomains();
      onAuthenticated();
    } catch (err) {
      document.cookie = 'api_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      setError(err.response?.status === 401 ? 'Token 无效' : '连接失败');
    } finally {
      setLoading(false);
    }
  }, [token, onAuthenticated]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-black relative overflow-hidden">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] bg-violet-500/[0.07] rounded-full blur-[120px] pointer-events-none" />

      <div className="w-full max-w-xs mx-4 relative z-10">
        <div className="glass rounded-2xl p-7">
          <div className="flex flex-col items-center mb-7">
            <div className="w-11 h-11 rounded-xl bg-violet-500/10 flex items-center justify-center mb-4">
              <LayoutGrid className="w-5 h-5 text-violet-400" />
            </div>
            <h1 className="text-base font-semibold text-white tracking-tight">Nocturne</h1>
            <p className="text-[11px] text-slate-500 mt-1">记忆管理面板</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-2 uppercase tracking-wider">API Token</label>
              <input
                type="password"
                value={token}
                onChange={(e) => { setToken(e.target.value); if (error) setError(''); }}
                placeholder="输入令牌..."
                disabled={loading}
                className="w-full px-3.5 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-[13px] text-white placeholder-slate-600 focus:outline-none focus:border-violet-500/40 focus:bg-white/[0.06]"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-[12px] text-rose-400 bg-rose-500/[0.06] border border-rose-500/10 rounded-lg px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />{error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !token.trim()}
              className="w-full py-2.5 bg-violet-600 hover:bg-violet-500 disabled:bg-white/[0.04] disabled:text-slate-600 text-white text-[13px] font-medium rounded-xl disabled:cursor-not-allowed"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />验证中...</span>
              ) : '连接'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default TokenAuth;
