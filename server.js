import Fastify from "fastify";
import OpenAI from "openai";

const app = Fastify();

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

const SYSTEM = `You convert messy workout descriptions into a strict JSON schema.
Rules:
- Output ONLY JSON matching the schema.
- If ambiguous, infer safe defaults: seconds if unit missing; rest 15–30s; beginner intensity by default.
- Support EMOM, INTERVAL (optionally with a per-set sequence), CIRCUIT, TABATA.
- Include title, total_minutes.
- For EMOM: minutes == total minutes; allow odd/even instructions.
- For text like "Odd: X, Even: Y", set minute_mod accordingly.
- Never output prose. Only JSON.`;

// ---------- Deterministic parsing helpers ----------
const num = (s) => (s ? parseInt(s,10) : undefined);

function parseEMOM(text) {
  const m = text.match(/(\d{1,3})\s*-?\s*(?:min|minute)/i);
  const minutes = m ? parseInt(m[1],10) : undefined;
  if (!/(\bEMOM\b|every\s+minute)/i.test(text) || !minutes) return null;

  // Odd/even detection
  const odd = text.match(/odd[^\w]+([^.;\n]+)/i)?.[1]?.trim();
  const even = text.match(/even[^\w]+([^.;\n]+)/i)?.[1]?.trim();
  const instructions = [];
  if (odd) instructions.push({ minute_mod: "odd", name: odd });
  if (even) instructions.push({ minute_mod: "even", name: even });
  if (!instructions.length) instructions.push({ name: "Work" });

  return {
    title: `${minutes}-min EMOM Workout`,
    total_minutes: minutes,
    blocks: [{ type: "EMOM", minutes, instructions }],
    cues: { start: true, last_round: true, halfway: minutes>=10, tts: true },
    debug: { used_ai: false, inferred_mode: "EMOM" }
  };
}

function parseTabata(text) {
  if (!/\btabata\b/i.test(text)) return null;
  const rounds = num(text.match(/(\d{1,2})\s*rounds/i)?.[1]) || 8;
  const work = num(text.match(/(\d{1,3})\s*s(?:ec)?\s*work/i)?.[1]) || 20;
  const rest = num(text.match(/(\d{1,3})\s*s(?:ec)?\s*rest/i)?.[1]) || 10;
  return {
    title: `Tabata ${rounds}x${work}/${rest}`,
    total_minutes: Math.ceil((rounds*(work+rest))/60),
    blocks: [{ type: "TABATA", rounds, work_seconds: work, rest_seconds: rest, exercise: "Tabata" }],
    cues: { start:true, last_round:true, halfway: rounds>=8, tts:true },
    debug: { used_ai:false, inferred_mode:"TABATA" }
  };
}

function parseHiitSequence(text) {
  // e.g. "HIIT, 20s A, 20s B, 20s C, rest. That's 1 round. Total 10 rounds"
  const rounds = num(text.match(/total\s+(\d{1,3})\s+rounds?/i)?.[1]) || num(text.match(/(\d{1,3})\s+rounds?/i)?.[1]);
  const items = [...text.matchAll(/(\d{1,3})\s*s(?:ec)?\s+([^,.;\n]+)/ig)].map(m=>({ seconds: parseInt(m[1],10), name: m[2].trim() }));
  if (!rounds || items.length<1) return null;
  // If the last token includes "rest", treat as rest_between_rounds
  let rest_between = 0;
  if (/rest/i.test(text) && !items[items.length-1].name.toLowerCase().includes("rest")) {
    const restm = text.match(/rest[^\d]*(\d{1,3})?/i);
    rest_between = restm?.[1] ? parseInt(restm[1],10) : 30; // default 30s
  }
  return {
    title: `HIIT ${rounds} rounds`,
    total_minutes: Math.ceil((rounds*(items.reduce((a,b)=>a+b.seconds,0)+rest_between))/60),
    blocks: [{ type: "INTERVAL", work_seconds: items[0].seconds, rest_seconds: 0, sets: rounds, sequence: items }],
    cues: { start:true, last_round:true, halfway: rounds>=8, tts:true },
    debug: { used_ai:false, inferred_mode:"INTERVAL(sequence)" }
  };
}

