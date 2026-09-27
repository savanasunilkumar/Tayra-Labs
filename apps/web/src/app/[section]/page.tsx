import { notFound, redirect } from "next/navigation";
import { WorkspacePage } from "@/components/workspace-pages";
import { WorkspaceShell } from "@/components/workspace-shell";
import { requireAccount, authConfig } from "@/lib/session";

export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (section === "analyses" || section === "activity") redirect("/overview");
  if (section === "playground") redirect("/analyze");
  if (
    ![
      "overview",
      "analyze",
      "models",
      "access",
      "reference",
      "settings",
    ].includes(section)
  )
    notFound();
  const user = await requireAccount();
  return (
    <WorkspaceShell user={user} authConfig={authConfig()}>
      <WorkspacePage section={section} />
    </WorkspaceShell>
  );
}
