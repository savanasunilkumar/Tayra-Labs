"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  api,
  message,
  type Health,
  type Job,
  type Recent,
  type Session,
} from "@/lib/api";
import type { Account, AuthConfig } from "@/lib/auth-types";
import { accountStorageKey } from "@/lib/workspace-policy";

type Workspace = {
  user: Account;
  setUser: (user: Account) => void;
  authConfig: AuthConfig;
  session: Session | null;
  health: Health | null;
  connecting: boolean;
  connectionError: string;
  recent: Recent[];
  connect: () => Promise<void>;
  remember: (job: Job, label: string) => void;
};
const Context = createContext<Workspace | null>(null);

export function WorkspaceProvider({
  children,
  user: initialUser,
  authConfig,
}: {
  children: React.ReactNode;
  user: Account;
  authConfig: AuthConfig;
}) {
  const [user, setUser] = useState(initialUser);
  const HISTORY = accountStorageKey("history", initialUser.id);
  const [session, setSession] = useState<Session | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [connectionError, setConnectionError] = useState("");
  const [recent, setRecent] = useState<Recent[]>([]);
  const inFlight = useRef(false);

  const remember = useCallback(
    (job: Job, label: string) => {
      setRecent((old) => {
        const existing = old.find((row) => row.id === job.id);
        const next = [
          {
            id: job.id,
            label,
            status: job.status,
            date:
              existing?.date ??
              (typeof job.created_at === "number"
                ? job.created_at * 1000
                : Date.parse(job.created_at ?? "") || Date.now()),
            metrics: job.metrics,
          },
          ...old.filter((row) => row.id !== job.id),
        ].slice(0, 30);
        try {
          localStorage.setItem(HISTORY, JSON.stringify(next));
        } catch {
          /* History is optional. */
        }
        return next;
      });
    },
    [HISTORY],
  );

  const connect = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setConnecting(true);
    try {
      const config = await api<Session>("session");
      setSession(config);
      const status = await api<Health>("health", config.token);
      setHealth(status);
      const { jobs } = await api<{ jobs: Job[] }>("jobs");
      setRecent(
        jobs.map((job) => ({
          id: job.id,
          label: job.filename || `Analysis ${job.id.slice(0, 8)}`,
          status: job.status,
          date:
            typeof job.created_at === "number"
              ? job.created_at * 1000
              : Date.parse(job.created_at ?? "") || Date.now(),
          metrics: job.metrics,
        })),
      );
      setConnectionError("");
    } catch (error) {
      setHealth(null);
      setConnectionError(message(error));
    } finally {
      setConnecting(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(HISTORY) ?? "[]");
      if (Array.isArray(stored))
        setRecent(
          stored
            .filter(
              (row) =>
                typeof row.id === "string" &&
                typeof row.label === "string" &&
                typeof row.status === "string" &&
                typeof row.date === "number",
            )
            .slice(0, 30),
        );
    } catch {
      /* Storage disabled or malformed. */
    }
    void connect();
    const timer = setInterval(() => {
      if (!document.hidden) void connect();
    }, 60000);
    const visible = () => {
      if (!document.hidden) void connect();
    };
    document.addEventListener("visibilitychange", visible);
    const accountChanged = (event: StorageEvent) => {
      if (event.key === "tayra-account-event") window.location.reload();
    };
    window.addEventListener("storage", accountChanged);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("storage", accountChanged);
    };
  }, [connect, HISTORY]);

  return (
    <Context.Provider
      value={{
        user,
        setUser,
        authConfig,
        session,
        health,
        connecting,
        connectionError,
        recent,
        connect,
        remember,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useWorkspace() {
  const context = useContext(Context);
  if (!context) throw new Error("Workspace provider is missing.");
  return context;
}
