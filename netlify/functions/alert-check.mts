import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const SITE_URL = "https://hamom-chart-chat.netlify.app";
const ALERT_THRESHOLD_PCT = 10; // 등락률 이 값 이상이면 알림 대상

// 미리 생성해 둔 힉스필드(ElevenLabs) 음성 안내 — "추격 금지, 눌림목 대기" 멘트
const VOICE_CLIP_URL =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38vbAv9qgw2UH7cP3nl562ZKIOp/hf_20260630_140452_d1004608-423a-4044-9b83-96fd7644f7c6.mp3";

function todayKey() {
  const kst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  return `${kst.getFullYear()}-${kst.getMonth() + 1}-${kst.getDate()}`;
}

async function sendEmail(to: string, apiKey: string, mover: any, allMovers: any[]) {
  const listHtml = allMovers
    .slice(0, 8)
    .map(
      (m) =>
        `<li><b>${m.name}</b> (${m.market}) — 현재가 ${m.price?.toLocaleString?.() ?? "-"} · 등락률 ${m.changePct > 0 ? "+" : ""}${m.changePct}%</li>`
    )
    .join("");

  const html = `
    <div style="font-family:sans-serif; max-width:560px; margin:0 auto;">
      <h2 style="color:#D8262B;">🚨 급등 감지 — ${mover.name}</h2>
      <p>등락률 <b>${mover.changePct > 0 ? "+" : ""}${mover.changePct}%</b>로 오늘 등락률 상위에 올라왔습니다.</p>
      <p style="background:#FFF4E5; border-left:4px solid #A6790E; padding:10px 14px; color:#5a4400;">
        이 알림은 매수 신호가 아닙니다. 이미 단기 급등한 종목은 지금 추격 매수하기보다,
        조정·눌림 후 지지가 확인되면 그때 별도로 차트를 재분석하는 것이 원칙입니다.
      </p>
      <p>🔊 음성 안내 듣기: <a href="${VOICE_CLIP_URL}">${VOICE_CLIP_URL}</a></p>
      <h3>오늘의 등락률 상위 (요약)</h3>
      <ul>${listHtml}</ul>
      <p><a href="${SITE_URL}/movers.html">전체 감시 리스트 보기 →</a></p>
      <p style="color:#888; font-size:12px;">차트 기술적 분석 기준의 자동 감시이며, 투자 권유가 아닙니다. 실제 매매 전 추가 정보를 확인하세요.</p>
    </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "급등주 감시 <alerts@resend.dev>",
      to: [to],
      subject: `🚨 급등 감지: ${mover.name} (${mover.changePct > 0 ? "+" : ""}${mover.changePct}%)`,
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

    const candidates = domestic.filter((m: any) => (m.changePct ?? 0) >= ALERT_THRESHOLD_PCT);
    if (candidates.length === 0) {
      return new Response("no candidates", { status: 200 });
    }

    const store = getStore("alert-state");
    const key = todayKey();
    const alerted: string[] = (await store.get(key, { type: "json" })) || [];

    const newOnes = candidates.filter((m: any) => !alerted.includes(m.code));
    if (newOnes.length === 0) {
      return new Response("already alerted today", { status: 200 });
    }

    const top = newOnes[0];
    await sendEmail(alertEmail, resendKey, top, domestic);

    const updated = Array.from(new Set([...alerted, ...newOnes.map((m: any) => m.code)]));
    await store.setJSON(key, updated);

    return new Response(`alerted: ${newOnes.map((m: any) => m.name).join(", ")}`, { status: 200 });
  } catch (err: any) {
    console.error("alert-check error:", err?.message || err);
    return new Response("error: " + (err?.message || String(err)), { status: 500 });
  }
};

export const config: Config = {
  // 평일 한국 시간 9~16시 사이, 매 15분마다 실행 (UTC 기준 00~07시 = KST 09~16시)
  schedule: "*/15 0-7 * * 1-5",
};
