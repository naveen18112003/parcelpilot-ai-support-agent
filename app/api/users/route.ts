import { NextResponse } from "next/server";
import { publicUsers } from "@/lib/auth";

export async function GET() {
  return NextResponse.json({ users: publicUsers() });
}
