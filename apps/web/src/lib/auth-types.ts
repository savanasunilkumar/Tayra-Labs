export type Account = {
  id: string;
  email: string;
  email_verified: boolean;
  display_name: string;
  created_at: number | null;
  workspace_id: string;
};

export type AuthConfig = {
  configured: boolean;
  googleEnabled: boolean;
  firebase: { apiKey: string; authDomain: string; projectId: string };
};
