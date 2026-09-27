import { AuthForm } from "@/components/auth-form";
import { authConfig } from "@/lib/session";
export const dynamic = "force-dynamic";
export const metadata = { title: "Log in" };
export default function Login() {
  return <AuthForm mode="login" config={authConfig()} />;
}
