import { useCallback, useEffect, useState } from 'react';

/** Tiny per-user "have I done this" flags for first-time guidance. Safe when storage is blocked. */
const key = (userId: string, name: string) => `askdb:${userId}:${name}`;

export function getFlag(userId: string, name: string): boolean {
  try { return localStorage.getItem(key(userId, name)) === '1'; } catch { return false; }
}
export function setFlag(userId: string, name: string, on = true): void {
  try {
    if (on) localStorage.setItem(key(userId, name), '1');
    else localStorage.removeItem(key(userId, name));
    window.dispatchEvent(new Event('askdb:flags'));
  } catch { /* storage unavailable: guidance simply shows again next time */ }
}
export function useFlag(userId: string, name: string): [boolean, (on?: boolean) => void] {
  const [v, setV] = useState(() => getFlag(userId, name));
  useEffect(() => {
    const sync = () => setV(getFlag(userId, name));
    window.addEventListener('askdb:flags', sync);
    return () => window.removeEventListener('askdb:flags', sync);
  }, [userId, name]);
  const set = useCallback((on = true) => { setFlag(userId, name, on); setV(on); }, [userId, name]);
  return [v, set];
}
