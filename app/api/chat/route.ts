import { PrismaClient, MessageRole, Channel } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { NextResponse } from "next/server";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Simple required fields for Phase 3 (rules-driven)
const REQUIRED_FIELDS = ["serviceName", "date", "time", "customerName", "customerPhone"] as const;

function getNextQuestion(state: Partial<Record<(typeof REQUIRED_FIELDS)[number], string>>) {
  if (!state.serviceName) return "What service would you like to book? (e.g., Haircut, Beard Trim, Head Shave)";
  if (!state.date) return "What date would you like? (YYYY-MM-DD)";
  if (!state.time) return "What time would you like? (e.g., 14:30)";
  if (!state.customerName) return "What’s your full name?";
  if (!state.customerPhone) return "What’s the best phone number to confirm your appointment?";
  return null;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);

  if (!body || typeof body.message !== "string") {
    return NextResponse.json({ error: "Missing 'message' string." }, { status: 400 });
  }

  const conversationId: string | undefined = body.conversationId;

  // Create or load conversation (ensure non-null)
  let conversation = conversationId
    ? await prisma.conversation.findUnique({ where: { id: conversationId }, include: { messages: true } })
    : null;

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { channel: Channel.CHAT, status: "OPEN" },
      include: { messages: true },
    });
  }

  // Store user message
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: MessageRole.USER,
      content: body.message,
    },
  });

  // MVP placeholder "state" (we’ll replace with real extraction next)
  // For now, we just ask the first question in sequence.
  const nextQuestion = "What service would you like to book? (e.g., Haircut, Beard Trim, Head Shave)";

  // Store agent reply
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: MessageRole.AGENT,
      content: nextQuestion,
    },
  });

  return NextResponse.json({
    conversationId: conversation.id,
    reply: nextQuestion,
  });
}
