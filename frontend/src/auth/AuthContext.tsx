import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  auth,
  getToken,
  setToken,
  type AuthUser,
  type SignupResponse,
} from "../api/client";

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (
    email: string,
    password: string,
    name: string,
    signupReason?: string,
  ) => Promise<SignupResponse>;
  logout: () => void;
  refresh: () => Promise<void>;
  setUser: (u: AuthUser) => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState<boolean>(!!getToken());

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUserState(null);
      setLoading(false);
      return;
    }
    try {
      const me = await auth.me();
      setUserState(me);
    } catch {
      setToken(null);
      setUserState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Surface 401s from anywhere in the app as an immediate logout so the
  // login screen reappears instead of leaving the UI in a stuck state.
  useEffect(() => {
    function onUnauthorized() {
      setUserState(null);
    }
    window.addEventListener("chat:unauthorized", onUnauthorized);
    return () =>
      window.removeEventListener("chat:unauthorized", onUnauthorized);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await auth.login(email, password);
    setToken(res.access_token);
    setUserState(res.user);
  }, []);

  /** Signup returns pending|approved. When pending, no token comes
   *  back — we return the response so the caller (AuthForm) can show
   *  the 'waiting for admin' screen instead of dropping the user into
   *  a logged-in state with a null token. */
  const signup = useCallback(
    async (
      email: string,
      password: string,
      name: string,
      signupReason: string = "",
    ) => {
      const res = await auth.signup(email, password, name, signupReason);
      if (res.access_token && res.status === "approved") {
        setToken(res.access_token);
        setUserState(res.user);
      }
      return res;
    },
    []
  );

  const logout = useCallback(() => {
    setToken(null);
    setUserState(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      login,
      signup,
      logout,
      refresh,
      setUser: setUserState,
    }),
    [user, loading, login, signup, logout, refresh]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}
