import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const AI_CACHE_TTL_MS = 5 * 60 * 1000; // 5분 캐시 — 무료 API 쿼터 보호

const SYMBOLS: { symbol: string; label: string; group: string }[] = [
  { symbol: "^DJI", label: "다우존스", group: "미국" },
  { symbol: "^IXIC", label: "나스닥종합", group: "미국" },
  { symbol: "^GSPC", label: "S&P500", group: "미국" },
  { symbol: "^KS11", label: "코스피", group: "한국" },
  { symbol: "^KQ11", label: "코스닥", group: "한국" },
];

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

async function fetchIndex(symbol: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=3mo&interval=1d`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`Yahoo Finance 응답 오류 (${symbol}): ${res.status}`);
  const json = await res.json();

  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`데이터 없음: ${symbol}`);

  const meta = result.meta;
  const timestamps: number[] = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const closesRaw: (number | null)[] = quote.close || [];
  const volumesRaw: (number | null)[] = quote.volume || [];

  // Drop trailing/leading nulls (non-trading placeholder bars)
  const rows = timestamps
    .map((t, i) => ({ t, close: closesRaw[i], volume: volumesRaw[i] }))
    .filter((r) => typeof r.close === "number" && typeof r.volume === "number") as {
    t: number;
    close: number;
    volume: number;
  }[];

  const closes = rows.map((r) => r.close);
  const volumes = rows.map((r) => r.volume);

  const last = closes[closes.length - 1];
  const prevClose = meta?.chartPreviousClose ?? closes[closes.length - 2] ?? last;
  const changePct = prevClose ? ((last - prevClose) / prevClose) * 100 : 0;

  const ma10 = sma(closes, 10);
  const ma10Prev = closes.length >= 13 ? sma(closes.slice(0, closes.length - 2), 10) : null;

  let trend = "혼조";
  if (ma10 !== null) {
    if (last > ma10 && (ma10Prev === null || ma10 >= ma10Prev)) trend = "상승 우위";
    else if (last < ma10 && (ma10Prev === null || ma10 <= ma10Prev)) trend = "하락 우위";
    else trend = "추세 전환 구간";
  }

  const todayVolume = volumes[volumes.length - 1];
  const avgVolume20 = sma(volumes.slice(0, Math.max(volumes.length - 1, 0)), Math.min(20, volumes.length - 1));
  let volumeNote = "데이터 부족";
  if (avgVolume20 && todayVolume) {
    const ratio = todayVolume / avgVolume20;
    if (ratio >= 1.3) volumeNote = "평소 대비 증가";
    else if (ratio <= 0.7) volumeNote = "평소 대비 감소";
    else volumeNote = "평소 수준";
  }

  return {
    symbol,
    price: last,
    changePct: Math.round(changePct * 100) / 100,
    ma10: ma10 !== null ? Math.round(ma10 * 100) / 100 : null,
    aboveMa10: ma10 !== null ? last > ma10 : null,
    trend,
    volumeNote,
    currency: meta?.currency || "",
    asOf: timestamps.length ? new Date(timestamps[timestamps.length - 1] * 1000).toISOString() : null,
    series: rows.slice(-60).map((r) => ({ t: r.t * 1000, c: Math.round(r.close * 100) / 100 })),
  };
}

export default async (req: Request, context: Context) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response(JSON.stringify({ error: { message: "GET 또는 POST만 허용됩니다." } }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const results = await Promise.allSettled(SYMBOLS.map((s) => fetchIndex(s.symbol)));

    const indices = SYMBOLS.map((s, i) => {
      const r = results[i];
      if (r.status === "fulfilled") {
        return { ...r.value, label: s.label, group: s.group };
      }
      return {
        symbol: s.symbol,
        label: s.label,
        group: s.group,
        error: r.status === "rejected" ? String((r as PromiseRejectedResult).reason?.message || r.reason) : "조회 실패",
      };
    });

    const ok = indices.filter((i: any) => !i.error);

    let summary = "";
    const cacheStore = getStore("ai-cache");
    const cached: { text: string; ts: number } | null = await cacheStore.get("indices-summary", { type: "json" });
    const cacheFresh = cached && Date.now() - cached.ts < AI_CACHE_TTL_MS;

    if (cacheFresh) {
      summary = cached!.text;
    } else {
      const apiKey = Netlify.env.get("GEMINI_API_KEY");
      if (apiKey && ok.length > 0) {
        try {
          const table = ok
            .map(
              (i: any) =>
                `${i.label}(${i.group}): 현재가 ${i.price}, 전일대비 ${i.changePct > 0 ? "+" : ""}${i.changePct}%, 10일선 ${
                  i.aboveMa10 ? "위" : "아래"
                }, 추세 ${i.trend}, 거래량 ${i.volumeNote}`
            )
            .join("\n");

          const prompt = `다음은 5대 주가지수의 실시간 데이터다 (다우존스, 나스닥종합, S&P500, 코스피, 코스닥):

${table}

이 데이터를 바탕으로 전문 트레이더 관점에서 5~7문장 분량의 한국어 종합 판단을 작성해라. 다음을 반드시 포함해라:
- 미국 3대 지수와 국내 코스피·코스닥의 흐름이 같은 방향인지(동조화) 다른 방향인지(디커플링)
- 10일 이동평균선 기준 추세 강도
- 거래량 신호가 추세를 뒷받침하는지
- 국내 투자자가 오늘 참고할 만한 리스크 포인트 1~2가지 (매수/매도 지시 금지, 객관적 해석만)
마지막 문장에는 "이 판단은 단기 기술적 지표 기준이며 실제 투자 결정 전에는 추가 정보를 확인해야 한다"는 취지를 반드시 넣어라. 마크다운 기호(**, # 등) 쓰지 말고 평문으로 작성해라.`;

          const geminiRes = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
              encodeURIComponent(apiKey),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: { maxOutputTokens: 700 },
              }),
            }
          );
          const geminiData = await geminiRes.json();
          const parts = geminiData?.candidates?.[0]?.content?.parts || [];
          const fresh = parts.map((p: any) => p.text || "").join("\n").trim();
          if (fresh) {
            summary = fresh;
            await cacheStore.setJSON("indices-summary", { text: fresh, ts: Date.now() });
          } else if (cached) {
            summary = cached.text; // 새로 생성 실패 시 직전 캐시라도 사용
          }
        } catch {
          if (cached) summary = cached.text;
        }
      } else if (cached) {
        summary = cached.text;
      }
    }

    return new Response(JSON.stringify({ indices, summary, generatedAt: new Date().toISOString() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: { message: "지수 조회 중 오류: " + (err?.message || String(err)) } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/api/indices",
};
