# AI Timer API

Backend server for the AI Workout Timer mobile app. Converts workout descriptions to structured JSON using OpenAI.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set environment variables:
```bash
export OPENAI_API_KEY=your_openai_api_key_here
export PORT=8080  # optional, defaults to 8080
```

3. Run the server:
```bash
# Development (with auto-restart)
npm run dev

# Production
npm start
```

## Endpoints

- `GET /health` - Health check
- `POST /generate` - Convert workout text to JSON
  - Body: `{ "text": "workout description" }`
  - Returns: `{ "ok": true, "data": workout_json }`

## Railway Deployment

1. Create new Railway project
2. Connect GitHub repo
3. Set environment variable: `OPENAI_API_KEY`
4. Deploy will automatically expose port 8080

## Example Response

```json
{
  "ok": true,
  "data": {
    "title": "20-Minute EMOM",
    "total_minutes": 20,
    "blocks": [
      {
        "type": "EMOM",
        "minutes": 20,
        "instructions": [
          {
            "minute_mod": "odd",
            "name": "12 Burpees"
          },
          {
            "minute_mod": "even", 
            "name": "45s Plank"
          }
        ]
      }
    ],
    "cues": {
      "start": true,
      "halfway": false,
      "last_round": true,
      "tts": true
    }
  }
}
```
