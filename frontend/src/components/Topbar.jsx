import { useAuth } from '../lib/AuthContext';
import LowStockBell from './LowStockBell';

export default function Topbar({ title }) {
  const { username, isAdmin } = useAuth();
  const initial = username ? username.charAt(0).toUpperCase() : '?';

  return (
    <header className="flex justify-between items-center px-6 py-3 bg-white shadow">
      <h1 className="text-2xl md:text-3xl font-bold text-brand">{title}</h1>
      <div className="flex items-center gap-4">
        {/* Stage 15 — low-stock notifications are admin-visible only,
            same convention as the Audit Log link (Stage 14). */}
        {isAdmin && <LowStockBell />}
        <div className="flex items-center gap-2">
          <span className="h-8 w-8 rounded-full ring-2 ring-brand bg-brand/10 text-brand font-semibold flex items-center justify-center text-sm">
            {initial}
          </span>
          <span className="text-base font-medium text-brand">{username}</span>
        </div>
      </div>
    </header>
  );
}
