// The shared operator identity must never be reachable through customer sessions.
function retired() {
  return Response.json(
    { error: "This adapter has been retired. Sign in to your workspace." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
export { retired as GET, retired as POST, retired as PUT, retired as DELETE };
