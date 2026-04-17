// Stub auth hook — personal dashboard, no auth needed
export function useAuth() {
  return {
    user: { id: "owner", name: "Owner", email: "", role: "admin" },
    loading: false,
    error: null,
    isAuthenticated: true,
    logout: () => {},
  };
}
