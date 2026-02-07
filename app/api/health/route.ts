export async function GET() {
  return Response.json({ ok: true, service: "barber-ai", time: new Date().toISOString() });
}
