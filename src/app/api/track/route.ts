export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";

type EventBody = {
  ts?: number;                     // client timestamp (ms)
  kind: "pageview" | "qa" | "chip_click";
  meta?: Record<string, unknown>;  // anonymous fields only
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as EventBody;
    const record = {
      ts: new Date(body.ts ?? Date.now()).toISOString(),
      kind: body.kind,
      meta: body.meta ?? {},
      ua: req.headers.get("user-agent") ?? "",
      path: req.headers.get("x-pathname") ?? "", // optional, client can set
    };

    // 1) Always log to server logs (visible in Vercel deployment logs)
    console.log("[analytics]", JSON.stringify(record));

    // 2) Optional: forward to a webhook if provided
    const url = process.env.ANALYTICS_WEBHOOK;
    if (url) {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record),
      }).catch(() => {});
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}
