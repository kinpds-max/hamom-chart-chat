import type { Context, Config } from "@netlify/functions";

const SOURCES = [
  { sosok: "0", market: "코스피" },
  { sosok: "1", market: "코스닥" },
];

function decode(buf: ArrayBuffer): string {
  try {
    // 네이버 금융 구 페이지는 EUC-KR 인코딩을 쓴다.
    return new TextDecoder("euc-kr").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
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
    const tokens = text.match(/[\d,]+\.?\d*%?/g) || [];
    const pctToken = tokens.find((t) => t.includes("%"));
    const changePct = pctToken ? parseFloat(pctToken.replace("%", "").replace(/,/g, "")) : null;
    const isDown = /하락|↓|▼|-\s*\d/.test(text) && !/상승|↑|▲/.test(text);

    const numbers = tokens
      .filter((t) => !t.includes("%"))
      .map((t) => parseFloat(t.replace(/,/g, "")))
      .filter((n) => !isNaN(n) && n > 0);

    if (numbers.length === 0 || changePct === null) continue;

    const price = numbers[0];
    const volume = numbers.length > 1 ? Math.max(...numbers.slice(1)) : null;

    out.push({
      code: codeMatch[1],
      name,
      market,
      price,
      changePct: isDown && changePct > 0 ? -changePct : changePct,
      volume,
    });
  }
  return out;
}

async function fetchMarket(sosok: string, market: string) {
  const url = `https://finance.naver.com/sise/sise_rise.naver?sosok=${sosok}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`네이버 금융 응답 오류 (${market}): ${res.status}`);
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
      ...SOURCES.map((s) => fetchMarket(s.sosok, s.market)),
      fetchUSGainers(),
    ]);
    const labels = [...SOURCES.map((s) => s.market), "미국"];
    let movers: any[] = [];
    const errors: string[] = [];

    results.forEach((r, i) => {
      if (r.status === "fulfilled") movers = movers.concat(r.value);
      else errors.push(`${labels[i]}: ${(r as PromiseRejectedResult).reason?.message || r.reason}`);
    });

    movers.sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
    movers = movers.slice(0, 20);

    // 모든 종목은 기본적으로 '추격 금지' 상태로 표시한다. 매수 판단이 아니라 감시 목적이다.
    movers = movers.map((m) => ({ ...m, status: "추격 금지 · 관찰" }));

    let summary = "";
    const apiKey = Netlify.env.get("GEMINI_API_KEY");
    if (apiKey && movers.length > 0) {
      try {
        const table = movers
          .slice(0, 12)
          .map((m) => `${m.name}(${m.market}, ${m.code}): 현재가 ${m.price}, 등락률 ${m.changePct > 0 ? "+" : ""}${m.changePct}%${m.volume ? `, 거래량 ${m.volume.toLocaleString()}` : ""}`)
          .join("\n");

        const prompt = `다음은 오늘 국내 증시(코스피·코스닥)에서 등락률 상위에 오른 종목 리스트다:

${table}

이 리스트를 보고 2~4문장으로 한국어 코멘트를 작성해라. 반드시 지켜야 할 규칙:
- "지금 사라", "추격 매수해도 된다", "세력 확실", "무조건" 같은 표현을 절대 쓰지 않는다.
- 이 종목들은 이미 단기 급등한 상태이므로 지금 추격 매수하기보다, 조정·눌림 후 지지가 확인되면 재평가하는 것이 원칙이라는 점을 명확히 전달한다.
- 리스트 중 특정 한두 종목이 유난히 거래량이 크거나 등락률이 크면 그 사실만 객관적으로 언급해도 되지만, 매수 추천으로 이어지면 안 된다.
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
        movers,
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
