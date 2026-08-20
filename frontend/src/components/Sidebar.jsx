import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';

const links = [
  { to: '/dashboard', label: 'Home' },
  { to: '/billing', label: 'Billing' },
  { to: '/products', label: 'Products' },
  { to: '/customers', label: 'Customers' },
  { to: '/suppliers', label: 'Suppliers' },
  { to: '/orders', label: 'Orders' },
  { to: '/reports', label: 'Reports' },
  { to: '/workers', label: 'Workers', disabled: true },
  { to: '/webpage', label: 'Webpage', disabled: true },
];

export default function Sidebar() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  return (
    <aside className="w-64 shrink-0 bg-brand text-white flex flex-col">
      <div className="p-6 text-2xl font-bold border-b border-brand-dark">Dashboard</div>
      <nav className="flex-1 py-4">
        {links.map((link) =>
          link.disabled ? (
            <span
              key={link.label}
              title="Coming soon"
              className="block px-4 py-2 border-t border-b border-white/40 text-white/50 cursor-not-allowed"
            >
              {link.label}
            </span>
          ) : (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                `block px-4 py-2 border-t border-b border-white hover:bg-brand-dark ${isActive ? 'bg-brand-dark' : ''}`
              }
            >
              {link.label}
            </NavLink>
          )
        )}
      </nav>
      <div className="pt-4">
        <button
          onClick={handleLogout}
          className="w-full text-left border-t border-white block px-4 py-2 hover:bg-red-600"
        >
          🚪 Logout
        </button>
      </div>
    </aside>
  );
}