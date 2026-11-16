# Yrols: note per Claude Code

- Database: progetto Supabase "Demo IPA" (ref `exchjppslwhbnbzuhfqs`), condiviso con altre demo. Lavora **solo** sullo schema `yrols`, non toccare gli altri schemi.
- Il server MCP Supabase in `.mcp.json` è in **sola lettura**: il database contiene dati bancari reali. Le modifiche allo schema vanno scritte come file in `supabase/migrations/` e passano da una PR.
- MCP GitHub: serve la variabile `GITHUB_MCP_TOKEN` (vedi `.envrc.example`). Mai committare token.
