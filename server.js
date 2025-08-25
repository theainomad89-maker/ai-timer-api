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

const SYSTEM = `You are a workout timer expert. Convert workout descriptions into precise, runnable timer sequences.

CRITICAL RULES:
1. Output ONLY valid JSON - no prose, no explanations
2. For HIIT/Interval workouts: Each exercise gets its own timer event, rest periods are separate events
3. For EMOM: Each minute is a separate event with proper odd/even labeling
4. Always include total_minutes calculated from the actual workout duration
5. Never treat "rest" as an exercise - it's a rest period between exercises
6. If text says "rest" after exercises, create proper rest events

REQUIRED JSON STRUCTURE:
{
  "title": "Workout Name",
  "total_minutes": number,
  "blocks": [
    {
      "type": "INTERVAL",
      "work_seconds": number,
      "rest_seconds": number,
      "sets": number,
      "sequence": [
        {
          "name": "Exercise Name",
          "seconds": number,
          "rest_after_seconds": number (optional)
        }
      ]
    }
  ]
}

EXAMPLES:
- "20s A, 20s B, rest" → sequence: [A(20s), B(20s, rest_after_seconds: 15)]
- "EMOM: odd burpees, even plank" → 60s events alternating between exercises
- "10 rounds: 30s work, 15s rest" → 10 work events + 9 rest events

Return JSON with: title, total_minutes, blocks[].`;

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

function analyzeAndFixSequence(sequence, text) {
  if (!Array.isArray(sequence)) return sequence;
  
  const fixed = [];
  let hasRest = false;
  
  for (let i = 0; i < sequence.length; i++) {
    const item = sequence[i];
    const name = String(item.name || "").toLowerCase();
    
    // If this is a rest item, convert it properly
    if (name.includes("rest") || name === "rest") {
      hasRest = true;
      // Remove the rest item from sequence - it will be added as rest_after_seconds
      continue;
    }
    
    // Check if next item is rest or if we need to add rest
    let restAfter = 0;
    if (i < sequence.length - 1) {
      const nextItem = sequence[i + 1];
      const nextName = String(nextItem.name || "").toLowerCase();
      if (nextName.includes("rest") || nextName === "rest") {
        restAfter = nextItem.duration || nextItem.seconds || 15;
        hasRest = true;
      }
    }
    
    fixed.push({
      name: item.name || item.exercise || "Work",
      seconds: Number(item.duration || item.seconds || item.duration_seconds || 20),
      ...(restAfter > 0 ? { rest_after_seconds: restAfter } : {})
    });
  }
  
  // If no rest was found but text mentions rest, add default rest
  if (!hasRest && /rest/i.test(text)) {
    if (fixed.length > 0) {
      fixed[fixed.length - 1].rest_after_seconds = 15; // Default 15s rest
    }
  }
  
  return fixed;
}

function normalizeAIToWorkoutJSON(ai, text) {
  // Already in our schema?
  try { 
    // Basic validation that it has required fields
    if (ai && typeof ai.title === "string" && Array.isArray(ai.blocks)) {
      return ai;
    }
  } catch {}

  // New AI format: { blocks: [{ rounds, exercises: [{name, duration_seconds}] }] }
  if (ai && Array.isArray(ai.blocks) && ai.blocks[0]?.exercises) {
    const block = ai.blocks[0];
    if (Array.isArray(block.exercises)) {
      const seq = analyzeAndFixSequence(block.exercises, text);
      const sets = Number(block.rounds || 1);
      const work = seq[0]?.seconds || 20;

      return {
        title: ai.title || "Intervals",
        total_minutes: Number(ai.total_minutes || Math.ceil((sets * seq.reduce((a,b)=>a+b.seconds+(b.rest_after_seconds||0),0))/60) || 10),
        blocks: [{ type:"INTERVAL", work_seconds: work, rest_seconds: 0, sets, sequence: seq }],
        cues: { start:true, last_round:true, halfway: sets>=8, tts:true },
        debug: { used_ai:true, inferred_mode:"INTERVAL(sequence)", notes:"normalized blocks/exercises format" }
      };
    }
  }

  // Common raw shape #1: { workout_type, rounds, exercises:[{name,duration}], total_minutes }
  if (ai && ai.workout_type === "INTERVAL" && Array.isArray(ai.exercises)) {
    const seq = analyzeAndFixSequence(ai.exercises, text);
    const sets = Number(ai.rounds || ai.sets || 1);
    const work = seq[0]?.seconds || 20;

    const candidate = {
      title: ai.title || "Intervals",
      total_minutes: Number(ai.total_minutes || Math.ceil((sets * seq.reduce((a,b)=>a+b.seconds+(b.rest_after_seconds||0),0))/60) || 10),
      blocks: [{ type:"INTERVAL", work_seconds: work, rest_seconds: 0, sets, sequence: seq }],
      cues: { start:true, last_round:true, halfway: sets>=8, tts:true },
      debug: { used_ai:true, inferred_mode:"INTERVAL(sequence)", notes:"normalized workout_type/exercises" }
    };
    return candidate;
  }

  // EMOM coercion if text says EMOM
  if (/(?:\bEMOM\b|every\s+minute)/i.test(text)) {
    const m = text.match(/(\d{1,3})\s*-?\s*(?:min|minute)/i);
    const minutes = m ? parseInt(m[1],10) : Number(ai.total_minutes || 20);
    const instr = [];
    const odd = text.match(/odd[^a-z0-9]+([^.;\n]+)/i)?.[1]?.trim();
    const even = text.match(/even[^a-z0-9]+([^.;\n]+)/i)?.[1]?.trim();
    if (odd) instr.push({ minute_mod:"odd", name: odd });
    if (even) instr.push({ minute_mod:"even", name: even });
    if (!instr.length) instr.push({ name:"Work" });

    const candidate = {
      title: `${minutes}-min EMOM Workout`,
      total_minutes: minutes,
      blocks: [{ type:"EMOM", minutes, instructions: instr }],
      cues: { start:true, last_round:true, halfway: minutes>=10, tts:true },
      debug: { used_ai:true, inferred_mode:"EMOM", notes:"coerced due to EMOM text" }
    };
    return candidate;
  }

  throw new Error("Unrecognized AI response");
}

app.get("/health", async () => ({ ok: true }));

app.post("/generate", async (req, reply) => {
  const body = req.body || {};
  const text = String(body.text || "");

  console.log(`Processing: "${text.substring(0, 100)}..."`);

  // Prefer AI first; deterministic as fallback
  try {
    const prompt = `Workout description:\n${text}\n\nAnalyze this carefully and create a precise timer sequence. Remember: rest periods are separate from exercises, and each exercise gets its own timer event. Return valid JSON only.`;
    const resp = await openai.chat.completions.create({
      model: "gpt-4",
      temperature: 0.1, // Lower temperature for more consistent output
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
