import Fastify from "fastify";
import OpenAI from "openai";

const app = Fastify({ 
  logger: true,
  connectionTimeout: 65000, // 65 seconds
  keepAliveTimeout: 65000   // 65 seconds
});

// Enable CORS
app.addHook('onRequest', (request, reply, done) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type');
  
  if (request.method === 'OPTIONS') {
    reply.send();
    return;
  }
  done();
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM = `You are a workout timer expert. Generate a timeline of work and rest events.

Output ONLY valid JSON with this structure:
{
  "title": "string",
  "total_seconds": number,
  "timeline": [
    {
      "kind": "work" | "rest" | "round_rest",
      "label": "string",
      "seconds": number,
      "round": number
    }
  ]
}

RULES:
- "work" = exercise time
- "rest" = short rest between exercises (15-30s)
- "round_rest" = longer rest between rounds (60s+)
- Each event gets its own timer
- Round numbers help group related events
- Total seconds should include all work + rest time

EXAMPLE:
"4 Rounds: 45s Run, 15s rest, 45s Squats, 15s rest, 45s Plank, 2:30 rest between rounds" →
{
  "title": "4 Rounds Workout",
  "total_seconds": 1200,
  "timeline": [
    {"kind": "work", "label": "Run", "seconds": 45, "round": 1},
    {"kind": "rest", "label": "Rest", "seconds": 15, "round": 1},
    {"kind": "work", "label": "Squats", "seconds": 45, "round": 1},
    {"kind": "rest", "label": "Rest", "seconds": 15, "round": 1},
    {"kind": "work", "label": "Plank", "seconds": 45, "round": 1},
    {"kind": "round_rest", "label": "Rest between rounds", "seconds": 150, "round": 1},
    {"kind": "work", "label": "Run", "seconds": 45, "round": 2},
    {"kind": "rest", "label": "Rest", "seconds": 15, "round": 2},
    {"kind": "work", "label": "Squats", "seconds": 45, "round": 2},
    {"kind": "rest", "label": "Rest", "seconds": 15, "round": 2},
    {"kind": "work", "label": "Plank", "seconds": 45, "round": 2},
    {"kind": "round_rest", "label": "Rest between rounds", "seconds": 150, "round": 2},
    {"kind": "work", "label": "Run", "seconds": 45, "round": 3},
    {"kind": "rest", "label": "Rest", "seconds": 15, "round": 3},
    {"kind": "work", "label": "Squats", "seconds": 45, "round": 3},
    {"kind": "rest", "label": "Rest", "seconds": 15, "round": 3},
    {"kind": "work", "label": "Plank", "seconds": 45, "round": 3},
    {"kind": "round_rest", "label": "Rest between rounds", "seconds": 150, "round": 3},
    {"kind": "work", "label": "Run", "seconds": 45, "round": 4},
    {"kind": "rest", "label": "Rest", "seconds": 15, "round": 4},
    {"kind": "work", "label": "Squats", "seconds": 45, "round": 4},
    {"kind": "rest", "label": "Rest", "seconds": 15, "round": 4},
    {"kind": "work", "label": "Plank", "seconds": 45, "round": 4}
  ]
}

Remember: Output ONLY valid JSON matching this exact schema.`;

// ---------- Simple fallback parser ----------
function simpleFallback(text) {
  // Very basic fallback for when AI fails
  return {
    title: "Simple Workout",
    total_seconds: 600,
    timeline: [
      { kind: "work", label: "Work", seconds: 45, round: 1 },
      { kind: "rest", label: "Rest", seconds: 15, round: 1 },
      { kind: "work", label: "Work", seconds: 45, round: 1 },
      { kind: "rest", label: "Rest", seconds: 15, round: 1 },
      { kind: "work", label: "Work", seconds: 45, round: 1 },
      { kind: "round_rest", label: "Rest between rounds", seconds: 60, round: 1 },
      { kind: "work", label: "Work", seconds: 45, round: 2 },
      { kind: "rest", label: "Rest", seconds: 15, round: 2 },
      { kind: "work", label: "Work", seconds: 45, round: 2 },
      { kind: "rest", label: "Rest", seconds: 15, round: 2 },
      { kind: "work", label: "Work", seconds: 45, round: 2 }
    ]
  };
}

app.get("/health", async () => ({ ok: true }));

app.post("/generate", async (req, reply) => {
  // Set request timeout to 60 seconds
  req.raw.setTimeout(60000);
  
  const body = req.body || {};
  const text = String(body.text || "");

  console.log(`Processing: "${text.substring(0, 100)}..."`);

  try {
    const prompt = `Workout description:\n${text}\n\nCreate a timeline of work and rest events. Return valid JSON only.`;
    const resp = await openai.chat.completions.create({
      model: "gpt-4",
      temperature: 0.1,
      timeout: 60000, // 60 seconds timeout
      messages: [ { role: "system", content: SYSTEM }, { role: "user", content: prompt } ],
    });
    
    const raw = resp.choices?.[0]?.message?.content || "";
    console.log("OpenAI response:", raw.substring(0, 100) + "...");
    
    try {
      const json = JSON.parse(raw);
      
      // Validate the timeline structure
      if (!json.timeline || !Array.isArray(json.timeline)) {
        throw new Error("Invalid timeline structure");
      }
      
      json.debug = { used_ai: true };
      return reply.send(json);
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      throw new Error("Invalid JSON from OpenAI");
    }
  } catch (aiError) {
    console.error("OpenAI error:", aiError.message);
    
    // Use simple fallback
    const fallback = simpleFallback(text);
    fallback.debug = { used_ai: false, notes: "AI failed, using fallback" };
    return reply.send(fallback);
  }
});

const port = Number(process.env.PORT) || 8080;
app.listen({ port, host: "0.0.0.0" }).then(()=> console.log("API up on", port));
