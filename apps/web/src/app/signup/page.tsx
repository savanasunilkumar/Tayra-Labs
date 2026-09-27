import { AuthForm } from "@/components/auth-form";
import { authConfig } from "@/lib/session";
export const dynamic = "force-dynamic";
export const metadata = { title: "Create account" };
export default function Signup() {
  return <AuthForm mode="signup" config={authConfig()} />;
}
