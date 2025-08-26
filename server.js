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

const SYSTEM = `You are a workout timer expert. You MUST output ONLY valid JSON that exactly matches this schema.

CRITICAL: Output ONLY the JSON object below - no explanations, no prose, no extra text.

REQUIRED EXACT SCHEMA:
{
  "title": "string",
  "total_minutes": number,
  "blocks": [
    {
      "type": "EMOM" | "INTERVAL" | "CIRCUIT" | "TABATA",
      "minutes": number,           // ONLY for EMOM
      "instructions": [            // ONLY for EMOM
        {
          "minute_mod": "odd" | "even" | undefined,
          "name": "string"
        }
      ],
      "work_seconds": number,      // ONLY for INTERVAL/TABATA
      "rest_seconds": number,      // ONLY for INTERVAL/TABATA
      "sets": number,              // ONLY for INTERVAL
      "rounds": number,            // ONLY for CIRCUIT/TABATA
      "sequence": [                // ONLY for INTERVAL with complex exercises
        {
          "name": "string",
          "seconds": number,
          "rest_after_seconds": number
        }
      ],
      "exercises": [               // ONLY for CIRCUIT
        {
          "name": "string",
          "seconds": number,
          "reps": number | string
        }
      ],
      "exercise": "string",        // ONLY for TABATA
      "rest_between_rounds_seconds": number  // ONLY for CIRCUIT
    }
  ]
}

EXACT RULES:
1. EMOM: Use "type": "EMOM", include "minutes" and "instructions" array
2. TABATA: Use "type": "TABATA", include "rounds", "work_seconds", "rest_seconds", "exercise"
3. CIRCUIT: Use "type": "CIRCUIT", include "rounds", "exercises" array, "rest_between_rounds_seconds"
4. INTERVAL: Use "type": "INTERVAL", include "sets", "work_seconds", "rest_seconds"
5. INTERVAL with sequence: Add "sequence" array when multiple exercises per set
6. Rest periods: Only add rest between rounds, not after every exercise

IMPORTANT WORKOUT INTERPRETATION RULES:
- When text says "1 minute of: X, then Y" → This means 1 continuous minute where you do X first, then Y fills remaining time
- When text says "45 reps" → This is a target, not a time limit
- When text says "Max reps in remaining time" → This means fill whatever time is left after the first exercise
- Time caps (like "1 minute") apply to the ENTIRE round, not individual exercises
- Rep targets are goals within the time cap, not separate timed intervals

SPECIFIC WORKOUT PATTERN RECOGNITION:
- When you see ":45 WORK // :15 REST" → This means each exercise gets 45 seconds, then 15 seconds rest
- When you see "*Rest 2:30 after each round" → This means 2 minutes 30 seconds rest between rounds
- This pattern should use "type": "INTERVAL" with "sequence" array
- Each exercise in sequence gets its own rest_after_seconds: 15
- The rest_between_rounds_seconds should be 150 (2:30 = 150 seconds)

EXAMPLES:
EMOM: {"type": "EMOM", "minutes": 20, "instructions": [{"minute_mod": "odd", "name": "Burpees"}, {"minute_mod": "even", "name": "Plank"}]}
TABATA: {"type": "TABATA", "rounds": 8, "work_seconds": 20, "rest_seconds": 10, "exercise": "Mixed"}
CIRCUIT: {"type": "CIRCUIT", "rounds": 5, "exercises": [{"name": "Pushups", "seconds": 30}, {"name": "Squats", "seconds": 30}], "rest_between_rounds_seconds": 15}
INTERVAL: {"type": "INTERVAL", "sets": 10, "work_seconds": 30, "rest_seconds": 15}
INTERVAL with sequence: {"type": "INTERVAL", "sets": 10, "work_seconds": 20, "rest_seconds": 0, "sequence": [{"name": "Burpees", "seconds": 20}, {"name": "Mountain Climbers", "seconds": 20, "rest_after_seconds": 15}]}

SPECIFIC PATTERN EXAMPLE:
"4 Rounds\n:45 WORK // :15 REST\nRun\nDB Goblet Squat\nRun\nDB Curl + Press\nRun\nBox Step Up\nRun\nPlank\n*Rest 2:30 after each round" →
{
  "type": "INTERVAL",
  "sets": 4,
  "work_seconds": 45,
  "rest_seconds": 150,
  "sequence": [
    {"name": "Run", "seconds": 45, "rest_after_seconds": 15},
    {"name": "DB Goblet Squat", "seconds": 45, "rest_after_seconds": 15},
    {"name": "Run", "seconds": 45, "rest_after_seconds": 15},
    {"name": "DB Curl + Press", "seconds": 45, "rest_after_seconds": 15},
    {"name": "Run", "seconds": 45, "rest_after_seconds": 15},
    {"name": "Box Step Up", "seconds": 45, "rest_after_seconds": 15},
    {"name": "Run", "seconds": 45, "rest_after_seconds": 15},
    {"name": "Plank", "seconds": 45}
  ]
}

Remember: Output ONLY valid JSON matching this exact schema.`;

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

