# Yrols: note per Claude Code

- Database: progetto Supabase "Demo IPA" (ref `exchjppslwhbnbzuhfqs`), condiviso con altre demo. Lavora **solo** sullo schema `yrols`, non toccare gli altri schemi.
- Il server MCP Supabase in `.mcp.json` può scrivere, ma il database contiene dati bancari reali: prima di applicare una migrazione salvala anche come file in `supabase/migrations/` e mostra a Loris cosa cambia. Mai `delete`/`truncate`/`drop` su dati senza conferma esplicita.
- MCP Supabase: usa la variabile `SUPABASE_ACCESS_TOKEN` dell'ambiente cloud di Claude Code. Mai committare token. GitHub è già collegato dalle sessioni online.
