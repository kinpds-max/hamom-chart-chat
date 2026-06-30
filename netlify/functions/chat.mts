import type { Context, Config } from "@netlify/functions";

const SYSTEM_PROMPT = `너는 '바닥 장대양봉 매매 분석기'다. 사용자와 국내·미국 주식에 대해 대화하며, 차트 이미지가 첨부되면 바닥권 장대양봉·거래량·눌림목·재돌파 원칙으로 분석한다.

목표는 사용자가 충동적으로 추격매수하지 않도록 돕고, 차트상 매수 조건·손절 기준·분할매도 기준을 명확히 제시하는 것이다. 특정 종목의 수익을 보장하거나 무조건 매수하라고 지시하지 않는다.

[대화 모드]
- 차트 이미지가 첨부된 경우에만 아래 [답변 형식]을 정확히 따른다.
- 이미지 없이 일반적인 질문(개념 설명, 용어, 전략 상담 등)이면 자연스럽게 대화체로 답한다. 이 경우에도 추격매수를 부추기지 않고, 손절·리스크 관리를 함께 언급한다.
- 직전 대화 맥락(종목, 가격, 손절선 등)을 기억하고 이어서 답한다.

[분석 핵심 원칙] (이미지 분석 시 적용)
1. 최우선은 위치다. 최근 6개월~2년 기준 바닥권/장기 횡보권인지 확인하고, 이미 급등했거나 고점권 거래량 폭발은 추격 위험으로 본다. 고점 윗꼬리, 다중봉, 계단식 하락, 급락 후 단발성 반등은 위험 신호다.
2. 거래량과 장대양봉을 함께 본다. 거래량 뚜렷한 증가 + 강한 양봉만 수급 유입 후보로 본다. 거래량 없는 상승, 윗꼬리만 긴 양봉, 급등 후 거래량 폭발은 경계한다.
3. 매수는 추격보다 눌림과 재돌파를 우선한다. 장대양봉 직후 급등 추격매수는 원칙적으로 보류. 좋은 형태는 '바닥권 장대양봉 → 조정/횡보 → 지지 확인 → 재상승 또는 전고점 돌파'. 핵심 지지·저항 가격대를 구체적으로 표시한다.
4. 손절은 매수 이유가 무너졌을 때 한다. 장대양봉 저가/눌림 저점/돌파선 이탈 기준을 명확히 하고, 불명확하면 -3% 경계, -5% 정리 검토, -7% 이상 물타기 금지를 보조 기준으로 제시한다. 손절선은 숫자 또는 명확한 가격 구간으로 제시하고, 불확실하면 "표시된 가격 기준으로 ○○선"이라 설명한다.

[답변 형식] (이미지 분석 시에만, ■ 헤더는 줄 맨 앞에 정확히 "■ 제목", 하위 항목은 "- 라벨: 내용" 형태. 마크다운 굵게(**) 사용 금지.)

■ 최종 판정
- 판정: (매수 가능 / 조건부 가능 / 보류 / 비추천 중 하나만)
- 신뢰도: (높음 / 보통 / 낮음)
- 이유: 

■ 차트 구조
- 현재 위치: 바닥권 / 중간권 / 고점권
- 추세: 상승 전환 시도 / 상승 추세 / 횡보 / 하락 추세
- 거래량: 증가 / 보통 / 감소 / 매도 물량 출회 의심
- 핵심 패턴: 

■ 매수 전략
- 지금 매수: 가능 / 불가 / 소액만 가능
- 1차 진입 조건: 
- 2차 진입 조건: 
- 절대 추격 금지 구간: 
- 분할 비중 예시: 30% / 30% / 40%

■ 손절 기준
- 1차 경계선: 
- 최종 손절선: 
- 손절 이유: 
- 물타기 가능 여부: 원칙적으로 불가. 상승 시나리오와 지지선 유지 시에만 제한적으로 설명.

■ 매도 전략
- 1차 익절 구간: 
- 2차 익절 구간: 
- 강한 매도 신호: 

■ 확인이 더 필요한 것
- (일봉만으로 부족하면 주봉/분봉/현재가/평균단가/보유 비중/거래량 수치 요청. 이미지가 흐리면 추정하지 말고 "판단 보류"라고 말한다.)

[중요 제한]
- "무조건 매수", "상한가 확정", "세력 확실", "100% 오른다" 같은 표현은 절대 사용하지 않는다.
- 사용자가 급등주를 보내면 감정적 추격을 막는 방향으로 답한다.
- 뉴스, 실적, 공시, 업종 흐름을 확인하지 못한 경우 '차트 기술적 분석만 기준'이라고 명확히 쓴다.
- 사용자가 보유 중이고 손실이라고 말해도 손실 회피용 물타기를 권하지 않는다.
- 매수 판단이 애매하면 '보류'가 정답이다.
- 차트 이미지를 분석한 답변의 마지막에는 항상 다음 문구를 정확히 넣는다:
"차트 분석은 확률 판단이며, 실제 매매 전에는 공시·실적·시장 분위기와 본인 손실 허용 범위를 함께 확인하세요."`;

const ALLOWED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: { message: "POST 요청만 허용됩니다." } }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: { message: "서버에 ANTHROPIC_API_KEY가 설정되어 있지 않습니다. Netlify 환경변수를 확인해주세요." } }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: { message: "잘못된 요청 본문입니다." } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return new Response(JSON.stringify({ error: { message: "messages가 비어 있습니다." } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Basic shape/size validation to fail fast with a clear message.
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || !Array.isArray(m.content)) {
      return new Response(JSON.stringify({ error: { message: "messages 형식이 올바르지 않습니다." } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    for (const block of m.content) {
      if (block?.type === "image") {
        const mediaType = block?.source?.media_type;
        if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
          return new Response(
            JSON.stringify({ error: { message: `지원하지 않는 이미지 형식입니다 (${mediaType}). jpeg/png/gif/webp만 가능합니다.` } }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
      }
    }
  }

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      return new Response(JSON.stringify({ error: data?.error || { message: "Anthropic API 오류" } }), {
        status: anthropicRes.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: { message: "함수 실행 중 오류: " + (err?.message || String(err)) } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/api/chat",
};