function parseWorkRestPattern(text) {
  // Parse pattern like "4 Rounds\n:45 WORK // :15 REST\nRun\nDB Goblet Squat\n*Rest 2:30 after each round"
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  
  // Check if this matches our pattern
  const hasWorkRestPattern = lines.some(l => l.includes(':45 WORK // :15 REST') || l.includes('WORK // :15 REST'));
  const hasRestAfterRounds = lines.some(l => l.includes('Rest') && l.includes('after each round'));
  
  if (!hasWorkRestPattern || !hasRestAfterRounds) return null;
  
  // Extract number of rounds
  const roundMatch = text.match(/(\d+)\s*Rounds?/i);
  if (!roundMatch) return null;
  const rounds = parseInt(roundMatch[1]);
  
  // Extract rest time between rounds
  const restMatch = text.match(/Rest\s+(\d+):(\d+)\s+after\s+each\s+round/i);
  let restBetweenRounds = 150; // default 2:30
  if (restMatch) {
    const minutes = parseInt(restMatch[1]);
    const seconds = parseInt(restMatch[2]);
    restBetweenRounds = minutes * 60 + seconds;
  }
  
  // Extract exercises (lines that don't contain special keywords)
  const exercises = [];
  const skipKeywords = ['Rounds', 'WORK', 'REST', 'Rest', 'after', 'each', 'round'];
  
  for (const line of lines) {
    if (line && !skipKeywords.some(keyword => line.includes(keyword)) && 
        !line.match(/^\d+:/) && !line.includes('//')) {
      exercises.push(line);
    }
  }
  
  if (exercises.length === 0) return null;
  
  // Build sequence with 15s rest after each exercise (except the last)
  const sequence = exercises.map((exercise, index) => ({
    name: exercise,
    seconds: 45,
    rest_after_seconds: index < exercises.length - 1 ? 15 : undefined
  }));
  
  return {
    title: `${rounds} Rounds Workout`,
    total_minutes: Math.ceil((rounds * (exercises.length * 45 + (exercises.length - 1) * 15) + (rounds - 1) * restBetweenRounds) / 60),
    blocks: [{
      type: "INTERVAL",
      sets: rounds,
      work_seconds: 45,
      rest_seconds: restBetweenRounds,
      sequence: sequence
    }],
    cues: { start: true, last_round: true, halfway: rounds >= 8, tts: true },
    debug: { used_ai: false, inferred_mode: "INTERVAL", notes: "parsed from work/rest pattern" }
  };
}

function deterministicParse(text) {
  return parseEMOM(text) || parseTabata(text) || parseHiitSequence(text) || parseGenericIntervals(text) || parseWorkRestPattern(text);
}

