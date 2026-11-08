# SpacetimeDB module

Use TypeScript and the pinned spacetimedb 2.14.1 SDK. The default schema export and named reducer exports in src/index.ts are the module entry point.

- All writes go through transactional reducers. Use ctx.timestamp and ctx.sender for server time and authenticated provenance.
- Historical observations are private and insert-only. Never add update/delete paths for them.
- Only SIMULATOR sources are authorized in Feature 1. Do not add physical or infrastructure integrations.
- Keep recent_observation bounded to 50 rows per rack, with fair eviction across (metric, source) groups (`fairEvictions`); do not subscribe dashboard clients to the immutable archive.
- Only authorized agent identities (`agent_authorization`) may call complete_investigation. Browsers may start, attach image provenance, or abandon their own run. Never let a client write a report.
- Schema changes must be additive (new tables) so existing databases migrate without data loss.
- Advance current values only for strictly newer observation timestamps. Evaluate alerts against current values.
- Run root npm test, npm run typecheck, npm run db:build, and the isolated integration/browser checks before merging.
