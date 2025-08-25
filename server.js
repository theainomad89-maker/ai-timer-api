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

function extractOddEven(text){
  const odd = text.match(/odd[^\w]+([^.;\n]+)/i)?.[1]?.trim();
  const even = text.match(/even[^\w]+([^.;\n]+)/i)?.[1]?.trim();
  return { odd, even };
}

function parseEMOM(text) {
  const m = text.match(/(\d{1,3})\s*-?\s*(?:min|minute)/i);
  const minutes = m ? parseInt(m[1],10) : undefined;
  if (!/(\bEMOM\b|every\s+minute)/i.test(text) || !minutes) return null;

  const { odd, even } = extractOddEven(text);
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
  const rounds = num(text.match(/total\s+(\d{1,3})\s+rounds?/i)?.[1]) || num(text.match(/(\d{1,3})\s+rounds?/i)?.[1]);
  const items = [...text.matchAll(/(\d{1,3})\s*s(?:ec)?\s+([^,.;\n]+)/ig)].map(m=>({ seconds: parseInt(m[1],10), name: m[2].trim() }));
  if (!rounds || items.length<1) return null;
  let rest_between = 0;
  if (/rest/i.test(text) && !items[items.length-1].name.toLowerCase().includes("rest")) {
    const restm = text.match(/rest[^\d]*(\d{1,3})?/i);
    rest_between = restm?.[1] ? parseInt(restm[1],10) : 30;
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

function normalizeAIToWorkoutJSON(ai, text){
  // If already in expected shape
  if (ai && Array.isArray(ai.blocks)) return ai;
  
  // INTERVAL with exercises array - handle multiple formats
  if ((ai?.type === "INTERVAL" || ai?.workout_type === "INTERVAL") && Array.isArray(ai.exercises)) {
    const rounds = ai.rounds || 10;
    const seq = [];
    
    for (const ex of ai.exercises) {
      const name = ex.name || ex.exercise || "Work";
      const secs = ex.duration_seconds || ex.duration || 30;
      
      // Handle rest items by attaching to previous exercise
      if (/rest/i.test(name)) {
        if (seq.length > 0) {
          seq[seq.length - 1].rest_after_seconds = secs;
        }
        continue;
      }
      
      seq.push({ name, seconds: secs });
    }
    
    return {
      title: ai.title || "Intervals",
      total_minutes: ai.total_minutes || Math.ceil((rounds * seq.reduce((a,b)=>a + b.seconds + (b.rest_after_seconds||0),0)) / 60),
      blocks: [{ 
        type: "INTERVAL", 
        work_seconds: seq[0]?.seconds || 30, 
        rest_seconds: 0, 
        sets: rounds, 
        sequence: seq 
      }],
      cues: { start:true, last_round:true, halfway: rounds>=8, tts:true },
      debug: { used_ai:true, inferred_mode:"INTERVAL(sequence)" }
    };
  }
  
  // EMOM normalization
  if (/(\bEMOM\b|every\s+minute)/i.test(text)) {
    const minutes = ai?.total_minutes || num(text.match(/(\d{1,3})\s*-?\s*(?:min|minute)/i)?.[1]) || 20;
    const { odd, even } = extractOddEven(text);
    const instructions = [];
    if (odd) instructions.push({ minute_mod: "odd", name: odd });
    if (even) instructions.push({ minute_mod: "even", name: even });
    if (!instructions.length) instructions.push({ name: "Work" });
    return {
      title: ai?.title || `${minutes}-min EMOM`,
      total_minutes: minutes,
      blocks: [{ type: "EMOM", minutes, instructions }],
      cues: { start:true, last_round:true, halfway: minutes>=10, tts:true },
      debug: { used_ai:true, inferred_mode:"EMOM", notes:"Normalized from AI" }
    };
  }
  
  // CIRCUIT normalization
  if (ai?.type === "CIRCUIT" || ai?.workout_type === "CIRCUIT") {
    const rounds = ai.rounds || 3;
    const exercises = (ai.exercises || []).map((ex) => ({
      name: ex.name || ex.exercise || "Exercise",
      seconds: ex.duration_seconds || ex.duration || 30,
      reps: ex.reps || undefined,
      rest_after_seconds: ex.rest_after_seconds || 0,
    }));
    
    return {
      title: ai.title || "Circuit",
      total_minutes: ai.total_minutes || Math.ceil((rounds * exercises.reduce((a,b)=>a + (b.seconds||30) + (b.rest_after_seconds||0),0)) / 60),
      blocks: [{ type: "CIRCUIT", rounds, exercises, rest_between_rounds_seconds: 0 }],
      cues: { start:true, last_round:true, halfway: rounds>=5, tts:true },
      debug: { used_ai:true, inferred_mode:"CIRCUIT" }
    };
  }
  
  // TABATA normalization
  if (ai?.type === "TABATA" || ai?.workout_type === "TABATA") {
    const rounds = ai.rounds || 8;
    const work = ai.work_seconds || ai.work || 20;
    const rest = ai.rest_seconds || ai.rest || 10;
    
    return {
      title: ai.title || `Tabata ${rounds}x${work}/${rest}`,
      total_minutes: ai.total_minutes || Math.ceil((rounds*(work+rest))/60),
      blocks: [{ type: "TABATA", rounds, work_seconds: work, rest_seconds: rest, exercise: "Tabata" }],
      cues: { start:true, last_round:true, halfway: rounds>=8, tts:true },
      debug: { used_ai:true, inferred_mode:"TABATA" }
    };
  }
  
  return null;
}

app.get("/health", async () => ({ ok: true }));

app.post("/generate", async (req, reply) => {
  const body = req.body || {};
  const text = String(body.text || "");
  const user = body.user || { level: "beginner" };

  console.log(`Processing: "${text.substring(0, 100)}..." for ${user.level} user`);

  // Prefer AI first; deterministic as fallback
  try {
    const prompt = `User level: ${user.level}.\nWorkout description:\n${text}\nReturn valid JSON only.`;
    const resp = await openai.chat.completions.create({
      model: "gpt-4",
      temperature: 0.2,
      messages: [ { role: "system", content: SYSTEM }, { role: "user", content: prompt } ],
    });
    const raw = resp.choices?.[0]?.message?.content || "";
    console.log("OpenAI response:", raw.substring(0, 100) + "...");

    let json;
    try { json = JSON.parse(raw); } catch { throw new Error("Invalid JSON from OpenAI"); }

    // Normalize to our schema
    const normalized = normalizeAIToWorkoutJSON(json, text);
    if (normalized) return reply.send(normalized);

    // If we reach here return original JSON
    json.debug = { ...(json.debug||{}), used_ai: true, notes: "Raw AI shape" };
    return reply.send(json);
  } catch (aiError) {
    console.warn("AI failed, using deterministic parser:", aiError?.message || aiError);
    const det = deterministicParse(text);
    if (det) return reply.send(det);

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
