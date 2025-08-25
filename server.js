import Fastify from "fastify";
import OpenAI from "openai";

const app = Fastify();
app.addHook('onRequest', (request, reply, done) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type");
  if (request.method === "OPTIONS") {
    reply.send();
  } else {
    done();
  }
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Timeline-based schema - much simpler and more explicit
const SYSTEM = `You convert free-form workout text (WOD/blog/social post) into a concrete timer timeline.

CRITICAL RULES:
- Expand ALL steps explicitly: include every work block, every between-exercise rest, and between-round rests as separate items.
- Output only JSON matching the provided schema.
- Prefer seconds for durations.
- Add {round,index} where sensible (1-based).
- If the text implies a scheme (e.g., ":45 work // :15 rest", "Rest 2:30 after each round"), honor it.
- If the text says EMOM/Tabata/etc., use that only to interpret timing; DO NOT rely on the label alone—infer durations from the actual text.

REQUIRED JSON STRUCTURE:
{
  "title": "string",
  "timeline": [
    {
      "kind": "work" | "rest" | "round_rest" | "prep" | "cooldown",
      "label": "string",
      "seconds": number,
      "round": number (optional, 1-based),
      "index": number (optional, 1-based)
    }
  ]
}

EXAMPLES:
- "4 Rounds: 45s work, 15s rest between exercises, 2:30 rest between rounds" → timeline with 4 rounds × (work+rest) + 3 between-round rests
- "EMOM for 10 minutes: 10 pushups" → 10 items of 60s each
- "Tabata 8 rounds: 20s work, 10s rest" → 16 items alternating work/rest

Return ONLY valid JSON matching this exact schema.`;

// Few-shot examples for clarity
const USER_EXAMPLE = `
Input:
4 Rounds
:45 WORK // :15 REST
Run
DB Goblet Squat (50/35 lb)
Run
DB Curl + Press (40/20 lb)
Run
Box Step Up (20 in)
Run
Plank
*Rest 2:30 after each round

Rules from text:
- 4 rounds
- 45s work, 15s rest between every station
- 2:30 rest between rounds
Return a timeline that enumerates all steps for all rounds.
Title it "4 Rounds Workout".
`;

app.get("/health", async () => ({ ok: true }));

app.post("/generate", async (req, reply) => {
  const body = req.body || {};
  const text = String(body.text || "");

  console.log(`Processing: "${text.substring(0, 100)}..."`);

  try {
    // AI generation with timeline focus
    const prompt = `Workout description:\n${text}\n\nAnalyze this carefully and create a precise timeline. Remember: expand ALL steps explicitly including every work block, every rest period, and every between-round rest. Return valid JSON only.`;
    
    const resp = await openai.chat.completions.create({
      model: "gpt-4",
      temperature: 0.1,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER_EXAMPLE },
        { role: "user", content: prompt }
      ],
    });

    const raw = resp.choices?.[0]?.message?.content || "";
    console.log("OpenAI response:", raw.substring(0, 100) + "...");

    let json;
    try { 
      json = JSON.parse(raw); 
    } catch { 
      throw new Error("Invalid JSON from OpenAI"); 
    }

    // Validate the timeline structure
    if (!json.timeline || !Array.isArray(json.timeline) || json.timeline.length === 0) {
      throw new Error("AI response missing timeline array");
    }

    // Validate each timeline item
    const validTimeline = json.timeline.map((item, index) => {
      if (!item.kind || !item.label || typeof item.seconds !== 'number') {
        throw new Error(`Invalid timeline item at index ${index}`);
      }
      
      // Ensure seconds is positive integer
      const seconds = Math.max(1, Math.round(item.seconds));
      
      return {
        kind: item.kind,
        label: item.label,
        seconds,
        round: item.round || undefined,
        index: item.index || undefined
      };
    });

    // Compute total seconds
    const totalSeconds = validTimeline.reduce((sum, item) => sum + item.seconds, 0);

    const result = {
      title: json.title || "Generated Workout",
      timeline: validTimeline,
      total_seconds: totalSeconds,
      debug: {
        used_ai: true,
        notes: "AI generated timeline"
      }
    };

    return reply.send(result);

  } catch (aiError) {
    console.warn("AI failed, using deterministic parser:", aiError?.message || aiError);
    
    // Fallback: create a simple timeline from text
    const fallback = createFallbackTimeline(text);
    if (fallback) return reply.send(fallback);

    // Final fallback
    const fb = {
      title: "Fallback Workout",
      timeline: [
        { kind: "work", label: "Work", seconds: 30, round: 1, index: 1 },
        { kind: "rest", label: "Rest", seconds: 15, round: 1, index: 2 }
      ],
      total_seconds: 45,
      debug: { used_ai: false, notes: "fallback generated" }
    };
    return reply.send(fb);
  }
});

// Simple fallback timeline generator
function createFallbackTimeline(text) {
  try {
    // Try to extract basic workout info
    const roundsMatch = text.match(/(\d+)\s*rounds?/i);
    const rounds = roundsMatch ? parseInt(roundsMatch[1]) : 1;
    
    // Look for work/rest patterns
    const workMatch = text.match(/(\d+)\s*s(?:ec)?\s*work/i);
    const restMatch = text.match(/(\d+)\s*s(?:ec)?\s*rest/i);
    
    if (workMatch) {
      const workSeconds = parseInt(workMatch[1]);
      const restSeconds = restMatch ? parseInt(restMatch[1]) : 15;
      
      const timeline = [];
      for (let round = 1; round <= rounds; round++) {
        timeline.push({ kind: "work", label: "Work", seconds: workSeconds, round, index: 1 });
        if (round < rounds) {
          timeline.push({ kind: "rest", label: "Rest", seconds: restSeconds, round, index: 2 });
        }
      }
      
      return {
        title: `${rounds} Round${rounds > 1 ? 's' : ''} Workout`,
        timeline,
        total_seconds: timeline.reduce((sum, item) => sum + item.seconds, 0),
        debug: { used_ai: false, notes: "deterministic fallback" }
      };
    }
    
    return null;
  } catch (error) {
    console.error("Fallback generation failed:", error);
    return null;
  }
}

const port = Number(process.env.PORT) || 8080;
app.listen({ port, host: "0.0.0.0" }).then(() => console.log("API up on", port));
