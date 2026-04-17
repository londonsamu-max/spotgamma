import { Component, lazy, Suspense, useState, useEffect } from "react";
import type { ReactNode } from "react";
import { Route, Switch } from "wouter";
import { ThemeProvider } from "./contexts/ThemeContext";
import { Toaster } from "sonner";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const MobileDashboard = lazy(() => import("./pages/MobileDashboard"));

// ── Error Boundary ─────────────────────────────────────────────────────────
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error?: Error }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen bg-black text-white">
          <div className="text-center max-w-md">
            <p className="text-red-400 text-lg mb-2">Error en SpotGamma Monitor</p>
            <p className="text-gray-400 text-sm mb-4">{this.state.error?.message}</p>
            <button onClick={() => window.location.reload()} className="px-4 py-2 bg-emerald-600 rounded text-sm">
              Recargar
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-black text-white">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500 mx-auto mb-4" />
        <p className="text-gray-400 text-sm">Cargando SpotGamma Monitor...</p>
      </div>
    </div>
  );
}

function ResponsiveDashboard() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" && window.innerWidth < 768
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile ? <MobileDashboard /> : <Dashboard />;
}

export default function App() {
  return (
    <ThemeProvider>
      <ErrorBoundary>
        <Suspense fallback={<LoadingFallback />}>
          <Switch>
            <Route path="/" component={ResponsiveDashboard} />
            <Route path="/dashboard" component={Dashboard} />
            <Route path="/mobile" component={MobileDashboard} />
          </Switch>
        </Suspense>
      </ErrorBoundary>
      <Toaster richColors position="top-right" />
    </ThemeProvider>
  );
}