function parseGenericIntervals(text) {
  // e.g. "10 rounds: 30s work, 15s rest"
  const rounds = num(text.match(/(\d{1,3})\s+rounds?/i)?.[1]);
  const work = num(text.match(/(\d{1,3})\s*s(?:ec)?\s*(?:work|on)/i)?.[1]) || num(text.match(/(\d{1,3})\s*s(?!.*rest)/i)?.[1]);
  const rest = num(text.match(/(\d{1,3})\s*s(?:ec)?\s*rest/i)?.[1]);
  if (!rounds || !work) return null;
  return {
    title: `${rounds}x${work}/${rest ?? 0} Intervals`,
    total_minutes: Math.ceil((rounds*(work+(rest??0)))/60),
    blocks: [{ type: "INTERVAL", work_seconds: work, rest_seconds: rest ?? 0, sets: rounds }],
    cues: { start:true, last_round:true, halfway: rounds>=10, tts:true },
    debug: { used_ai:false, inferred_mode:"INTERVAL" }
  };
}

function deterministicParse(text) {
  return parseEMOM(text) || parseTabata(text) || parseHiitSequence(text) || parseGenericIntervals(text);
}

app.get("/health", async () => ({ ok: true }));

app.post("/generate", async (req, reply) => {
  const body = req.body || {};
  const text = String(body.text || "");
  const user = body.user || { level: "beginner" }; // {beginner|intermediate|advanced}

  console.log(`Processing: "${text.substring(0, 100)}..." for ${user.level} user`);

  // 1) Deterministic shortcut
  const det = deterministicParse(text);
  if (det) {
    console.log("Using deterministic parse:", det.debug.inferred_mode);
    return reply.send(det);
  }

  // 2) OpenAI generation
  try {
    const prompt = `User level: ${user.level}.\nWorkout description:\n${text}\nReturn valid JSON only.`;
    const resp = await openai.chat.completions.create({
      model: "gpt-4",
      temperature: 0.2,
      messages: [ { role: "system", content: SYSTEM }, { role: "user", content: prompt } ],
    });
    
    const raw = resp.choices?.[0]?.message?.content || "";
    console.log("OpenAI response:", raw.substring(0, 100) + "...");
    
    try {
      const json = JSON.parse(raw);
      
      // 3) Post-process: if text contains EMOM but block isn't EMOM, coerce
      if (/(\bEMOM\b|every\s+minute)/i.test(text) && json.blocks?.[0]?.type !== "EMOM") {
        const minutes = json.total_minutes || num(text.match(/(\d{1,3})\s*-?\s*(?:min|minute)/i)?.[1]) || 20;
        json.blocks = [{ type: "EMOM", minutes, instructions: [{ name: "Work" }] }];
        json.debug = { ...(json.debug||{}), notes: "Coerced to EMOM due to input text", inferred_mode: "EMOM" };
      }

      json.debug = { ...(json.debug||{}), used_ai: true };
      return reply.send(json);
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      throw new Error("Invalid JSON from OpenAI");
    }
  } catch (aiError) {
    console.error("OpenAI error:", aiError.message);
    
    // 4) Final fallback: 20x40/20
    const fb = {
      title: "Fallback 20x40/20",
      total_minutes: 20,
      blocks: [{ type: "INTERVAL", work_seconds: 40, rest_seconds: 20, sets: 20 }],
      cues: { start:true, last_round:true, halfway:true, tts:true },
      debug: { used_ai:false, inferred_mode:"FALLBACK", notes: "AI parse failed" }
    };
    return reply.send(fb);
  }
});

const port = Number(process.env.PORT) || 8080;
app.listen({ port, host: "0.0.0.0" }).then(()=> console.log("API up on", port));
