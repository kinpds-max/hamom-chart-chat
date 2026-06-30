import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const SITE_URL = "https://hamom-chart-chat.netlify.app";

const VOICE_CLIPS: Record<string, string> = {
  "급등주발생": "https://d8j0ntlcm91z4.cloudfront.net/user_38vbAv9qgw2UH7cP3nl562ZKIOp/hf_20260630_140452_d1004608-423a-4044-9b83-96fd7644f7c6.mp3",
  "매수신호": "https://d8j0ntlcm91z4.cloudfront.net/user_38vbAv9qgw2UH7cP3nl562ZKIOp/hf_20260630_140440_ac4f5825-2621-4999-8ad6-63b0e54f3ae7.mp3",
  "매도신호": "https://d8j0ntlcm91z4.cloudfront.net/user_38vbAv9qgw2UH7cP3nl562ZKIOp/hf_20260630_140445_30870ed4-d9f1-404a-ad53-2193f5261a4a.mp3",
};

const NOTE_BY_TYPE: Record<string, string> = {
  "급등주발생": "이미 단기간에 빠르게 올랐습니다. 추격 매수 금지 — 조정·눌림 후 지지가 확인되면 재평가하세요.",
  "매수신호": "완만하게 오르고 있는 관심 단계입니다. 지금 바로 사라는 뜻이 아니라, 눌림목과 지지를 직접 확인한 뒤 진입을 검토하라는 신호입니다.",
  "매도신호": "큰 폭으로 하락 중입니다. 보유 중이라면 손절 또는 정리 기준을 다시 확인해보세요.",
};

function todayKey() {
  const kst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  return `${kst.getFullYear()}-${kst.getMonth() + 1}-${kst.getDate()}`;
}

function typeOf(status: string): string | null {
  if (status.startsWith("급등주발생")) return "급등주발생";
  if (status.startsWith("매수신호")) return "매수신호";
  if (status.startsWith("매도신호")) return "매도신호";
  return null;
}

async function sendEmail(to: string, apiKey: string, grouped: Record<string, any[]>) {
  const sections = Object.entries(grouped)
    .filter(([, list]) => list.length > 0)
    .map(([type, list]) => {
      const items = list
        .slice(0, 6)
        .map(
          (m) =>
            `<li><b>${m.name}</b> (${m.market}) — 현재가 ${m.price?.toLocaleString?.() ?? "-"} · 등락률 ${m.changePct > 0 ? "+" : ""}${m.changePct}%</li>`
        )
        .join("");
      return `
        <div style="margin-bottom:18px; padding:14px 16px; border-left:4px solid #A6790E; background:#FFF8EC;">
          <h3 style="margin:0 0 6px;">${type}</h3>
          <p style="margin:0 0 8px; color:#555; font-size:13px;">${NOTE_BY_TYPE[type]}</p>
          <p style="margin:0 0 8px;">🔊 <a href="${VOICE_CLIPS[type]}">음성 안내 듣기</a></p>
          <ul style="margin:0; padding-left:18px;">${items}</ul>
        </div>`;
    })
    .join("");

  const html = `
    <div style="font-family:sans-serif; max-width:560px; margin:0 auto;">
      <h2 style="color:#D8262B;">📡 주식 신호 알림</h2>
      ${sections}
      <p><a href="${SITE_URL}/movers.html">전체 감시 리스트 보기 →</a></p>
      <p style="color:#888; font-size:12px;">차트 기술적 분석 기준의 자동 감시이며, 매수·매도 권유가 아닙니다. 실제 매매 전 추가 정보를 확인하세요.</p>
    </div>`;

  const types = Object.keys(grouped).filter((t) => grouped[t].length > 0);
  const subject = `📡 ${types.join(" / ")} 감지 — ${types.map((t) => grouped[t][0]?.name).filter(Boolean).join(", ")}`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "주식 신호 알림 <alerts@resend.dev>",
      to: [to],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend 발송 실패 (${res.status}): ${body}`);
  }
}

export default async (req: Request) => {
  const resendKey = Netlify.env.get("RESEND_API_KEY");
  const alertEmail = Netlify.env.get("ALERT_EMAIL");

  if (!resendKey || !alertEmail) {
    console.log("RESEND_API_KEY 또는 ALERT_EMAIL이 설정되지 않아 알림을 건너뜁니다.");
    return new Response("env not configured", { status: 200 });
  }

  try {
    const res = await fetch(`${SITE_URL}/api/movers`);
    const data = await res.json();
    const domestic = data?.domestic || [];

    const store = getStore("alert-state");
    const key = todayKey();
    const alerted: string[] = (await store.get(key, { type: "json" })) || [];

    const grouped: Record<string, any[]> = { "급등주발생": [], "매수신호": [], "매도신호": [] };
    const newlyAlerted: string[] = [];

    for (const m of domestic) {
      const type = typeOf(m.status);
      if (!type) continue;
      if (alerted.includes(m.code)) continue;
      grouped[type].push(m);
      newlyAlerted.push(m.code);
    }

    const hasAny = Object.values(grouped).some((l) => l.length > 0);
    if (!hasAny) {
      return new Response("no new signals", { status: 200 });
    }

    await sendEmail(alertEmail, resendKey, grouped);

    const updated = Array.from(new Set([...alerted, ...newlyAlerted]));
    await store.setJSON(key, updated);

    return new Response(
      `alerted: ${Object.entries(grouped)
        .map(([t, l]) => `${t}=${l.length}`)
        .join(", ")}`,
      { status: 200 }
    );
  } catch (err: any) {
    console.error("alert-check error:", err?.message || err);
    return new Response("error: " + (err?.message || String(err)), { status: 500 });
  }
};

export const config: Config = {
  // 평일 한국 시간 9~16시 사이, 매 15분마다 실행 (UTC 기준 00~07시 = KST 09~16시)
  schedule: "*/15 0-7 * * 1-5",
};