function analyzeAndFixSequence(sequence, text) {
  if (!Array.isArray(sequence)) return sequence;
  
  const fixed = [];
  let hasRest = false;
  let restDuration = 0;
  
  // First pass: identify rest items and their duration
  for (const item of sequence) {
    const name = String(item.name || "").toLowerCase();
    if (name.includes("rest") || name === "rest") {
      hasRest = true;
      restDuration = Number(item.duration || item.seconds || item.duration_seconds || 15);
      break;
    }
  }
  
  // Second pass: build sequence with rest_after_seconds
  for (let i = 0; i < sequence.length; i++) {
    const item = sequence[i];
    const name = String(item.name || "").toLowerCase();
    
    // Skip rest items - they become rest_after_seconds
    if (name.includes("rest") || name === "rest") {
      continue;
    }
    
    // Add exercise with rest after (except for the last exercise in sequence)
    const isLastExercise = i === sequence.length - 1 || 
      (i < sequence.length - 1 && String(sequence[i + 1].name || "").toLowerCase().includes("rest"));
    
    fixed.push({
      name: item.name || item.exercise || "Work",
      seconds: Number(item.duration || item.seconds || item.duration_seconds || 20),
      ...(hasRest && isLastExercise ? { rest_after_seconds: restDuration } : {})
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
  try {
    // Handle timeline-based AI responses (new format)
    if (ai && Array.isArray(ai.timeline)) {
      console.log("Converting timeline format to WorkoutJSON schema");
      
      // Analyze the timeline to determine workout type
      const workEvents = ai.timeline.filter(e => e.kind === "work");
      const restEvents = ai.timeline.filter(e => e.kind === "rest");
      const roundRestEvents = ai.timeline.filter(e => e.kind === "round_rest");
      
      if (workEvents.length > 0) {
        const firstWork = workEvents[0];
        const workDuration = firstWork.seconds || 45;
        const restDuration = restEvents[0]?.seconds || 15;
        const roundRestDuration = roundRestEvents[0]?.seconds || 0;
        
        // Count unique rounds
        const rounds = Math.max(...workEvents.map(e => e.round || 1));
        
        // If we have round rest, this is a circuit
        if (roundRestDuration > 0) {
          // Group exercises by round to create sequence
          const exercises = [];
          const round1Exercises = workEvents.filter(e => e.round === 1);
          
          for (const exercise of round1Exercises) {
            exercises.push({
              name: exercise.label || exercise.name || "Work",
              seconds: exercise.seconds || 45
            });
          }
          
          return {
            title: ai.title || `${rounds} Rounds Circuit`,
            total_minutes: Math.ceil(ai.total_seconds / 60),
            blocks: [{
              type: "CIRCUIT",
              rounds,
              exercises,
              rest_between_rounds_seconds: roundRestDuration
            }],
            cues: { start: true, last_round: true, halfway: rounds >= 8, tts: true },
            debug: { used_ai: true, inferred_mode: "CIRCUIT", notes: "converted from timeline format" }
          };
        } else {
          // Simple interval workout
          return {
            title: ai.title || `${rounds} Rounds Interval`,
            total_minutes: Math.ceil(ai.total_seconds / 60),
            blocks: [{
              type: "INTERVAL",
              work_seconds: workDuration,
              rest_seconds: restDuration,
              sets: rounds
            }],
            cues: { start: true, last_round: true, halfway: rounds >= 8, tts: true },
            debug: { used_ai: true, inferred_mode: "INTERVAL", notes: "converted from timeline format" }
          };
        }
      }
    }

    // Already in our schema?
    if (ai && typeof ai.title === "string" && Array.isArray(ai.blocks)) {
      // Validate each block has correct structure
      const validBlocks = ai.blocks.map(block => {
        if (block.type === "EMOM") {
          return {
            type: "EMOM",
            minutes: block.minutes || parseInt(text.match(/(\d+)\s*min/i)?.[1] || "20"),
            instructions: block.instructions || [{ name: "Work" }]
          };
        }
        if (block.type === "TABATA") {
          return {
            type: "TABATA",
            rounds: block.rounds || 8,
            work_seconds: block.work_seconds || 20,
            rest_seconds: block.rest_seconds || 10,
            exercise: block.exercise || "Mixed"
          };
        }
        if (block.type === "CIRCUIT") {
          return {
            type: "CIRCUIT",
            rounds: block.rounds || block.sets || 5,
            exercises: block.exercises || block.sequence || [{ name: "Work", seconds: 30 }],
            rest_between_rounds_seconds: block.rest_between_rounds_seconds || block.rest_seconds || 0
          };
        }
        if (block.type === "INTERVAL") {
          if (block.sequence && block.sequence.length > 0) {
            return {
              type: "INTERVAL",
              work_seconds: block.work_seconds || block.sequence[0]?.seconds || 20,
              rest_seconds: block.rest_seconds || 0,
              sets: block.sets || block.rounds || 1,
              sequence: block.sequence
            };
          } else {
            return {
              type: "INTERVAL",
              work_seconds: block.work_seconds || 30,
              rest_seconds: block.rest_seconds || 15,
              sets: block.sets || block.rounds || 1
            };
          }
        }
        return block;
      });
      
      return {
        ...ai,
        blocks: validBlocks,
        total_minutes: ai.total_minutes || Math.ceil(validBlocks.reduce((total, block) => {
          if (block.type === "EMOM") return total + block.minutes;
          if (block.type === "TABATA") return total + Math.ceil((block.rounds * (block.work_seconds + block.rest_seconds)) / 60);
          if (block.type === "CIRCUIT") return total + Math.ceil((block.rounds * block.exercises.reduce((sum, ex) => sum + (ex.seconds || 30), 0) + (block.rounds - 1) * block.rest_between_rounds_seconds) / 60);
          if (block.type === "INTERVAL") {
            if (block.sequence) {
              const roundTime = block.sequence.reduce((sum, step) => sum + step.seconds + (step.rest_after_seconds || 0), 0);
              return total + Math.ceil((block.sets * roundTime) / 60);
            } else {
              return total + Math.ceil((block.sets * (block.work_seconds + block.rest_seconds)) / 60);
            }
          }
          return total;
        }, 0))
      };
    }

    // Handle raw AI responses that don't match our schema
    if (ai && ai.type === "EMOM") {
      const minutes = ai.minutes || parseInt(text.match(/(\d+)\s*min/i)?.[1] || "20");
      const instructions = [];
      if (ai.instructions) {
        instructions.push(...ai.instructions);
      } else if (ai.sequence) {
        instructions.push(...ai.sequence.map(item => ({ name: item.name || "Work" })));
      } else {
        instructions.push({ name: "Work" });
      }
      
      return {
        title: ai.title || `${minutes}-min EMOM`,
        total_minutes: minutes,
        blocks: [{
          type: "EMOM",
          minutes,
          instructions
        }],
        cues: { start: true, last_round: true, halfway: minutes >= 10, tts: true },
        debug: { used_ai: true, inferred_mode: "EMOM", notes: "normalized from raw AI" }
      };
    }

    if (ai && ai.type === "TABATA") {
      const rounds = ai.rounds || ai.sets || 8;
      const work = ai.work_seconds || ai.work || 20;
      const rest = ai.rest_seconds || ai.rest || 10;
      
      return {
        title: ai.title || `Tabata ${rounds}x${work}/${rest}`,
        total_minutes: Math.ceil((rounds * (work + rest)) / 60),
        blocks: [{
          type: "TABATA",
          rounds,
          work_seconds: work,
          rest_seconds: rest,
          exercise: ai.exercise || "Mixed"
        }],
        cues: { start: true, last_round: true, halfway: rounds >= 8, tts: true },
        debug: { used_ai: true, inferred_mode: "TABATA", notes: "normalized from raw AI" }
      };
    }

    if (ai && ai.type === "CIRCUIT") {
      const rounds = ai.rounds || ai.sets || 5;
      const exercises = ai.exercises || ai.sequence || [{ name: "Work", seconds: 30 }];
      const restBetween = ai.rest_between_rounds_seconds || ai.rest_seconds || 0;
      
      return {
        title: ai.title || `Circuit ${rounds} rounds`,
        total_minutes: Math.ceil((rounds * exercises.reduce((sum, ex) => sum + (ex.seconds || 30), 0) + (rounds - 1) * restBetween) / 60),
        blocks: [{
          type: "CIRCUIT",
          rounds,
          exercises,
          rest_between_rounds_seconds: restBetween
        }],
        cues: { start: true, last_round: true, halfway: rounds >= 8, tts: true },
        debug: { used_ai: true, inferred_mode: "CIRCUIT", notes: "normalized from raw AI" }
      };
    }

    if (ai && ai.type === "INTERVAL") {
      const sets = ai.sets || ai.rounds || 1;
      const work = ai.work_seconds || ai.work || 30;
      const rest = ai.rest_seconds || ai.rest || 15;
      
      if (ai.sequence && ai.sequence.length > 0) {
        const sequence = analyzeAndFixSequence(ai.sequence, text);
        return {
          title: ai.title || `Interval ${sets} sets`,
          total_minutes: Math.ceil((sets * sequence.reduce((sum, step) => sum + step.seconds + (step.rest_after_seconds || 0), 0)) / 60),
          blocks: [{
            type: "INTERVAL",
            work_seconds: work,
            rest_seconds: 0,
            sets,
            sequence
          }],
          cues: { start: true, last_round: true, halfway: sets >= 8, tts: true },
          debug: { used_ai: true, inferred_mode: "INTERVAL(sequence)", notes: "normalized from raw AI" }
        };
      } else {
        return {
          title: ai.title || `${sets}x${work}/${rest} Intervals`,
          total_minutes: Math.ceil((sets * (work + rest)) / 60),
          blocks: [{
            type: "INTERVAL",
            work_seconds: work,
            rest_seconds: rest,
            sets
          }],
          cues: { start: true, last_round: true, halfway: sets >= 10, tts: true },
          debug: { used_ai: true, inferred_mode: "INTERVAL", notes: "normalized from raw AI" }
        };
      }
    }

    // If we get here, try to infer from text
    if (/(\bEMOM\b|every\s+minute)/i.test(text)) {
      const minutes = parseInt(text.match(/(\d+)\s*min/i)?.[1] || "20");
      const instructions = [];
      const odd = text.match(/odd[^a-z0-9]+([^.;\n]+)/i)?.[1]?.trim();
      const even = text.match(/even[^a-z0-9]+([^.;\n]+)/i)?.[1]?.trim();
      if (odd) instructions.push({ minute_mod: "odd", name: odd });
      if (even) instructions.push({ minute_mod: "even", name: even });
      if (!instructions.length) instructions.push({ name: "Work" });
      
      return {
        title: `${minutes}-min EMOM Workout`,
        total_minutes: minutes,
        blocks: [{
          type: "EMOM",
          minutes,
          instructions
        }],
        cues: { start: true, last_round: true, halfway: minutes >= 10, tts: true },
        debug: { used_ai: true, inferred_mode: "EMOM", notes: "coerced from text" }
      };
    }

    if (/\btabata\b/i.test(text)) {
      const rounds = parseInt(text.match(/(\d+)\s*rounds?/i)?.[1] || "8");
      const work = parseInt(text.match(/(\d+)\s*s(?:ec)?\s*work/i)?.[1] || "20");
      const rest = parseInt(text.match(/(\d+)\s*s(?:ec)?\s*rest/i)?.[1] || "10");
      
      return {
        title: `Tabata ${rounds}x${work}/${rest}`,
        total_minutes: Math.ceil((rounds * (work + rest)) / 60),
        blocks: [{
          type: "TABATA",
          rounds,
          work_seconds: work,
          rest_seconds: rest,
          exercise: "Mixed"
        }],
        cues: { start: true, last_round: true, halfway: rounds >= 8, tts: true },
        debug: { used_ai: true, inferred_mode: "TABATA", notes: "coerced from text" }
      };
    }

    throw new Error("Unrecognized AI response format");
  } catch (error) {
    console.error("Normalization failed:", error);
    return null;
  }
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
