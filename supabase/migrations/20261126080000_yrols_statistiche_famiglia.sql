-- Statistiche: nuova tipologia "famiglia" (Spesa Famiglia: spese di un conto, per categoria, con consigli).
--   famiglia → { "accountId": "<conto>", "months": 12, "places": { ... }, "advice": [ { "title", "text", "saving" } ] }
alter table yrols.custom_stats drop constraint if exists custom_stats_kind_check;
alter table yrols.custom_stats add constraint custom_stats_kind_check check (kind in ('vacanza', 'famiglia'));
