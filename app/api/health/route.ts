export async function GET() {
  return Response.json({
    ok: true,
    nodeEnv: process.env.NODE_ENV ?? null,
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    time: new Date().toISOString(),
  });
}
