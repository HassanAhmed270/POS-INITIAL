import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useEffect } from 'react';
import { AuthProvider } from './lib/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import { startOfflineSyncWatcher } from './lib/offlineSync';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Billing from './pages/Billing';
import Products from './pages/Products';
import Customers from './pages/Customers';
import Suppliers from './pages/Suppliers';
import Orders from './pages/Orders';
import Reports from './pages/Reports';
import AuditLog from './pages/AuditLog';

export default function App() {
  // Stage 11 — starts the background flush loop for any offline sales
  // queued in IndexedDB. No-op entirely when VITE_ENABLE_OFFLINE_SYNC
  // isn't "true" (see lib/offlineSync.js) — safe to leave mounted
  // whether or not the module is enabled.
  useEffect(() => {
    const stop = startOfflineSyncWatcher();
    return stop;
  }, []);

  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Login />} />
          <Route
            path="/dashboard"
            element={
              <AdminRoute>
                <Dashboard />
              </AdminRoute>
            }
          />
          <Route
            path="/billing"
            element={
              <ProtectedRoute>
                <Billing />
              </ProtectedRoute>
            }
          />
          <Route
            path="/products"
            element={
              <ProtectedRoute>
                <Products />
              </ProtectedRoute>
            }
          />
          <Route
            path="/customers"
            element={
              <ProtectedRoute>
                <Customers />
              </ProtectedRoute>
            }
          />
          <Route
            path="/suppliers"
            element={
              <ProtectedRoute>
                <Suppliers />
              </ProtectedRoute>
            }
          />
          <Route
            path="/orders"
            element={
              <ProtectedRoute>
                <Orders />
              </ProtectedRoute>
            }
          />
          <Route
            path="/reports"
            element={
              <ProtectedRoute>
                <Reports />
              </ProtectedRoute>
            }
          />
          <Route
            path="/audit-log"
            element={
              <AdminRoute>
                <AuditLog />
              </AdminRoute>
            }
          />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}