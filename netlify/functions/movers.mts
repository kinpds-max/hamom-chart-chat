import type { Context, Config } from "@netlify/functions";

const SOURCES = [
  { sosok: "0", market: "코스피", path: "sise_rise" },
  { sosok: "1", market: "코스닥", path: "sise_rise" },
  { sosok: "0", market: "코스피", path: "sise_fall" },
  { sosok: "1", market: "코스닥", path: "sise_fall" },
];

function decode(buf: ArrayBuffer): string {
  try {
    // 네이버 금융 구 페이지는 EUC-KR 인코딩을 쓴다.
    return new TextDecoder("euc-kr").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

function classify(changePct: number | null): string {
  if (changePct === null) return "관찰";
  if (changePct >= 10) return "급등주발생 · 추격금지";
  if (changePct >= 3) return "매수신호 · 관심(추격아님)";
  if (changePct <= -7) return "매도신호 · 손절검토";
  return "관찰";
}

function parseRows(html: string, market: string) {
  const blocks = html.split(/<tr/i).slice(1);
  const out: any[] = [];
  for (const raw of blocks) {
    const rowHtml = "<tr" + raw.split(/<\/tr>/i)[0];
    const codeMatch = rowHtml.match(/code=(\d{6})/);
    if (!codeMatch) continue;
    const nameMatch = rowHtml.match(/<a[^>]*>([^<]+)<\/a>/);
    const name = nameMatch ? nameMatch[1].replace(/&amp;/g, "&").trim() : null;
    if (!name) continue;

    const text = rowHtml.replace(/<[^>]+>/g, " ");
    const tokens = text.match(/-?[\d,]+\.?\d*%?/g) || [];
    const pctToken = tokens.find((t) => t.includes("%"));
    const changePct = pctToken ? parseFloat(pctToken.replace("%", "").replace(/,/g, "")) : null;

    const numbers = tokens
      .filter((t) => !t.includes("%"))
      .map((t) => parseFloat(t.replace(/,/g, "")))
      .filter((n) => !isNaN(n) && n > 0); // 가격/거래량은 항상 양수

    if (numbers.length === 0 || changePct === null) continue;

    const price = numbers[0];
    const volume = numbers.length > 1 ? Math.max(...numbers.slice(1)) : null;

    out.push({
      code: codeMatch[1],
      name,
      market,
      price,
      changePct,
      volume,
    });
  }
  return out;
}

async function fetchMarket(sosok: string, market: string, path: string) {
  const url = `https://finance.naver.com/sise/${path}.naver?sosok=${sosok}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`네이버 금융 응답 오류 (${market}/${path}): ${res.status}`);
  const buf = await res.arrayBuffer();
  const html = decode(buf);
  return parseRows(html, market);
}

async function fetchUSGainers() {
  const url =
    "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=day_gainers&count=20";
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`Yahoo 스크리너 응답 오류 (미국): ${res.status}`);
  const data = await res.json();
  const quotes = data?.finance?.result?.[0]?.quotes || [];
  return quotes
    .map((q: any) => ({
      code: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      market: "미국",
      price: typeof q.regularMarketPrice === "number" ? q.regularMarketPrice : null,
      changePct:
        typeof q.regularMarketChangePercent === "number"
          ? Math.round(q.regularMarketChangePercent * 100) / 100
          : null,
      volume: typeof q.regularMarketVolume === "number" ? q.regularMarketVolume : null,
      marketState: q.marketState || null,
      regularMarketTime: typeof q.regularMarketTime === "number" ? q.regularMarketTime * 1000 : null,
    }))
    .filter((m: any) => m.price !== null && m.changePct !== null);
}

export default async (req: Request, context: Context) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response(JSON.stringify({ error: { message: "GET 또는 POST만 허용됩니다." } }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const results = await Promise.allSettled([
      ...SOURCES.map((s) => fetchMarket(s.sosok, s.market, s.path)),
      fetchUSGainers(),
    ]);
    const labels = [...SOURCES.map((s) => s.market), "미국"];
    let domesticRaw: any[] = [];
    let overseas: any[] = [];
    const errors: string[] = [];

    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        if (labels[i] === "미국") overseas = overseas.concat(r.value);
        else domesticRaw = domesticRaw.concat(r.value);
      } else {
        errors.push(`${labels[i]}: ${(r as PromiseRejectedResult).reason?.message || r.reason}`);
      }
    });

    // 같은 종목이 상승/하락 페이지 양쪽에 잡힐 일은 없지만 혹시 모를 중복은 code 기준으로 정리
    const seen = new Set<string>();
    let domestic = domesticRaw.filter((m) => {
      if (seen.has(m.code)) return false;
      seen.add(m.code);
      return true;
    });

    domestic.sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
    overseas.sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
    domestic = domestic
      .map((m) => ({ ...m, status: classify(m.changePct) }))
      .filter((m) => m.status !== "관찰")
      .slice(0, 24);
    overseas = overseas
      .map((m) => ({ ...m, status: classify(m.changePct) }))
      .filter((m) => m.status !== "관찰")
      .slice(0, 15);

    const movers = [...domestic, ...overseas]; // kept for AI prompt + backward compat

    const now = new Date();
    const kstNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
    const domesticAsOf = `${kstNow.getFullYear()}.${kstNow.getMonth() + 1}.${kstNow.getDate()} (KST, 국내 거래일 기준)`;
    const usSample = overseas.find((m) => m.regularMarketTime);
    const usAsOf = usSample
      ? new Date(usSample.regularMarketTime).toLocaleString("ko-KR", { timeZone: "America/New_York" }) + " (미국 동부시간 기준)"
      : "미국 최근 거래 세션 기준 (현지 시간 정보 없음)";

    let summary = "";
    const apiKey = Netlify.env.get("GEMINI_API_KEY");
    if (apiKey && movers.length > 0) {
      try {
        const table = movers
          .slice(0, 12)
          .map((m) => `${m.name}(${m.market}, ${m.code}): 현재가 ${m.price}, 등락률 ${m.changePct > 0 ? "+" : ""}${m.changePct}%${m.volume ? `, 거래량 ${m.volume.toLocaleString()}` : ""}`)
          .join("\n");

        const prompt = `다음은 오늘 기준 신호가 잡힌 종목 리스트다 (국내는 한국 거래일 기준, 미국은 미국 최근 거래 세션 기준). 신호는 세 가지로 분류되어 있다: "급등주발생"(단기 급등, 추격금지), "매수신호"(완만한 상승, 관심 단계), "매도신호"(급락, 손절검토):

${table}

이 리스트를 보고 2~4문장으로 한국어 코멘트를 작성해라. 반드시 지켜야 할 규칙:
- "지금 사라", "추격 매수해도 된다", "세력 확실", "무조건" 같은 표현을 절대 쓰지 않는다.
- "매수신호"로 분류된 종목도 즉시 매수를 의미하지 않는다 — 지지·눌림목을 직접 확인한 뒤 진입을 검토하라는 관찰 단계임을 분명히 한다.
- "급등주발생" 종목은 추격 매수 금지, "매도신호" 종목은 보유자 한정 손절 기준 재확인을 권한다.
- 국내와 미국 리스트를 같이 묶어 "전체 시장이 동일하다"는 식으로 단정하지 말고, 필요하면 국내/미국을 구분해서 언급한다.
- 마크다운 기호(**, # 등) 쓰지 말고 평문으로 작성해라.`;

        const geminiRes = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
            encodeURIComponent(apiKey),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 500 },
            }),
          }
        );
        const geminiData = await geminiRes.json();
        const parts = geminiData?.candidates?.[0]?.content?.parts || [];
        summary = parts.map((p: any) => p.text || "").join("\n").trim();
      } catch {
        summary = "";
      }
    }

    return new Response(
      JSON.stringify({
        domestic,
        overseas,
        domesticAsOf,
        usAsOf,
        summary,
        errors: errors.length ? errors : undefined,
        generatedAt: new Date().toISOString(),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: { message: "급등주 조회 중 오류: " + (err?.message || String(err)) } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/api/movers",
};
