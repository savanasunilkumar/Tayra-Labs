import { AuthForm } from "@/components/auth-form";
import { authConfig } from "@/lib/session";
export const dynamic = "force-dynamic";
export const metadata = { title: "Reset password" };
export default function ForgotPassword() {
  return <AuthForm mode="forgot-password" config={authConfig()} />;
}
