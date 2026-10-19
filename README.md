# Stranger Sky - Server (Lumen API)

Express API + Socket.IO sky server.

## Setup
1. Create a Supabase project and run `supabase/schema.sql` in the SQL Editor.
2. Copy `.env.example` to `.env` and fill in the values:
   - `SUPABASE_URL`
   - `SUPABASE_SECRET_KEY`
   - `SETTINGS_ENCRYPTION_KEY`
   - `ADMIN_EMAILS`
   - `WEB_ORIGIN`
   - `ADMIN_ORIGIN`
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the server:
   ```bash
   npm start
   ```

## Deploy on Render
Use `render.yaml` or create a Web Service with:
- **Build Command:** `npm install --omit=dev`
- **Start Command:** `node index.js`
- **Health Check Path:** `/healthz`
