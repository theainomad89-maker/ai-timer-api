import Fastify from "fastify";
import cors from "cors";
import OpenAI from "openai";

const app = Fastify();
// CORS (simple)
// @ts-ignore
app.use(cors());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM = `You convert messy workout descriptions into a strict JSON schema. Rules: Output ONLY JSON matching the schema. If ambiguous, infer safe defaults (15–30s rests, seconds if unit missing). Support EMOM, INTERVAL, CIRCUIT, TABATA. Include a title and total_minutes. Schema keys: title, total_minutes, blocks[], cues{start,halfway,last_round,tts}.`;

app.get("/health", async () => ({ ok: true }));

app.post("/generate", async (req, reply) => {
  const body = req.body || {};
  const text = body.text;
  if (!text) return reply.code(400).send({ ok: false, error: "Missing text" });

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4",
      temperature: 0.2,
      messages: [ 
        { role: "system", content: SYSTEM }, 
        { role: "user", content: `User workout description:\n${text}\nReturn valid JSON only.` } 
      ]
    });
    
    const raw = resp.choices?.[0]?.message?.content || "";
    try {
      const json = JSON.parse(raw);
      return reply.send({ ok: true, data: json });
    } catch {
      return reply.code(400).send({ ok: false, error: "Parse/validation failed", raw });
    }
  } catch (error) {
    console.error("OpenAI error:", error);
    return reply.code(500).send({ ok: false, error: "OpenAI API error: " + error.message });
  }
});

const port = Number(process.env.PORT) || 8080;
app.listen({ port, host: "0.0.0.0" }).then(()=> console.log("API up on", port));
